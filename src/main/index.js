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
    // Global settings
    serviceAccountPath: '',
    chromePath: '',
    chromeStartScript: '', // Script khởi động Chrome (VD: ~/start-fb-uploader.sh)
    scheduleCron: '*/15 * * * *',
    delayBetween: 15,
    headless: false,
    // Multi-channel: mảng các kênh
    channels: [
      {
        id: 'channel_1',
        name: 'Kênh 1',
        enabled: true,
        sheetId: '',
        sheetTab: 'upload_facebook',
        pageUrl: '',
        videoBaseDir: '',
      }
    ],
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
  if (cronJob) { try { cronJob.stop() } catch (_) {} }
})

// ─── Helper: send log to renderer (with timestamp) ──────────
function sendLog(message, type = 'info') {
  const ts = new Date().toLocaleTimeString('vi-VN', { hour12: false })
  const fullMsg = `[${ts}] ${message}`
  if (mainWindow) {
    mainWindow.webContents.send('log', { message: fullMsg, type, time: new Date().toISOString() })
  }
  console.log(`[${type.toUpperCase()}] ${fullMsg}`)
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

// ─── IPC: Google Sheets (multi-channel) ──────────────────────
ipcMain.handle('sheets:test', async (_, channelId) => {
  try {
    const channel = getChannel(channelId)
    const rows = await fetchPendingRowsForChannel(channel)
    return { ok: true, count: rows.length }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('sheets:fetch', async (_, channelId) => {
  try {
    const channel = getChannel(channelId)
    const rows = await fetchPendingRowsForChannel(channel)
    return { ok: true, rows }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('sheets:fetchAll', async () => {
  // Fetch tất cả channels cùng lúc
  const channels = store.get('channels') || []
  const results = {}
  for (const ch of channels) {
    if (!ch.enabled) continue
    try {
      const rows = await fetchPendingRowsForChannel(ch)
      results[ch.id] = { ok: true, rows }
    } catch (e) {
      results[ch.id] = { ok: false, error: e.message, rows: [] }
    }
  }
  return results
})

function getChannel(channelId) {
  const channels = store.get('channels') || []
  const ch = channelId
    ? channels.find(c => c.id === channelId)
    : channels[0]
  if (!ch) throw new Error(`Không tìm thấy channel: ${channelId}`)
  return ch
}

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

async function fetchPendingRowsForChannel(channel) {
  if (!channel.sheetId) throw new Error(`Channel "${channel.name}": chưa cấu hình Sheet ID`)
  const sheets = await getSheetsClient()

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: channel.sheetId,
    range: `${channel.sheetTab}!A:I`,
    // UNFORMATTED_VALUE trả về serial number cho datetime
    // tránh hoàn toàn vấn đề D/M vs M/D format
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  })

  const rows = res.data.values || []
  if (rows.length < 2) return []

  // Debug: log header + row đầu tiên để kiểm tra cấu trúc
  if (rows.length >= 1) {
    sendLog(`[${channel.name}] Header: [${rows[0].join(' | ')}]`, 'info')
  }
  if (rows.length >= 2) {
    sendLog(`[${channel.name}] Row 2: [${rows[1].join(' | ')}]`, 'info')
  }

  const mapped = rows.slice(1).map((row, idx) => ({
    rowIndex:     idx + 2,
    channelId:    channel.id,
    channelName:  channel.name,
    seq:          row[0] || '',
    file_name:    row[1] || '',
    file_path:    row[2] || '',
    scheduled_at: row[3] || '',
    caption:      row[4] || '',
    description:  row[5] || '',
    status:       row[6] || 'pending',
    fb_video_id:  row[7] || '',
  }))

  // Debug: log status của từng row
  mapped.forEach(r => {
    sendLog(`[${channel.name}] Row ${r.rowIndex}: file="${r.file_name}" scheduled="${r.scheduled_at}" status="${r.status}"`, 'info')
  })

  return mapped.filter(r => r.status === 'pending' && r.file_name)
}

async function updateRowStatusForChannel(channel, rowIndex, status, fbVideoId = '') {
  const sheets = await getSheetsClient()
  // Tạo link Reels nếu có ID thật (không phải UNKNOWN_xxx)
  const reelLink = fbVideoId && !fbVideoId.startsWith('UNKNOWN')
    ? `https://www.facebook.com/reel/${fbVideoId}`
    : ''

  await sheets.spreadsheets.values.update({
    spreadsheetId: channel.sheetId,
    // G = status, H = fb_video_id, I = reel_link
    range: `${channel.sheetTab}!G${rowIndex}:I${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[status, fbVideoId, reelLink]] },
  })
}

// ─── IPC: Scheduler ──────────────────────────────────────────
ipcMain.handle('scheduler:start', () => {
  const cronExpr = store.get('scheduleCron')
  // node-cron dùng .stop() không phải .destroy()
  if (cronJob) { try { cronJob.stop() } catch (_) {} }
  cronJob = cron.schedule(cronExpr, () => {
    // force=false: CHECK giờ scheduled_at, chỉ đăng khi đến giờ
    if (!isRunning) runUploadQueue(false)
  })
  sendLog(`Scheduler started: ${cronExpr} (check giờ đăng)`, 'ok')
  return { ok: true }
})

ipcMain.handle('scheduler:stop', () => {
  if (cronJob) {
    try { cronJob.stop() } catch (_) {}
    cronJob = null
  }
  sendLog('Scheduler stopped', 'warn')
  return { ok: true }
})

// ─── IPC: Manual run ─────────────────────────────────────────
ipcMain.handle('upload:runNow', async (_, channelId) => {
  // force=true: BỎ QUA check giờ, đăng ngay lập tức
  if (isRunning) return { ok: false, error: 'Đang chạy rồi' }
  runUploadQueue(true, channelId || null)
  return { ok: true }
})

ipcMain.handle('upload:runScheduled', async (_, channelId) => {
  // force=false: CHECK giờ scheduled_at — chỉ đăng khi đến giờ
  if (isRunning) return { ok: false, error: 'Đang chạy rồi' }
  sendLog('Chạy theo lịch — chỉ đăng video đến giờ...', 'info')
  runUploadQueue(false, channelId || null)
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

// ─── Helper: Parse scheduled_at từ nhiều format Google Sheets ─
// Sheet locale VN → trả về D/M/YYYY HH:MM:SS
// VD: '8/9/2026 4:30:00' = ngày 8, tháng 9
// Nếu dùng YYYY-MM-DD thì luôn đúng (khuyến nghị dùng format này trong Sheet)
function parseScheduledAt(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null

  // Format 1: YYYY-MM-DD (an toàn nhất, không ambiguous)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = new Date(s.replace(' ', 'T') + (s.includes('+') ? '' : '+07:00'))
    if (!isNaN(t)) return t
  }

  // Format 2: D/M/YYYY hoặc M/D/YYYY — Sheet locale VN dùng D/M/YYYY
  // Xử lý: luôn treat là D/M/YYYY (ngày/tháng) vì Sheet VN
  const dmyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (dmyMatch) {
    const [, d, m, y, hh = '0', mm = '0', ss = '0'] = dmyMatch
    const day = parseInt(d), month = parseInt(m)

    // Nếu d > 12 → chắc chắn D/M/YYYY → dùng bình thường
    // Nếu m > 12 → chắc chắn M/D/YYYY (US) → hoán đổi
    // Nếu cả 2 ≤ 12 → theo locale VN → D/M/YYYY
    let dayVal = day, monthVal = month
    if (day > 12 && month <= 12) {
      // D/M: giữ nguyên
      dayVal = day; monthVal = month
    } else if (month > 12 && day <= 12) {
      // M/D: hoán đổi
      dayVal = month; monthVal = day
    } else {
      // Ambiguous: theo locale VN = D/M
      dayVal = day; monthVal = month
    }

    const dateStr = `${y}-${String(monthVal).padStart(2,'0')}-${String(dayVal).padStart(2,'0')}T${String(hh).padStart(2,'0')}:${mm}:${ss}+07:00`
    const t = new Date(dateStr)
    if (!isNaN(t)) return t
  }

  // Fallback: JS tự parse
  const t = new Date(s)
  if (!isNaN(t)) return t

  return null
}

// ─── Core: Upload queue — xen kẽ đa kênh theo thời gian ─────
async function runUploadQueue(force = false, targetChannelId = null) {
  if (isRunning) return
  isRunning = true
  sendStatus('running')

  const channels = store.get('channels') || []
  const activeChannels = targetChannelId
    ? channels.filter(c => c.id === targetChannelId && c.enabled)
    : channels.filter(c => c.enabled)

  if (activeChannels.length === 0) {
    sendLog('Không có kênh nào được bật.', 'warn')
    isRunning = false
    sendStatus('idle')
    return
  }

  try {
    browser = await launchBrowser()
    sendLog('Đã kết nối Chrome ✓', 'ok')

    // ── Bước 1: Gom tất cả video pending từ mọi kênh ──
    sendLog('Quét tất cả kênh...', 'info')
    const allDue = []
    const now = new Date()

    for (const channel of activeChannels) {
      try {
        const rows = await fetchPendingRowsForChannel(channel)
        if (rows.length === 0) {
          sendLog(`[${channel.name}] Không có video pending.`, 'info')
          continue
        }

        const due = rows.filter(r => {
          if (force) return true
          if (!r.scheduled_at) return true
          const t = parseScheduledAt(r.scheduled_at)
          if (!t) {
            sendLog(`[${r.channelName}] ⚠ scheduled_at "${r.scheduled_at}" không parse được → chạy ngay`, 'warn')
            return true
          }
          return t <= now
        })

        if (due.length === 0) {
          // Log thêm thông tin để debug
          rows.forEach(r => {
            const t = parseScheduledAt(r.scheduled_at)
            sendLog(`[${channel.name}] ${r.file_name}: scheduled="${r.scheduled_at}" parsed=${t ? t.toLocaleString('vi-VN', {timeZone:'Asia/Ho_Chi_Minh'}) : 'INVALID'} due=${t ? t <= now : '?'}`, 'info')
          })
          sendLog(`[${channel.name}] ${rows.length} video chưa đến giờ — bỏ qua.`, 'info')
          continue
        }

        sendLog(`[${channel.name}] ${due.length}/${rows.length} video đến giờ.`, 'ok')

        // Gắn channel vào mỗi row để dùng sau
        due.forEach(r => allDue.push({ ...r, _channel: channel }))

      } catch (e) {
        sendLog(`[${channel.name}] Lỗi đọc Sheet: ${e.message}`, 'error')
      }
    }

    if (allDue.length === 0) {
      sendLog('Không có video nào đến giờ đăng.', 'info')
      isRunning = false
      sendStatus('idle')
      return
    }

    // ── Bước 2: Sort theo scheduled_at tăng dần (cũ → mới) ──
    allDue.sort((a, b) => {
      const ta = parseScheduledAt(a.scheduled_at)?.getTime() ?? 0
      const tb = parseScheduledAt(b.scheduled_at)?.getTime() ?? 0
      return ta - tb
    })

    sendLog(`Tổng ${allDue.length} video — thứ tự đăng:`, 'ok')
    allDue.forEach((r, i) => {
      sendLog(
        `  ${i + 1}. [${r._channel.name}] ${r.file_name} — ${r.scheduled_at || 'ngay'}`,
        'info'
      )
    })

    // ── Bước 3: Chạy tuần tự theo thứ tự đã sort ──
    for (let i = 0; i < allDue.length; i++) {
      if (!isRunning) break

      const row = allDue[i]
      const channel = row._channel

      sendLog(`── [${i + 1}/${allDue.length}] [${channel.name}] ${row.file_name} ──`, 'info')
      mainWindow?.webContents.send('row:processing', {
        channelId: channel.id,
        rowIndex: row.rowIndex,
      })

      try {
        const fbVideoId = await uploadVideoToFacebook(browser, row, channel)
        await updateRowStatusForChannel(channel, row.rowIndex, 'posted', fbVideoId)
        sendLog(`[${channel.name}] ✓ Đã đăng: ${row.file_name}`, 'ok')
        mainWindow?.webContents.send('row:done', {
          channelId: channel.id,
          rowIndex: row.rowIndex,
          fbVideoId,
        })
      } catch (e) {
        await updateRowStatusForChannel(channel, row.rowIndex, 'error')
        sendLog(`[${channel.name}] ✗ Lỗi ${row.file_name}: ${e.message}`, 'error')
        mainWindow?.webContents.send('row:error', {
          channelId: channel.id,
          rowIndex: row.rowIndex,
          error: e.message,
        })
      }

      // Delay giữa các video (trừ video cuối)
      if (isRunning && i < allDue.length - 1) {
        const delay = (store.get('delayBetween') || 15) * 1000
        sendLog(`Nghỉ ${delay / 1000}s trước video tiếp theo...`, 'info')
        await sleep(delay)
      }
    }

    sendLog('Chrome vẫn mở — kiểm tra kết quả trên Facebook', 'info')

  } catch (e) {
    sendLog(`Lỗi nghiêm trọng: ${e.message}`, 'error')
  }

  isRunning = false
  sendStatus('idle')
  sendLog('Hoàn tất tất cả kênh.', 'ok')
}

// ─── Puppeteer: Launch/connect browser ───────────────────────
async function launchBrowser() {
  const { execSync, exec } = require('child_process')

  // Bước 1: Kiểm tra Chrome đang chạy với debug port chưa
  const isAlive = await checkChromeAlive()

  if (!isAlive) {
    // Bước 2: Chạy script khởi động nếu có cấu hình
    const startScript = store.get('chromeStartScript') || ''
    const scriptPath = startScript.replace(/^~/, process.env.HOME || '')

    if (scriptPath && fs.existsSync(scriptPath)) {
      sendLog(`Chrome chưa chạy — gọi script: ${startScript}`, 'info')
      try {
        // Chạy script nền (không block)
        exec(`bash "${scriptPath}"`, (err) => {
          if (err) sendLog(`Script error: ${err.message}`, 'warn')
        })

        // Chờ Chrome khởi động + Facebook load (tối đa 30s)
        sendLog('Chờ Chrome khởi động...', 'info')
        const ready = await waitForChrome(30000)
        if (ready) {
          sendLog('Chrome đã sẵn sàng ✓', 'ok')
        } else {
          sendLog('Chrome khởi động chậm — thử kết nối tiếp...', 'warn')
        }
      } catch (e) {
        sendLog(`Lỗi chạy script: ${e.message}`, 'warn')
      }
    } else if (startScript) {
      sendLog(`⚠ Script không tồn tại: ${startScript}`, 'warn')
      sendLog('Tiếp tục không có script...', 'warn')
    } else {
      sendLog('Chrome chưa chạy và chưa cấu hình script khởi động', 'warn')
      sendLog('Vào Cấu hình → Chrome → Script khởi động để cài đặt', 'warn')
    }
  }

  // Bước 3: Kết nối vào Chrome qua debug port
  try {
    const browser = await puppeteer.connect({
      browserURL: 'http://localhost:9222',
      defaultViewport: null,
    })
    sendLog('Đã kết nối vào Chrome (port 9222) ✓', 'ok')
    return browser
  } catch (_) {
    // Fallback: mở Chrome mới bằng Puppeteer (không có session Facebook)
    sendLog('Không kết nối được port 9222 — mở Chrome mới (cần login Facebook)', 'warn')
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

// Kiểm tra Chrome debug port có active không
async function checkChromeAlive() {
  try {
    const http = require('http')
    return await new Promise((resolve) => {
      const req = http.get('http://localhost:9222/json/version', (res) => {
        resolve(res.statusCode === 200)
      })
      req.on('error', () => resolve(false))
      req.setTimeout(2000, () => { req.destroy(); resolve(false) })
    })
  } catch {
    return false
  }
}

// Chờ Chrome debug port active (poll mỗi 2s)
async function waitForChrome(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await checkChromeAlive()) return true
    const elapsed = Math.round((Date.now() - start) / 1000)
    if (elapsed % 5 === 0 && elapsed > 0) {
      sendLog(`[${elapsed}s] Chờ Chrome port 9222...`, 'info')
    }
    await sleep(2000)
  }
  return false
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
async function uploadVideoToFacebook(browser, row, channel) {
  // Lấy pageUrl và videoBaseDir từ channel config
  const pageUrl = channel.pageUrl
  if (!pageUrl) throw new Error(`Kênh "${channel.name}": chưa cấu hình Facebook Page URL`)

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

  // ── Bước 0: Switch sang đúng tài khoản Page ──
  sendLog(`Switch sang tài khoản: ${channel.name}...`, 'info')
  await page.goto('https://www.facebook.com', { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(2000)

  // Click nút "Chuyển ngay" trên trang Profile của Page
  const switched = await switchToPage(page, channel)

  // Sau khi switch Facebook reload → lấy lại page reference mới nhất
  const freshPages = await browser.pages()
  page = freshPages.find(p => p.url().includes('facebook.com')) || page

  if (switched) {
    sendLog(`Đã switch sang tài khoản "${channel.name}" ✓`, 'ok')
    await sleep(2000)
  } else {
    sendLog(`Không switch được — tiếp tục với tài khoản hiện tại`, 'warn')
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

  // Đánh dấu element để Puppeteer click trực tiếp
  const foundCreate = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('span')]
    const span = spans.find(el => el.textContent.trim() === 'Tạo thước phim')
    if (!span) return false
    let el = span
    for (let i = 0; i < 10; i++) {
      const tag = el.tagName?.toLowerCase()
      const role = el.getAttribute?.('role')
      if (tag === 'a' || tag === 'button' || role === 'button') {
        el.setAttribute('data-puppeteer-click', 'true'); return true
      }
      if (!el.parentElement) break
      el = el.parentElement
    }
    span.setAttribute('data-puppeteer-click', 'true'); return true
  })
  if (!foundCreate) throw new Error('Không tìm thấy nút "Tạo thước phim"')

  const createEl = await page.$('[data-puppeteer-click="true"]')
  if (!createEl) throw new Error('Không lấy được element "Tạo thước phim"')
  await page.evaluate(el => el.removeAttribute('data-puppeteer-click'), createEl)
  await createEl.click()
  sendLog('Đã click "Tạo thước phim" ✓', 'ok')
  await sleep(4000)

  // ── Bước 3+4: Upload file dùng waitForFileChooser (chặn native dialog) ──
  sendLog(`Upload file: ${row.file_name}`, 'info')
  const filePath = resolveFilePath(row.file_name, channel)
  if (!fs.existsSync(filePath)) {
    throw new Error(`File không tồn tại: ${filePath}`)
  }

  // Puppeteer waitForFileChooser() chặn native dialog và inject file trực tiếp
  // Phải set TRƯỚC khi trigger click để bắt được event
  sendLog('Chuẩn bị intercept file chooser...', 'info')
  const fileChooserPromise = page.waitForFileChooser({ timeout: 10000 })

  // Tìm và click nút "Tải lên" bằng element.click() — không dùng tọa độ
  sendLog('Tìm nút "Tải lên"...', 'info')
  const foundUpload = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('span')]
    const span = spans.find(el => {
      const t = el.textContent.trim()
      return t === 'Tải lên' || t === 'Thêm video' || t === 'Upload'
    })
    if (!span) return false
    let el = span
    for (let i = 0; i < 10; i++) {
      const tag = el.tagName?.toLowerCase()
      const role = el.getAttribute?.('role')
      if (tag === 'a' || tag === 'button' || role === 'button') {
        el.setAttribute('data-puppeteer-click', 'true'); return true
      }
      const style = window.getComputedStyle(el)
      if (style.cursor === 'pointer') {
        el.setAttribute('data-puppeteer-click', 'true'); return true
      }
      if (!el.parentElement) break
      el = el.parentElement
    }
    span.setAttribute('data-puppeteer-click', 'true'); return true
  })

  if (foundUpload) {
    const uploadEl = await page.$('[data-puppeteer-click="true"]')
    if (uploadEl) {
      await page.evaluate(el => el.removeAttribute('data-puppeteer-click'), uploadEl)
      await uploadEl.click()
      sendLog('Đã click "Tải lên" ✓', 'ok')
    }
  } else {
    sendLog('Không tìm thấy nút "Tải lên" — thử input trực tiếp', 'warn')
  }
  sendLog('Đang chờ file chooser...', 'info')

  // Đợi file chooser bị intercept (native dialog bị chặn bởi Puppeteer)
  let fileChooser = null
  try {
    fileChooser = await fileChooserPromise
    sendLog('File chooser đã bị intercept ✓ (native dialog không mở)', 'ok')
  } catch (e) {
    sendLog(`waitForFileChooser timeout: ${e.message}`, 'warn')
    sendLog('Thử tìm input file trực tiếp...', 'info')
  }

  if (fileChooser) {
    // Inject file qua file chooser — native dialog KHÔNG mở
    await fileChooser.accept([filePath])
    sendLog(`File "${row.file_name}" đã inject ✓ — Facebook đang upload...`, 'ok')
  } else {
    // Fallback: inject trực tiếp vào input element
    sendLog('Fallback: inject trực tiếp vào input[type="file"]...', 'warn')
    await page.waitForFunction(
      () => document.querySelectorAll('input[type="file"]').length > 0,
      { timeout: 10000 }
    ).catch(() => {})

    const fileInputEl = await page.evaluateHandle(() => {
      const inputs = [...document.querySelectorAll('input[type="file"]')]
      return inputs.find(i => {
        const accept = i.getAttribute('accept') || ''
        return accept.includes('video') || accept.includes('mp4')
      }) || inputs[0] || null
    }).then(h => h.asElement ? h.asElement() : null)

    if (!fileInputEl) throw new Error('Không tìm thấy input file video')
    await fileInputEl.uploadFile(filePath)
    sendLog(`File inject fallback ✓`, 'ok')
  }

  // ── Bước 5: Chờ Facebook xác nhận "an toàn để đăng" ──
  // uploadFile() inject file trực tiếp — KHÔNG mở native dialog
  // nên không cần đóng file picker nữa
  sendLog('Chờ Facebook upload + quét bản quyền...', 'info')
  await waitForSafeToPost(page)
  sendLog('"Thước phim của bạn an toàn để đăng!" ✓', 'ok')

  // Delay tự nhiên trước khi click
  const d1 = await humanDelayLog('beforeNext1', DELAY.beforeNext1Min, DELAY.beforeNext1Max)
  sendLog(`Click "Tiếp" bước 1 (sau delay ${d1}ms)...`, 'info')
  await clickButtonByText(page, ['Tiếp', 'Next'])
  sendLog(`Chờ afterNext1 (${DELAY.afterNext1}ms) — màn chỉnh sửa load...`, 'info')
  await sleep(DELAY.afterNext1)

  // ── Bước 7: Chờ "Tiếp" lần 2 sẵn sàng rồi click ──
  sendLog('Chờ nút "Tiếp" bước 2 xuất hiện...', 'info')
  await waitForSafeToPost(page) // chờ text "an toàn" vẫn còn hoặc màn mới load
  const d2 = await humanDelayLog('beforeNext2', DELAY.beforeNext2Min, DELAY.beforeNext2Max)
  sendLog(`Click "Tiếp" bước 2 - bỏ qua chỉnh sửa (sau delay ${d2}ms)...`, 'info')
  await clickButtonByText(page, ['Tiếp', 'Next'])
  sendLog(`Chờ afterNext2 (${DELAY.afterNext2}ms) — màn cài đặt load...`, 'info')
  await sleep(DELAY.afterNext2)

  // ── Bước 8: Điền mô tả ──
  sendLog(`Chờ beforeDescription (${DELAY.beforeDescription}ms)...`, 'info')
  await sleep(DELAY.beforeDescription)
  if (row.description) {
    sendLog('Điền mô tả thước phim (clipboard paste)...', 'info')

    // Focus vào ô mô tả
    const focused = await page.evaluate(() => {
      const allTargets = [
        ...document.querySelectorAll('textarea'),
        ...document.querySelectorAll('[contenteditable="true"]'),
      ]
      const box = allTargets.find(el => {
        const r = el.getBoundingClientRect()
        return r.width > 50 && r.height > 20
      })
      if (!box) return false
      box.focus()
      // Xóa nội dung cũ
      if (box.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(box, '')
        box.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        document.execCommand('selectAll', false, null)
        document.execCommand('delete', false, null)
      }
      return true
    })

    if (focused) {
      // Dùng clipboard API để paste — tránh autocomplete khi type từng ký tự
      await page.evaluate((text) => {
        // Ghi text vào clipboard
        return navigator.clipboard.writeText(text).catch(() => {
          // Fallback nếu clipboard API không khả dụng
          const el = document.activeElement
          if (el && el.tagName === 'TEXTAREA') {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
            setter.call(el, text)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
          }
        })
      }, row.description)

      await sleep(300)

      // Ctrl+A để chọn hết (đề phòng còn text cũ), rồi Ctrl+V để paste
      await page.keyboard.down('Control')
      await page.keyboard.press('a')
      await page.keyboard.up('Control')
      await sleep(100)
      await page.keyboard.down('Control')
      await page.keyboard.press('v')
      await page.keyboard.up('Control')
      await sleep(500)

      // Đóng bất kỳ dropdown autocomplete nào bằng Escape
      await page.keyboard.press('Escape')
      await sleep(300)

      sendLog('Đã điền mô tả ✓', 'ok')
    } else {
      sendLog('Không tìm thấy ô mô tả, bỏ qua...', 'warn')
    }
    sendLog(`Chờ afterDescription (${DELAY.afterDescription}ms)...`, 'info')
    await sleep(DELAY.afterDescription)
  }

  // ── Bước 9: Click "Đăng" (nút xanh, không phải nút "Lưu") ──
  const d3 = await humanDelayLog('beforePublish', DELAY.beforePublishMin, DELAY.beforePublishMax)
  sendLog(`Tìm nút "Đăng" (sau delay ${d3}ms)...`, 'info')
  await waitForButtonActive(page, ['Đăng', 'Publish', 'Share'])
  await humanDelay(500, 1500)

  // Snapshot ID hiện có TRƯỚC khi đăng để so sánh sau
  sendLog('Snapshot danh sách reel hiện có...', 'info')
  const existingReelIds = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="/reel/"]')]
    return links.map(l => {
      const m = l.href.match(/\/reel\/(\d{10,18})/)
      return m ? m[1] : null
    }).filter(Boolean)
  })
  sendLog(`Snapshot: ${existingReelIds.length} reels hiện có`, 'info')

  // Click nút "Đăng" — dùng mouse.click tọa độ thật
  // Facebook layout: [Lưu] [Đăng] — "Đăng" luôn ở bên phải
  // Cấu trúc: div.html-div > div[role="none"] > span > span "Đăng"
  // Không có role="button" nên dùng tọa độ
  const dangCoords = await page.evaluate(() => {
    const allSpans = [...document.querySelectorAll('span')]
    // Tìm tất cả span có text chính xác "Đăng"
    const dangSpans = allSpans.filter(s => s.textContent.trim() === 'Đăng')
    if (dangSpans.length === 0) return null

    // Lấy span "Đăng" nằm xa nhất bên phải (tránh nhầm "Lưu" bên trái)
    const visible = dangSpans.filter(s => {
      const r = s.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.top > 0
    })
    if (visible.length === 0) return null

    // Sort theo left giảm dần → rightmost = nút "Đăng"
    visible.sort((a, b) =>
      b.getBoundingClientRect().left - a.getBoundingClientRect().left
    )
    const span = visible[0]
    const r = span.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })

  if (!dangCoords) {
    sendLog('Không tìm thấy span "Đăng" — kiểm tra Chrome thủ công', 'warn')
  } else {
    sendLog(`Click nút "Đăng" tại (${Math.round(dangCoords.x)}, ${Math.round(dangCoords.y)})...`, 'info')
    await page.mouse.move(dangCoords.x, dangCoords.y, { steps: 5 })
    await sleep(200)
    await page.mouse.click(dangCoords.x, dangCoords.y)
    sendLog('Đã click nút "Đăng" ✓', 'ok')
  }

  // ── Bước 10: Chờ 5 phút rồi refresh lấy ID thật ──
  // Facebook cần ~3-5 phút để xử lý và hiển thị Reel mới
  // Cách đáng tin nhất: refresh trang, tìm reel MỚI (không trong snapshot)
  // có view count thấp nhất (= vừa đăng)
  const waitMinutes = DELAY.waitAfterPublishMin || 5
  sendLog(`Đã đăng! Chờ ${waitMinutes} phút để Facebook xử lý Reel...`, 'ok')

  for (let s = waitMinutes * 60; s > 0; s -= 30) {
    await sleep(30000)
    sendLog(`Còn ${s - 30}s trước khi refresh lấy link...`, 'info')
    if (s <= 30) break
  }

  // Refresh trang Reels (tối đa refreshAttempts lần, mỗi lần cách refreshInterval)
  let realVideoId = null
  const maxRefresh = DELAY.refreshAttempts || 3
  const refreshInterval = DELAY.refreshInterval || 60000 // 60s mỗi lần nếu chưa thấy

  for (let attempt = 1; attempt <= maxRefresh; attempt++) {
    sendLog(`[Refresh ${attempt}/${maxRefresh}] Reload trang Reels...`, 'info')
    await page.goto(reelsUrl, { waitUntil: 'networkidle2', timeout: 30000 })
      .catch(() => page.reload({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}))
    await sleep(4000)

    // Lấy tất cả reel link + view count trên trang
    const reelsData = await page.evaluate(() => {
      const results = []
      const links = [...document.querySelectorAll('a[href*="/reel/"]')]
      links.forEach(link => {
        const m = link.href.match(/\/reel\/(\d{10,17})/) // Reel ID thật: 13-17 chữ số
        if (!m) return
        const id = m[1]

        // Tìm view count gần link này
        // Facebook thường hiển thị "X lượt xem" hoặc số views dạng "1,2N"
        const container = link.closest('[data-visualcompletion]') ||
                         link.parentElement?.closest('div') ||
                         link.parentElement

        let viewText = ''
        if (container) {
          const allText = container.innerText || ''
          // Tìm số views: dạng "290 lượt xem", "1,2 N lượt xem", "1.2K views"
          const viewMatch = allText.match(/(\d[\d.,]*\s*[KMkm]?)\s*(lượt xem|views?)/i)
          viewText = viewMatch ? viewMatch[0] : ''
        }

        results.push({ id, viewText, href: link.href })
      })
      // Dedup theo id
      return [...new Map(results.map(r => [r.id, r])).values()]
    })

    sendLog(`[Refresh ${attempt}] Thấy ${reelsData.length} reels trên trang`, 'info')

    // Lọc ID mới (không có trong snapshot)
    const newReels = reelsData.filter(r => !existingReelIds.includes(r.id))

    if (newReels.length > 0) {
      sendLog(`Tìm thấy ${newReels.length} reel mới: ${newReels.map(r => r.id).join(', ')}`, 'ok')

      // Ưu tiên: reel có view thấp nhất (vừa đăng)
      // Parse view count để sort: "290" < "1,2N" < "5,6N"
      const parseViews = (txt) => {
        if (!txt) return Infinity // không có view text → có thể đang xử lý
        const clean = txt.replace(/[,\s]/g, '').toLowerCase()
        const num = parseFloat(clean)
        if (isNaN(num)) return Infinity
        if (clean.includes('k')) return num * 1000
        if (clean.includes('m')) return num * 1000000
        if (clean.includes('n')) return num * 1000 // "N" tiếng Việt = nghìn
        return num
      }

      newReels.sort((a, b) => parseViews(a.viewText) - parseViews(b.viewText))
      realVideoId = newReels[0].id

      sendLog(`Chọn reel mới nhất (view thấp nhất): ID=${realVideoId}`, 'ok')
      if (newReels[0].viewText) {
        sendLog(`View count: ${newReels[0].viewText}`, 'info')
      }
      break
    }

    sendLog(`[Refresh ${attempt}] Chưa thấy reel mới — thử lại sau ${refreshInterval/1000}s...`, 'warn')
    if (attempt < maxRefresh) await sleep(refreshInterval)
  }

  if (!realVideoId) {
    sendLog('⚠️ Không tìm được ID sau refresh — video có thể đang xử lý', 'warn')
    sendLog(`Xem thủ công tại: ${reelsUrl}`, 'warn')
    realVideoId = `UNKNOWN_${Date.now()}`
  }

  const reelLink = realVideoId.startsWith('UNKNOWN')
    ? `Chưa xác định — xem tại: ${reelsUrl}`
    : `https://www.facebook.com/reel/${realVideoId}`

  sendLog(`✓ Đã đăng Reels thành công!`, 'ok')
  sendLog(`📎 Link video: ${reelLink}`, 'ok')
  return realVideoId
}

// ─── DELAY CONFIG (ms) — điều chỉnh ở đây nếu cần ──────────
const DELAY = {
  afterFileSelect:        30000, // sau khi chọn file, trước khi bấm Escape
  afterEscape:            3000,  // sau Escape, trước khi chờ upload
  beforeNext1Min:         2000,  // delay tối thiểu trước "Tiếp" lần 1
  beforeNext1Max:         4500,  // delay tối đa trước "Tiếp" lần 1
  afterNext1:             4500,  // sau "Tiếp" lần 1, chờ màn chỉnh sửa load
  beforeNext2Min:         2500,  // delay tối thiểu trước "Tiếp" lần 2
  beforeNext2Max:         5000,  // delay tối đa trước "Tiếp" lần 2
  afterNext2:             5000,  // sau "Tiếp" lần 2, chờ màn cài đặt load
  beforeDescription:      5000,  // trước khi điền mô tả
  afterDescription:       5000,  // sau khi điền mô tả
  beforePublishMin:       3500,  // delay tối thiểu trước "Đăng"
  beforePublishMax:       5000,  // delay tối đa trước "Đăng"
  // Timeout chờ Facebook xác nhận "an toàn để đăng"
  // Tăng nếu hay bị lỗi timeout (Facebook kiểm tra bản quyền lâu)
  safeToPostTimeoutMin:   20,    // chờ tối đa N phút (mặc định 20 phút)
  // Sau khi bấm "Đăng": chờ FB xử lý rồi refresh lấy link
  waitAfterPublishMin:    5,     // chờ N phút trước khi refresh lần đầu
  refreshAttempts:        3,     // số lần refresh tối đa nếu chưa thấy reel mới
  refreshInterval:        60000, // chờ 60s giữa mỗi lần refresh
}

// ─── Helper: delay ngẫu nhiên giống người dùng thật ─────────
function humanDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs)
  return sleep(Math.round(ms))
}

// humanDelay có return giá trị delay thực tế để log
async function humanDelayLog(label, minMs, maxMs) {
  const ms = Math.round(minMs + Math.random() * (maxMs - minMs))
  sendLog(`[delay:${label}] chờ ${ms}ms...`, 'info')
  await sleep(ms)
  return ms
}

// ─── Helper: đóng file picker — đảm bảo cửa sổ đã đóng ─────
async function closeFilePicker(page) {
  // File picker native (GTK dialog trên Ubuntu) KHÔNG thể đóng bằng
  // page.keyboard.press('Escape') vì đó là cửa sổ OS riêng biệt.
  // Cần dùng xdotool để gửi key đến cửa sổ OS.

  sendLog('Đóng file picker native (xdotool)...', 'info')

  // Cách 1: xdotool key Escape gửi đến cửa sổ đang focus
  try {
    const { execSync } = require('child_process')

    // Cài xdotool nếu chưa có
    try { execSync('which xdotool', { stdio: 'pipe' }) }
    catch {
      sendLog('Cài xdotool...', 'info')
      execSync('sudo apt-get install -y xdotool', { stdio: 'pipe', timeout: 30000 })
    }

    // Gửi Escape đến cửa sổ đang active (file picker)
    execSync('xdotool key Escape', { timeout: 3000 })
    await sleep(500)

    // Thử thêm: tìm cửa sổ "Open File" và đóng
    try {
      execSync('xdotool search --name "Open File" key Escape', { timeout: 2000, stdio: 'pipe' })
    } catch (_) {}
    await sleep(500)

    // Thêm: click nút Cancel trong dialog
    try {
      execSync('xdotool search --name "Open File" key Return', { timeout: 2000, stdio: 'pipe' })
    } catch (_) {}
    await sleep(500)

    sendLog('xdotool Escape gửi xong ✓', 'ok')
  } catch (e) {
    sendLog(`xdotool lỗi: ${e.message} — thử cách khác`, 'warn')
  }

  // Cách 2: Click Cancel button bằng cách focus page trước
  // Sau khi xdotool escape, page cần re-focus
  await page.bringToFront()
  await sleep(500)

  // Cách 3: Puppeteer keyboard sau khi re-focus
  await page.keyboard.press('Escape')
  await sleep(500)

  // Verify: check input file không còn block trang
  const blocked = await page.evaluate(() => {
    // Nếu file picker còn mở, body sẽ không nhận click
    // Check bằng cách thử dispatch click event
    const result = document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return !result
  })

  if (blocked) {
    sendLog('Trang vẫn bị block — file picker có thể vẫn còn', 'warn')
  } else {
    sendLog('Trang đã active, file picker đã đóng ✓', 'ok')
  }

  // Focus lại page để các keystroke tiếp theo hoạt động
  await page.evaluate(() => {
    if (document.activeElement) document.activeElement.blur()
    window.focus()
  })
  await sleep(300)

  return true
}

// ─── Helper: Switch sang đúng tài khoản Page ────────────────
// Logic:
// 1. Click avatar góc phải → menu xổ xuống
// 2. Dòng ĐẦU TIÊN trong menu = tài khoản hiện tại
// 3. Nếu dòng đầu = targetName → đã đúng, không cần switch
// 4. Nếu không → tìm targetName trong menu → click
// 5. Nếu không thấy trong menu → mở trang Profile → click "Chuyển ngay"
async function switchToPage(page, channel) {
  const targetName = channel.name.trim()
  const pageProfileUrl = channel.pageUrl.split('?')[0].replace(/\/$/, '')

  try {
    // ── Bước 1: Click avatar góc phải để mở menu ──
    sendLog('Click avatar để kiểm tra tài khoản hiện tại...', 'info')

    // Mở trang facebook.com để có header chuẩn
    const currentUrl = page.url()
    if (!currentUrl.includes('facebook.com')) {
      await page.goto('https://www.facebook.com', { waitUntil: 'networkidle2', timeout: 30000 })
      await sleep(2000)
    }

    // Click avatar — dùng evaluate để tìm và click
    const menuOpened = await page.evaluate(() => {
      // Avatar ở cuối thanh nav header (góc phải)
      // Facebook render avatar là SVG hoặc img bên trong div role=button
      const allBtns = [...document.querySelectorAll('[role="button"]')]
        .filter(el => {
          const r = el.getBoundingClientRect()
          return r.top < 70 && r.right > window.innerWidth - 100 &&
                 r.width > 20 && r.width < 80
        })
        .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)

      if (allBtns.length > 0) {
        allBtns[0].click()
        return true
      }
      return false
    })

    if (!menuOpened) {
      // Fallback: click tọa độ góc phải cố định
      const vw = await page.evaluate(() => window.innerWidth)
      await page.mouse.click(vw - 40, 35)
      sendLog('Click avatar fallback tọa độ cố định', 'warn')
    }

    await sleep(2000) // Chờ menu xổ xuống

    // ── Bước 2: Đọc dòng đầu tiên trong menu = tài khoản hiện tại ──
    const menuInfo = await page.evaluate((targetName) => {
      // Tìm tất cả span[dir="auto"] trong menu dropdown
      // Menu thường là [role="menu"] hoặc [role="dialog"] hoặc div popup
      const popups = [
        ...document.querySelectorAll('[role="menu"]'),
        ...document.querySelectorAll('[role="dialog"]'),
        ...document.querySelectorAll('[role="listbox"]'),
      ]

      // Nếu không có popup rõ ràng, lấy từ toàn bộ DOM nhưng chỉ phần mới xuất hiện
      let menuSpans = []
      for (const popup of popups) {
        const spans = [...popup.querySelectorAll('span[dir="auto"]')]
          .map(s => s.textContent.trim())
          .filter(t => t.length > 1 && t.length < 60)
        if (spans.length > 0) {
          menuSpans = spans
          break
        }
      }

      // Fallback: lấy tất cả span visible trong khu vực góc phải màn hình
      if (menuSpans.length === 0) {
        menuSpans = [...document.querySelectorAll('span[dir="auto"]')]
          .filter(el => {
            const r = el.getBoundingClientRect()
            const t = el.textContent.trim()
            return r.right > window.innerWidth * 0.5 &&
                   r.top > 50 && r.top < 600 &&
                   t.length > 1 && t.length < 60
          })
          .map(s => s.textContent.trim())
          .filter((v, i, arr) => arr.indexOf(v) === i) // dedup
      }

      // Dòng đầu tiên = tài khoản hiện tại
      const currentAccount = menuSpans[0] || ''

      // Tìm targetName trong menu
      const targetIdx = menuSpans.findIndex(t =>
        t === targetName ||
        t.includes(targetName) ||
        targetName.includes(t)
      )

      return { currentAccount, menuSpans: menuSpans.slice(0, 8), targetIdx }
    }, targetName)

    sendLog(`Menu items: [${menuInfo.menuSpans.join(' | ')}]`, 'info')
    sendLog(`Tài khoản hiện tại (dòng 1): "${menuInfo.currentAccount}"`, 'info')

    // ── Bước 3: Kiểm tra đã đúng tài khoản chưa ──
    const isAlreadyCorrect =
      menuInfo.currentAccount === targetName ||
      menuInfo.currentAccount.includes(targetName) ||
      targetName.includes(menuInfo.currentAccount)

    if (isAlreadyCorrect && menuInfo.currentAccount.length > 0) {
      sendLog(`Đã đúng tài khoản "${targetName}" ✓ — đóng menu`, 'ok')
      await page.keyboard.press('Escape')
      await sleep(500)
      return true
    }

    // ── Bước 4: Tìm targetName trong menu và click ──
    if (menuInfo.targetIdx >= 0) {
      sendLog(`Tìm thấy "${targetName}" ở menu[${menuInfo.targetIdx}] → click...`, 'ok')

      const clicked = await page.evaluate((targetName) => {
        const allSpans = [...document.querySelectorAll('span[dir="auto"]')]
          .filter(el => {
            const r = el.getBoundingClientRect()
            return r.right > window.innerWidth * 0.5 && r.top > 50 && r.top < 600
          })
        const span = allSpans.find(s =>
          s.textContent.trim() === targetName ||
          s.textContent.trim().includes(targetName) ||
          targetName.includes(s.textContent.trim())
        )
        if (!span) return false
        span.scrollIntoView({ behavior: 'instant', block: 'center' })
        span.click()
        // Click parent cursor:pointer
        let el = span.parentElement
        for (let i = 0; i < 6; i++) {
          if (!el) break
          if (window.getComputedStyle(el).cursor === 'pointer') { el.click(); break }
          el = el.parentElement
        }
        return true
      }, targetName)

      if (clicked) {
        sendLog('Đã click tên kênh trong menu ✓ — chờ switch...', 'ok')
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
          sleep(500),
        ])
        await sleep(8000)
        sendLog(`✓ Switch thành công sang "${targetName}"`, 'ok')
        return true
      }
    }

    // ── Bước 5: Fallback — đóng menu, mở trang Profile, click "Chuyển ngay" ──
    sendLog(`Không thấy "${targetName}" trong menu — thử "Chuyển ngay"...`, 'warn')
    await page.keyboard.press('Escape')
    await sleep(500)

    await page.goto(pageProfileUrl, { waitUntil: 'networkidle2', timeout: 30000 })
    await sleep(3000)

    const clickedChuyenNgay = await page.evaluate(() => {
      const allSpans = [...document.querySelectorAll('span')]
      const span = allSpans.find(s =>
        s.textContent.trim() === 'Chuyển ngay' ||
        s.textContent.trim() === 'Switch now'
      )
      if (!span) return false
      span.scrollIntoView({ behavior: 'instant', block: 'center' })
      span.click()
      let el = span.parentElement
      for (let i = 0; i < 6; i++) {
        if (!el) break
        if (window.getComputedStyle(el).cursor === 'pointer') { el.click(); break }
        el = el.parentElement
      }
      return true
    })

    if (clickedChuyenNgay) {
      sendLog('Đã click "Chuyển ngay" ✓ — chờ switch...', 'ok')
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
        sleep(500),
      ])
      await sleep(8000)
      sendLog(`✓ Switch thành công sang "${targetName}"`, 'ok')
      return true
    }

    sendLog(`⚠ Không switch được — tiếp tục với tài khoản hiện tại`, 'warn')
    return false

  } catch (e) {
    sendLog(`switchToPage error: ${e.message}`, 'warn')
    return false
  }
}
async function clickButtonByText(page, texts) {
  for (const text of texts) {
    // Tìm element, scroll vào view, rồi click bằng JS (không cần visible)
    const result = await page.evaluate((text) => {
      const allSpans = [...document.querySelectorAll('span')]
      const span = allSpans.find(s => s.textContent.trim() === text)
      if (!span) return { found: false }

      // Leo lên tìm element clickable
      let el = span
      let clickTarget = span
      for (let i = 0; i < 10; i++) {
        const tag = el.tagName?.toLowerCase()
        const role = el.getAttribute?.('role')
        const disabled = el.disabled || el.getAttribute?.('aria-disabled') === 'true'
        if (disabled) return { found: false, reason: 'disabled' }
        if (tag === 'button' || role === 'button') {
          clickTarget = el; break
        }
        const style = window.getComputedStyle(el)
        if (style.cursor === 'pointer') clickTarget = el
        if (!el.parentElement) break
        el = el.parentElement
      }

      // Scroll element vào vùng nhìn thấy (quan trọng khi màn hình nhỏ)
      clickTarget.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })

      // Click bằng JS trực tiếp — hoạt động kể cả khi element ngoài viewport
      clickTarget.click()

      const r = clickTarget.getBoundingClientRect()
      return {
        found: true,
        tag: clickTarget.tagName,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
      }
    }, text)

    if (result?.found) {
      const viewportInfo = result.inViewport ? 'in viewport' : 'scrolled into view'
      sendLog(`Đã click "${text}" (JS click, ${viewportInfo}) ✓`, 'ok')
      await sleep(300)
      return text
    }
  }

  sendLog(`Không tìm thấy nút [${texts.join('/')}]`, 'warn')
  return null
}

// ─── Helper: chờ Facebook xác nhận "an toàn để đăng" ────────
// Chờ text "Thước phim của bạn an toàn để đăng!" xuất hiện
// — đây là tín hiệu chính xác nhất: upload xong + quét bản quyền xong
async function waitForSafeToPost(page) {
  // Đọc timeout từ DELAY config — dễ điều chỉnh không cần sửa code
  const timeoutMs = (DELAY.safeToPostTimeoutMin || 20) * 60 * 1000
  const timeoutMin = Math.round(timeoutMs / 60000)
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

  sendLog(`Đang chờ Facebook xác nhận an toàn đăng (timeout ${timeoutMin} phút)...`, 'info')

  while (Date.now() - start < timeoutMs) {
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

  throw new Error(`Timeout ${timeoutMin} phút: Facebook chưa xác nhận an toàn đăng`)
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

// Resolve file path từ tên file + channel config
function resolveFilePath(fileName, channel) {
  if (path.isAbsolute(fileName)) return fileName
  const baseDir = (channel && channel.videoBaseDir) || ''
  return baseDir ? path.join(baseDir, fileName) : fileName
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))