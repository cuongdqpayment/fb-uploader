// ============================================================
//  FB Video Uploader — Main Process (Electron)
//  Handles: window, IPC, Puppeteer automation, Google Sheets,
//  file system, cron scheduling.
// ============================================================

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const Store = require('electron-store')
const cron = require('node-cron')
const { google } = require('googleapis')
const puppeteer = require('puppeteer-core')
const fs = require('fs')

// ─── Persistent config store ────────────────────────────────
const store = new Store({
  defaults: {
    sheetId: '',
    sheetTab: 'Facebook Queue',
    serviceAccountPath: '',
    chromePath: '',
    scheduleEnabled: false,
    scheduleCron: '*/15 * * * *',  // every 15 min
    delayBetween: 15,              // seconds
    facebookPageUrl: '',
    headless: false,
  }
})

// ─── State ───────────────────────────────────────────────────
let mainWindow = null
let browser = null
let cronJob = null
let isRunning = false

// ─── Window ──────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
  })

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (!mainWindow) createWindow() })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  if (browser) await browser.close().catch(() => {})
  if (cronJob) cronJob.destroy()
})

// ─── Helper: send log to renderer ───────────────────────────
function sendLog(message, type = 'info') {
  if (mainWindow) {
    mainWindow.webContents.send('log', { message, type, time: new Date().toISOString() })
  }
  console.log(`[${type.toUpperCase()}] ${message}`)
}

function sendStatus(status) {
  if (mainWindow) mainWindow.webContents.send('status', status)
}

// ─── IPC: Config ─────────────────────────────────────────────
ipcMain.handle('config:get', () => store.store)
ipcMain.handle('config:set', (_, data) => { store.set(data); return true })

ipcMain.handle('dialog:openFile', async (_, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  })
  return result.filePaths[0] || null
})

ipcMain.handle('dialog:openDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  })
  return result.filePaths[0] || null
})

ipcMain.handle('shell:openExternal', (_, url) => shell.openExternal(url))

// ─── IPC: Google Sheets ──────────────────────────────────────
ipcMain.handle('sheets:test', async () => {
  try {
    const rows = await fetchPendingRows()
    return { ok: true, count: rows.length }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('sheets:fetch', async () => {
  try {
    const rows = await fetchPendingRows()
    return { ok: true, rows }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

async function getSheetsClient() {
  const keyPath = store.get('serviceAccountPath')
  if (!keyPath || !fs.existsSync(keyPath)) {
    throw new Error('Service Account JSON chưa được chọn hoặc không tìm thấy file.')
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

async function fetchPendingRows() {
  const sheets = await getSheetsClient()
  const sheetId = store.get('sheetId')
  const tab = store.get('sheetTab')

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tab}!A:G`,
  })

  const rows = res.data.values || []
  if (rows.length < 2) return []

  const header = rows[0] // [seq, file_name, file_path, scheduled_at, caption, description, status, fb_video_id]
  return rows.slice(1).map((row, idx) => ({
    rowIndex: idx + 2,
    seq:          row[0] || '',
    file_name:    row[1] || '',
    file_path:    row[2] || '',
    scheduled_at: row[3] || '',
    caption:      row[4] || '',
    description:  row[5] || '',
    status:       row[6] || 'pending',
    fb_video_id:  row[7] || '',
  })).filter(r => r.status === 'pending' && r.file_name)
}

async function updateRowStatus(rowIndex, status, fbVideoId = '') {
  const sheets = await getSheetsClient()
  const sheetId = store.get('sheetId')
  const tab = store.get('sheetTab')

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tab}!G${rowIndex}:H${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[status, fbVideoId]] },
  })
}

// ─── IPC: Scheduler ──────────────────────────────────────────
ipcMain.handle('scheduler:start', () => {
  const cronExpr = store.get('scheduleCron')
  if (cronJob) cronJob.destroy()
  cronJob = cron.schedule(cronExpr, () => {
    if (!isRunning) runUploadQueue()
  })
  sendLog(`Scheduler started: ${cronExpr}`, 'ok')
  return { ok: true }
})

ipcMain.handle('scheduler:stop', () => {
  if (cronJob) { cronJob.destroy(); cronJob = null }
  sendLog('Scheduler stopped', 'warn')
  return { ok: true }
})

// ─── IPC: Manual run ─────────────────────────────────────────
ipcMain.handle('upload:runNow', async () => {
  if (isRunning) return { ok: false, error: 'Đang chạy rồi' }
  runUploadQueue(true) // force=true: bỏ qua check giờ
  return { ok: true }
})

ipcMain.handle('upload:stop', async () => {
  isRunning = false
  if (browser) {
    await browser.close().catch(() => {})
    browser = null
  }
  sendStatus('idle')
  sendLog('Đã dừng upload', 'warn')
  return { ok: true }
})

// ─── Core: Upload queue ──────────────────────────────────────
async function runUploadQueue(force = false) {
  if (isRunning) return
  isRunning = true
  sendStatus('running')
  sendLog('Bắt đầu quét Google Sheet...', 'info')

  try {
    const rows = await fetchPendingRows()
    if (rows.length === 0) {
      sendLog('Không có video pending nào.', 'info')
      isRunning = false
      sendStatus('idle')
      return
    }

    sendLog(`Tìm thấy ${rows.length} video cần upload.`, 'ok')

    const now = new Date()
    const due = rows.filter(r => {
      if (force) return true
      if (!r.scheduled_at) return true
      const t = new Date(r.scheduled_at.replace(' ', 'T') + '+07:00')
      return t <= now
    })

    if (due.length === 0) {
      sendLog('Chưa đến giờ đăng. Dùng "Chạy ngay" để bỏ qua check giờ.', 'info')
      isRunning = false
      sendStatus('idle')
      return
    }

    sendLog(`${due.length} video sẽ được upload.`, 'ok')

    // Khởi động browser
    browser = await launchBrowser()
    sendLog('Đã mở Chrome browser.', 'ok')

    for (const row of due) {
      if (!isRunning) break

      sendLog(`Đang xử lý: ${row.file_name}`, 'info')
      mainWindow?.webContents.send('row:processing', row.rowIndex)

      try {
        const fbVideoId = await uploadVideoToFacebook(browser, row)
        await updateRowStatus(row.rowIndex, 'posted', fbVideoId)
        sendLog(`✓ Đã đăng: ${row.file_name} (ID: ${fbVideoId})`, 'ok')
        mainWindow?.webContents.send('row:done', { rowIndex: row.rowIndex, fbVideoId })
      } catch (e) {
        await updateRowStatus(row.rowIndex, 'error')
        sendLog(`✗ Lỗi ${row.file_name}: ${e.message}`, 'error')
        sendLog('Chrome vẫn mở — anh có thể kiểm tra thủ công', 'warn')
        mainWindow?.webContents.send('row:error', { rowIndex: row.rowIndex, error: e.message })
      }

      // Delay giữa các video
      if (isRunning && due.indexOf(row) < due.length - 1) {
        const delay = (store.get('delayBetween') || 15) * 1000
        sendLog(`Nghỉ ${delay / 1000}s...`, 'info')
        await sleep(delay)
      }
    }

    // KHÔNG đóng Chrome — giữ mở để anh kiểm tra
    sendLog('Chrome vẫn mở — kiểm tra kết quả trên Facebook', 'info')
  } catch (e) {
    sendLog(`Lỗi nghiêm trọng: ${e.message}`, 'error')
  }

  isRunning = false
  sendStatus('idle')
  sendLog('Hoàn tất hàng đợi.', 'ok')
}

// ─── Puppeteer: Launch browser ───────────────────────────────
async function launchBrowser() {
  // Thử connect vào Chrome đang chạy trước
  try {
    const browser = await puppeteer.connect({
      browserURL: 'http://localhost:9222',
      defaultViewport: null,
    })
    sendLog('Đã kết nối vào Chrome đang chạy ✓', 'ok')
    return browser
  } catch (_) {
    // Không có Chrome đang chạy → mở mới
    sendLog('Không thấy Chrome đang chạy, mở Chrome mới...', 'warn')
    const execPath = store.get('chromePath') || findChrome()
    return await puppeteer.launch({
      executablePath: execPath,
      headless: false,
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    })
  }
}

// Tìm Chrome mặc định theo OS
function findChrome() {
  const candidates = {
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
  }
  const list = candidates[process.platform] || []
  return list.find(p => fs.existsSync(p)) || 'google-chrome'
}

// ─── Puppeteer: Upload video to Facebook Reels ───────────────
async function uploadVideoToFacebook(browser, row) {
  const pageUrl = store.get('facebookPageUrl')
  if (!pageUrl) throw new Error('Chưa cấu hình Facebook Page URL')

  // Dùng tab Facebook đang mở (đã login) hoặc mở tab mới
  const pages = await browser.pages()
  let page = pages.find(p => p.url().includes('facebook.com')) || null
  if (!page) {
    page = await browser.newPage()
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      window.chrome = { runtime: {} }
    })
  }

  // ── Bước 1: Mở tab Reels của Page ──
  const reelsUrl = pageUrl.includes('?')
    ? `${pageUrl}&sk=reels_tab`
    : `${pageUrl}?sk=reels_tab`

  sendLog(`Mở trang Reels: ${reelsUrl}`, 'info')
  await page.goto(reelsUrl, { waitUntil: 'networkidle2', timeout: 60000 })
  await sleep(3000)

  // ── Bước 2: Click nút "Tạo thước phim" ──
  sendLog('Tìm nút "Tạo thước phim"...', 'info')
  const clickedCreate = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('span')]
    const span = spans.find(el => el.textContent.trim() === 'Tạo thước phim')
    if (!span) return false
    let el = span
    for (let i = 0; i < 8; i++) {
      if (!el.parentElement) break
      el = el.parentElement
      const tag = el.tagName.toLowerCase()
      const role = el.getAttribute('role')
      if (tag === 'a' || tag === 'button' || role === 'button') {
        el.click()
        return true
      }
    }
    span.click()
    return true
  })
  if (!clickedCreate) throw new Error('Không tìm thấy nút "Tạo thước phim"')
  sendLog('Đã click "Tạo thước phim" ✓', 'ok')
  await sleep(4000)

  // ── Bước 3: Click nút "Tải lên" trong dialog ──
  sendLog('Tìm nút "Tải lên"...', 'info')
  await page.evaluate(() => {
    const spans = [...document.querySelectorAll('span')]
    const span = spans.find(el => {
      const t = el.textContent.trim()
      return t === 'Tải lên' || t === 'Thêm video' || t === 'Upload'
    })
    if (!span) return false
    let el = span
    for (let i = 0; i < 8; i++) {
      if (!el.parentElement) break
      el = el.parentElement
      const tag = el.tagName.toLowerCase()
      const role = el.getAttribute('role')
      if (tag === 'a' || tag === 'button' || role === 'button') {
        el.click()
        return true
      }
    }
    span.click()
    return true
  })
  sendLog('Đã click "Tải lên" ✓', 'ok')
  await sleep(2000)

  // ── Bước 4: Upload file video qua input[type="file"] ──
  sendLog(`Upload file: ${row.file_name}`, 'info')
  const filePath = resolveFilePath(row.file_name)
  if (!fs.existsSync(filePath)) {
    throw new Error(`File không tồn tại: ${filePath}`)
  }

  // Chờ input file xuất hiện
  await page.waitForFunction(
    () => document.querySelectorAll('input[type="file"]').length > 0,
    { timeout: 15000 }
  ).catch(() => sendLog('Không thấy input file, thử tiếp...', 'warn'))

  // Tìm input file — ưu tiên accept video
  const fileInputEl = await page.evaluateHandle(() => {
    const inputs = [...document.querySelectorAll('input[type="file"]')]
    return inputs.find(i => {
      const accept = i.getAttribute('accept') || ''
      return accept.includes('video') || accept.includes('mp4')
    }) || inputs[0] || null
  }).then(h => h.asElement ? h.asElement() : null)

  if (!fileInputEl) throw new Error('Không tìm thấy input file. Thử mở dialog thủ công.')

  await fileInputEl.uploadFile(filePath)
  sendLog('Đã chọn file ✓ — Facebook đang nhận file...', 'info')

  // ── Bước 5: Đóng file picker bằng Escape ──
  await sleep(DELAY.afterFileSelect)
  sendLog('Đóng cửa sổ chọn file (Escape)...', 'info')
  await page.keyboard.press('Escape')
  await sleep(DELAY.afterEscape)

  // ── Bước 6: Chờ Facebook xác nhận "an toàn để đăng" ──
  sendLog('Chờ Facebook upload + quét bản quyền...', 'info')
  await waitForSafeToPost(page)
  sendLog('"Thước phim của bạn an toàn để đăng!" ✓', 'ok')

  // Delay tự nhiên trước khi click — giống người dùng đọc xong mới bấm
  await humanDelay(DELAY.beforeNext1Min, DELAY.beforeNext1Max)
  sendLog('Click "Tiếp" bước 1...', 'info')
  await clickButtonByText(page, ['Tiếp', 'Next'])
  await sleep(DELAY.afterNext1)

  // ── Bước 7: Click "Tiếp" lần 2 (bỏ qua màn chỉnh sửa) ──
  // Chờ màn chỉnh sửa load xong
  await waitForNextButtonActive(page)
  await humanDelay(DELAY.beforeNext2Min, DELAY.beforeNext2Max)
  sendLog('Click "Tiếp" bước 2 (bỏ qua chỉnh sửa)...', 'info')
  await clickButtonByText(page, ['Tiếp', 'Next'])
  await sleep(DELAY.afterNext2)

  // ── Bước 8: Điền mô tả (từ cột description trong Google Sheet) ──
  await sleep(DELAY.beforeDescription)
  if (row.description) {
    sendLog('Điền mô tả thước phim...', 'info')
    const filled = await page.evaluate((text) => {
      // Tìm textarea hoặc contenteditable placeholder "Mô tả..."
      const allTargets = [
        ...document.querySelectorAll('textarea'),
        ...document.querySelectorAll('[contenteditable="true"]'),
      ]
      const box = allTargets.find(el => {
        const r = el.getBoundingClientRect()
        const ph = el.getAttribute('placeholder') || ''
        return r.width > 50 && r.height > 20 && (
          ph.includes('tả') || ph.includes('Mô') || ph.includes('mô') || true
        )
      })
      if (!box) return false
      box.focus()
      if (box.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(box, text)
        box.dispatchEvent(new Event('input', { bubbles: true }))
        box.dispatchEvent(new Event('change', { bubbles: true }))
      } else {
        document.execCommand('selectAll', false, null)
        document.execCommand('delete', false, null)
        document.execCommand('insertText', false, text)
        box.dispatchEvent(new InputEvent('input', {
          bubbles: true, data: text, inputType: 'insertText'
        }))
      }
      return true
    }, row.description)

    if (filled) {
      sendLog('Đã điền mô tả ✓', 'ok')
    } else {
      sendLog('Không tìm thấy ô mô tả, bỏ qua...', 'warn')
    }
    await sleep(DELAY.afterDescription)
  }

  // ── Bước 9: Click "Đăng" ──
  await humanDelay(DELAY.beforePublishMin, DELAY.beforePublishMax)
  sendLog('Tìm nút "Đăng" để đăng Reels...', 'info')

  // Chờ nút "Đăng" xuất hiện và active
  await waitForButtonActive(page, ['Đăng', 'Publish', 'Share'])
  await humanDelay(500, 1500) // delay nhỏ thêm trước khi click
  const published = await clickButtonByText(page, ['Đăng', 'Publish', 'Share'])

  if (!published) {
    sendLog('Không tìm thấy nút "Đăng" — kiểm tra Chrome thủ công', 'warn')
  }

  await sleep(DELAY.afterPublish)

  // Lấy video ID
  const finalUrl = page.url()
  const match = finalUrl.match(/\/(\d{10,})/)
  const videoId = match ? match[1] : `fb_${Date.now()}`

  sendLog('✓ Đã đăng Reels! Tab Facebook vẫn mở để kiểm tra.', 'ok')
  return videoId
}

// ─── DELAY CONFIG (ms) — điều chỉnh ở đây nếu cần ──────────
const DELAY = {
  afterFileSelect:   30000, // sau khi chọn file, trước khi bấm Escape
  afterEscape:       3000,  // sau Escape, trước khi chờ upload
  beforeNext1Min:    2000,  // delay tối thiểu trước "Tiếp" lần 1
  beforeNext1Max:    4500,  // delay tối đa trước "Tiếp" lần 1
  afterNext1:        4500,  // sau "Tiếp" lần 1, chờ màn chỉnh sửa load
  beforeNext2Min:    2500,  // delay tối thiểu trước "Tiếp" lần 2
  beforeNext2Max:    5000,  // delay tối đa trước "Tiếp" lần 2
  afterNext2:        5000,  // sau "Tiếp" lần 2, chờ màn cài đặt load
  beforeDescription: 5000,  // trước khi điền mô tả
  afterDescription:  5000,  // sau khi điền mô tả
  beforePublishMin:  3500,  // delay tối thiểu trước "Đăng"
  beforePublishMax:  5000,  // delay tối đa trước "Đăng"
  afterPublish:      6000,  // sau khi bấm "Đăng", chờ Facebook xử lý
}

// ─── Helper: delay ngẫu nhiên giống người dùng thật ─────────
function humanDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs)
  return sleep(Math.round(ms))
}

// ─── Helper: click nút theo text ────────────────────────────
async function clickButtonByText(page, texts) {
  const clicked = await page.evaluate((texts) => {
    const allEls = [...document.querySelectorAll('span, div, button, a')]
    for (const text of texts) {
      const found = allEls.find(el => el.textContent.trim() === text)
      if (!found) continue
      let el = found
      for (let i = 0; i < 8; i++) {
        const tag = el.tagName.toLowerCase()
        const role = el.getAttribute('role')
        const isDisabled = el.disabled || el.getAttribute('aria-disabled') === 'true'
        if ((tag === 'button' || role === 'button') && !isDisabled) {
          el.click()
          return text
        }
        if (!el.parentElement) break
        el = el.parentElement
      }
      // Fallback click span trực tiếp
      found.click()
      return text
    }
    return null
  }, texts)

  if (clicked) {
    sendLog(`Đã click "${clicked}" ✓`, 'ok')
  } else {
    sendLog(`Không tìm thấy nút [${texts.join('/')}], bỏ qua...`, 'warn')
  }
  return clicked
}

// ─── Helper: chờ Facebook xác nhận "an toàn để đăng" ────────
// Chờ text "Thước phim của bạn an toàn để đăng!" xuất hiện
// — đây là tín hiệu chính xác nhất: upload xong + quét bản quyền xong
async function waitForSafeToPost(page, timeout = 600000) {
  const start = Date.now()
  let lastLog = 0

  // Các text Facebook có thể hiện (tiếng Việt + tiếng Anh fallback)
  const SAFE_MESSAGES = [
    'Thước phim của bạn an toàn để đăng!',
    'Your reel is safe to post!',
    'an toàn để đăng',
    'safe to post',
  ]

  // Các text báo đang xử lý (để log tiến trình)
  const PROCESSING_MESSAGES = [
    'Đang tải lên',
    'Đang xử lý',
    'Uploading',
    'Processing',
    'Đang kiểm tra',
    'Checking',
  ]

  sendLog('Đang chờ Facebook xác nhận an toàn đăng...', 'info')

  while (Date.now() - start < timeout) {
    const result = await page.evaluate((safeMsgs, processMsgs) => {
      const allText = document.body.innerText || ''

      // Kiểm tra thông báo an toàn
      for (const msg of safeMsgs) {
        if (allText.includes(msg)) return { status: 'safe', msg }
      }

      // Kiểm tra đang xử lý
      for (const msg of processMsgs) {
        if (allText.includes(msg)) return { status: 'processing', msg }
      }

      return { status: 'waiting' }
    }, SAFE_MESSAGES, PROCESSING_MESSAGES)

    if (result.status === 'safe') {
      sendLog(`Facebook xác nhận: "${result.msg}" ✓`, 'ok')
      return true
    }

    const elapsed = Math.round((Date.now() - start) / 1000)
    if (elapsed - lastLog >= 10) {
      lastLog = elapsed
      if (result.status === 'processing') {
        sendLog(`[${elapsed}s] Facebook đang xử lý: "${result.msg}"...`, 'info')
      } else {
        sendLog(`[${elapsed}s] Chờ Facebook upload + quét bản quyền...`, 'info')
      }
    }

    await sleep(2000)
  }

  throw new Error('Timeout 10 phút: Facebook chưa xác nhận an toàn đăng')
}

// ─── Helper: chờ nút bất kỳ active ──────────────────────────
async function waitForButtonActive(page, texts, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const found = await page.evaluate((texts) => {
      const allEls = [...document.querySelectorAll('span, button, div[role="button"]')]
      for (const text of texts) {
        const el = allEls.find(e => e.textContent.trim() === text)
        if (el) return true
      }
      return false
    }, texts)
    if (found) return true
    await sleep(1000)
  }
  sendLog(`Nút [${texts.join('/')}] không xuất hiện sau ${timeout/1000}s`, 'warn')
}

// ─── Puppeteer helpers ───────────────────────────────────────

async function findElement(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel)
      if (el) return el
    } catch (_) {}
  }
  // Fallback: tìm theo text
  return null
}

async function waitForUpload(page, timeout = 300000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const hasProgress = await page.$('[role="progressbar"]')
    if (!hasProgress) {
      await sleep(2000)
      return true
    }
    await sleep(2000)
  }
  throw new Error('Upload video timeout')
}

async function fillCaption(page, caption) {
  // Tìm ô contenteditable lớn nhất (ô caption)
  await page.evaluate((text) => {
    const boxes = [...document.querySelectorAll('[contenteditable="true"]')]
      .filter(el => {
        const r = el.getBoundingClientRect()
        return r.width > 100 && r.height > 30
      })
      .sort((a, b) => {
        const ra = a.getBoundingClientRect()
        const rb = b.getBoundingClientRect()
        return (rb.width * rb.height) - (ra.width * ra.height)
      })

    if (boxes.length === 0) return

    const box = boxes[0]
    box.focus()
    document.execCommand('selectAll', false, null)
    document.execCommand('insertText', false, text)
    box.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
  }, caption)

  await sleep(500)
}

async function setSchedule(page, scheduledAt) {
  // Tìm nút "..." hoặc "More options" để mở schedule
  const moreBtn = await page.evaluateHandle(() => {
    const buttons = [...document.querySelectorAll('[role="button"], button')]
    return buttons.find(b => {
      const text = (b.getAttribute('aria-label') || b.textContent || '').toLowerCase()
      return text.includes('more') || text.includes('schedule') || text.includes('option') || text === '...'
    }) || null
  })

  if (moreBtn.asElement()) {
    await moreBtn.asElement().click()
    await sleep(1500)
  }

  // Tìm option "Schedule"
  const scheduleOption = await page.evaluateHandle(() => {
    const items = [...document.querySelectorAll('[role="menuitem"], [role="option"], div[tabindex]')]
    return items.find(el => {
      const text = (el.textContent || '').toLowerCase()
      return text.includes('schedule') || text.includes('lên lịch')
    }) || null
  })

  if (scheduleOption.asElement()) {
    await scheduleOption.asElement().click()
    await sleep(1500)
  }

  // Parse datetime
  const dt = new Date(scheduledAt.replace(' ', 'T') + '+07:00')
  const dateStr = dt.toISOString().split('T')[0]
  const hours = String(dt.getHours()).padStart(2, '0')
  const minutes = String(dt.getMinutes()).padStart(2, '0')

  // Điền date input
  const dateInput = await page.$('input[type="date"]')
  if (dateInput) {
    await dateInput.evaluate((el, val) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }, dateStr)
  }

  // Điền time input
  const timeInput = await page.$('input[type="time"]')
  if (timeInput) {
    await timeInput.evaluate((el, val) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }, `${hours}:${minutes}`)
  }

  await sleep(500)

  // Confirm schedule
  const confirmBtn = await page.evaluateHandle(() => {
    const btns = [...document.querySelectorAll('[role="button"], button')]
    return btns.find(b => {
      const text = (b.getAttribute('aria-label') || b.textContent || '').toLowerCase()
      return text.includes('confirm') || text.includes('save') || text.includes('xác nhận')
    }) || null
  })

  if (confirmBtn.asElement()) {
    await confirmBtn.asElement().click()
    await sleep(1000)
  }
}

async function publish(page, isScheduled) {
  // Tìm nút publish/schedule
  const btn = await page.evaluateHandle(() => {
    const btns = [...document.querySelectorAll('[role="button"], button')]
    return btns.find(b => {
      const text = (b.getAttribute('aria-label') || b.textContent || '').toLowerCase()
      return text.includes('schedule future') ||
             text.includes('schedule post') ||
             text.includes('post') ||
             text.includes('đăng')
    }) || null
  })

  if (!btn.asElement()) throw new Error('Không tìm thấy nút Đăng')

  await btn.asElement().click()
  await sleep(5000)

  // Lấy video ID từ URL hoặc response
  const url = page.url()
  const match = url.match(/\/(\d+)/)
  return match ? match[1] : `fb_${Date.now()}`
}

// Resolve file path từ tên file
function resolveFilePath(fileName) {
  // Nếu đã là absolute path
  if (path.isAbsolute(fileName)) return fileName
  // Ghép với thư mục cấu hình nếu có
  const baseDir = store.get('videoBaseDir') || ''
  return baseDir ? path.join(baseDir, fileName) : fileName
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))