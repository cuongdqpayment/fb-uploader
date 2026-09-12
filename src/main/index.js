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
    minWidth: 600,   // cho phép thu nhỏ hơn
    minHeight: 500,
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
    // DevTools tắt mặc định — mở bằng Ctrl+Shift+I khi cần debug
    // mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (!mainWindow) createWindow() })

  // Auto-restore scheduler nếu trước đó đã bật
  if (store.get('schedulerEnabled')) {
    const cronExpr = store.get('scheduleCron') || '*/15 * * * *'
    if (cronJob) { try { cronJob.stop() } catch (_) {} }
    cronJob = cron.schedule(cronExpr, () => {
      if (!isRunning) runUploadQueue(false)
    })
    // Thông báo sau khi window sẵn sàng
    setTimeout(() => {
      sendLog(`Scheduler auto-restored: ${cronExpr}`, 'ok')
      if (mainWindow) mainWindow.webContents.send('scheduler:state', true)
    }, 3000)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  if (browser) await browser.close().catch(() => {})
  if (cronJob) { try { cronJob.stop() } catch (_) {} }
})

// ─── Log levels ──────────────────────────────────────────────
const LOG_LEVEL_MAP = { error: 0, warn: 1, ok: 2, info: 3, debug: 4 }

function getLogLevel() {
  return LOG_LEVEL_MAP[store.get('logLevel') || 'info'] ?? 3
}

function sendLog(message, type = 'info') {
  const msgLevel = LOG_LEVEL_MAP[type] ?? 3
  if (msgLevel > getLogLevel()) return
  const ts = new Date().toLocaleTimeString('vi-VN', { hour12: false })
  const fullMsg = `[${ts}] ${message}`
  if (mainWindow) {
    mainWindow.webContents.send('log', { message: fullMsg, type, time: new Date().toISOString() })
  }
  console.log(`[${type.toUpperCase()}] ${fullMsg}`)
}

// debugLog — chỉ hiện khi logLevel = 'debug'
function debugLog(message) {
  sendLog(message, 'debug')
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
    range: `${channel.sheetTab}!A:H`,
  })

  const rows = res.data.values || []
  if (rows.length < 2) return []

  return rows.slice(1).map((row, idx) => ({
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
  })).filter(r => r.status === 'pending' && r.file_name)
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
  const cronExpr = store.get('scheduleCron') || '*/15 * * * *'
  if (cronJob) { try { cronJob.stop() } catch (_) {} }
  cronJob = cron.schedule(cronExpr, () => {
    if (!isRunning) runUploadQueue(false)
  })
  store.set('schedulerEnabled', true) // Lưu trạng thái
  sendLog(`Scheduler started: ${cronExpr}`, 'ok')
  return { ok: true }
})

ipcMain.handle('scheduler:stop', () => {
  if (cronJob) {
    try { cronJob.stop() } catch (_) {}
    cronJob = null
  }
  store.set('schedulerEnabled', false) // Lưu trạng thái
  sendLog('Scheduler stopped', 'warn')
  return { ok: true }
})

ipcMain.handle('scheduler:getState', () => {
  return { enabled: !!cronJob && store.get('schedulerEnabled') === true }
})

// ─── IPC: Manual run ─────────────────────────────────────────
ipcMain.handle('upload:runNow', async (_, channelId) => {
  if (isRunning) return { ok: false, error: 'Đang chạy rồi' }
  // force=true: BỎ QUA check giờ, đăng ngay lập tức
  runUploadQueue(true, channelId || null)
  return { ok: true }
})

ipcMain.handle('upload:runScheduled', async (_, channelId) => {
  if (isRunning) return { ok: false, error: 'Đang chạy rồi' }
  // force=false: CHECK giờ scheduled_at — chỉ đăng khi đến giờ
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

// ─── Helper: Parse scheduled_at — luôn dùng D/M/YYYY (locale VN) ──
// Google Sheets locale VN trả về: '10/09/2026 18:30:00' = ngày 10, tháng 9
// Khi ambiguous (cả 2 ≤ 12): luôn treat là D/M/YYYY
function parseScheduledAt(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null

  // Format 1: YYYY-MM-DD (an toàn nhất, không ambiguous)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = new Date(s.replace(' ', 'T') + (s.includes('+') ? '' : '+07:00'))
    if (!isNaN(t)) return t
  }

  // Format 2: D/M/YYYY (locale VN) — treat first number là NGÀY, second là THÁNG
  const match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (match) {
    const [, first, second, y, hh = '0', mm = '0', ss = '0'] = match
    const firstN = parseInt(first), secondN = parseInt(second)

    let day, month
    if (firstN > 12) {
      // first > 12 → chắc chắn là ngày (D/M/YYYY)
      day = firstN; month = secondN
    } else if (secondN > 12) {
      // second > 12 → chắc chắn là tháng → first là ngày (D/M/YYYY) thực ra M/D
      day = secondN; month = firstN
    } else {
      // Ambiguous: cả 2 ≤ 12 → theo locale VN = D/M/YYYY
      // first = ngày, second = tháng
      day = firstN; month = secondN
    }

    const dateStr = `${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}` +
                    `T${String(parseInt(hh)).padStart(2,'0')}:${mm.padStart(2,'0')}:${ss.padStart(2,'0')}+07:00`
    const t = new Date(dateStr)
    if (!isNaN(t)) return t
  }

  // Fallback: JS tự parse
  const t = new Date(s)
  return isNaN(t) ? null : t
}

// ─── Core: Upload queue (multi-channel) ──────────────────────
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

    for (const channel of activeChannels) {
      if (!isRunning) break
      sendLog(`── Kênh: ${channel.name} ──`, 'info')

      try {
        const rows = await fetchPendingRowsForChannel(channel)
        if (rows.length === 0) {
          sendLog(`[${channel.name}] Không có video pending.`, 'info')
          continue
        }

        const now = new Date()
        const due = rows.filter(r => {
          if (force) return true
          if (!r.scheduled_at) return true
          const t = parseScheduledAt(r.scheduled_at)
          if (!t) {
            sendLog(`[${r.file_name}] ⚠ Không parse được "${r.scheduled_at}" → chạy ngay`, 'warn')
            return true
          }
          const isDue = t <= now
          debugLog(`[${r.file_name}] ${r.scheduled_at} → ${t.toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})} due=${isDue}`)
          return isDue
        })

        if (due.length === 0) {
          const next = rows
            .map(r => ({ ...r, _t: parseScheduledAt(r.scheduled_at) }))
            .filter(r => r._t && r._t > now)
            .sort((a, b) => a._t - b._t)[0]
          if (next) {
            sendLog(`[${channel.name}] Chưa đến giờ. Sớm nhất: "${next.file_name}" lúc ${next._t.toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})}`, 'info')
          } else {
            sendLog(`[${channel.name}] Không có video đến giờ.`, 'info')
          }
          continue
        }

        sendLog(`[${channel.name}] ${due.length} video sẽ upload.`, 'ok')

        for (const row of due) {
          if (!isRunning) break

          sendLog(`[${channel.name}] Xử lý: ${row.file_name}`, 'info')
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

          // Delay giữa các video
          if (isRunning && due.indexOf(row) < due.length - 1) {
            const delay = (store.get('delayBetween') || 15) * 1000
            sendLog(`Nghỉ ${delay / 1000}s...`, 'info')
            await sleep(delay)
          }
        }

        // Delay giữa các kênh
        if (isRunning && activeChannels.indexOf(channel) < activeChannels.length - 1) {
          sendLog('Chờ 10s trước kênh tiếp theo...', 'info')
          await sleep(10000)
        }

      } catch (e) {
        sendLog(`[${channel.name}] Lỗi: ${e.message}`, 'error')
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

// ─── Helper: Switch sang đúng tài khoản Page ────────────────
// 6 bước theo đúng flow giao diện Facebook
async function switchToPage(page, channel) {
  const targetName = channel.name.trim()

  try {
    // Bước 0: Bring to front (quan trọng khi chạy ngầm)
    await page.bringToFront()
    await sleep(500)

    if (!page.url().includes('facebook.com')) {
      await page.goto('https://www.facebook.com', { waitUntil: 'networkidle2', timeout: 30000 })
      await sleep(2000)
    }

    // ── Bước 1: Click avatar → menu "Chuyển nhanh trang cá nhân" mở ──
    sendLog('Bước 1: Click avatar mở menu...', 'info')

    const avatarClicked = await page.evaluate(() => {
      // Tìm div[role="button"] ở góc phải header
      const btns = [...document.querySelectorAll('[role="button"]')]
        .filter(el => {
          const r = el.getBoundingClientRect()
          return r.top >= 0 && r.top < 70 &&
                 r.right > window.innerWidth * 0.8 &&
                 r.width >= 30 && r.width <= 70
        })
        .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)

      if (btns.length > 0) { btns[0].click(); return { ok: true, method: 'header-btn' } }

      // Fallback: image avatar fbcdn
      const imgs = [...document.querySelectorAll('image')].filter(img => {
        const href = img.getAttribute('xlink:href') || img.getAttribute('href') || ''
        const r = img.getBoundingClientRect()
        return href.includes('fbcdn') && r.top < 70 && r.right > window.innerWidth * 0.7
      })
      if (imgs.length > 0) {
        let el = imgs[0]
        for (let i = 0; i < 8; i++) {
          if (!el.parentElement) break
          el = el.parentElement
          if (el.getAttribute('role') === 'button') { el.click(); return { ok: true, method: 'avatar-img' } }
        }
      }
      return { ok: false }
    })

    if (!avatarClicked?.ok) {
      // Fallback tọa độ
      const vw = await page.evaluate(() => window.innerWidth)
      await page.mouse.click(vw - 40, 35)
      sendLog('Avatar fallback click (tọa độ)', 'warn')
    } else {
      debugLog(`Avatar clicked (${avatarClicked.method})`)
    }

    await sleep(2000) // Chờ menu render

    // ── Bước 2 + 3: Đọc panel và tìm kênh ──
    sendLog(`Bước 2-3: Tìm kênh "${targetName}" trong menu...`, 'info')
    const result1 = await _findAndClickChannel(page, targetName)
    debugLog(`_findAndClickChannel result: ${result1}`)

    if (result1 === 'already_active') {
      sendLog(`Đã đúng kênh "${targetName}" (active) ✓`, 'ok')
      await page.keyboard.press('Escape')
      await sleep(300)
      return true
    }

    if (result1 === 'clicked') {
      sendLog(`Đã click kênh "${targetName}" ✓ — chờ switch...`, 'ok')
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
        sleep(500),
      ])
      await sleep(6000)
      sendLog(`✓ Switch thành công sang "${targetName}"`, 'ok')
      return true
    }

    // result1 === 'not_found'
    // ── Bước 4: Click "Xem tất cả trang cá nhân" ──
    sendLog('Bước 4: Kênh chưa thấy — click "Xem tất cả trang cá nhân"...', 'info')

    const xemTatCaClicked = await page.evaluate(() => {
      // Dùng aria-label chính xác từ HTML thực tế
      const btn = document.querySelector('[aria-label="Xem tất cả trang cá nhân"]')
      if (btn) {
        btn.scrollIntoView({ behavior: 'instant', block: 'center' })
        btn.click()
        return true
      }
      // Fallback text
      const span = [...document.querySelectorAll('span')]
        .find(s => s.textContent.trim().includes('Xem tất cả'))
      if (span) {
        span.scrollIntoView({ behavior: 'instant', block: 'center' })
        span.click()
        return true
      }
      return false
    })

    if (!xemTatCaClicked) {
      await page.keyboard.press('Escape')
      throw new Error(`Không tìm thấy kênh "${targetName}" và không có nút "Xem tất cả"`)
    }

    sendLog('"Xem tất cả" đã click ✓ — chờ danh sách đầy đủ...', 'ok')
    await sleep(2000)

    // ── Bước 5: Gọi lại _findAndClickChannel trong danh sách đầy đủ ──
    sendLog(`Bước 5: Tìm lại "${targetName}" trong danh sách đầy đủ...`, 'info')
    const result2 = await _findAndClickChannel(page, targetName)
    debugLog(`_findAndClickChannel result2: ${result2}`)

    if (result2 === 'already_active') {
      sendLog(`Đã đúng kênh "${targetName}" ✓`, 'ok')
      await page.keyboard.press('Escape')
      return true
    }

    if (result2 === 'clicked') {
      sendLog(`Đã click kênh "${targetName}" ✓`, 'ok')
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
        sleep(500),
      ])
      await sleep(6000)
      sendLog(`✓ Switch thành công sang "${targetName}"`, 'ok')
      return true
    }

    // ── Bước 6: Vẫn not_found → báo lỗi ──
    await page.keyboard.press('Escape')
    throw new Error(`Không tìm thấy kênh "${targetName}" trong danh sách trang cá nhân`)

  } catch (e) {
    sendLog(`switchToPage lỗi: ${e.message}`, 'error')
    return false
  }
}

// ─── Helper: Tìm và click kênh trong panel hiện tại ──────────
// Return: 'already_active' | 'clicked' | 'not_found'
async function _findAndClickChannel(page, targetName) {
  return await page.evaluate((targetName) => {
    // Panel "Chuyển nhanh trang cá nhân" — aria-label chuẩn
    const panel = document.querySelector('[aria-label="Chuyển nhanh trang cá nhân"]')
    const items = panel
      ? [...panel.querySelectorAll('[role="button"]')]
      : [...document.querySelectorAll('[role="button"][aria-label^="Chuyển sang"]')]

    if (items.length === 0) return 'not_found'

    // Bước 2: Item đầu tiên = kênh đang active
    const firstLabel = (items[0]?.getAttribute('aria-label') || '')
      .replace('Chuyển sang ', '').trim()
    if (
      firstLabel.length > 0 && (
        firstLabel === targetName ||
        firstLabel.includes(targetName) ||
        targetName.includes(firstLabel)
      )
    ) return 'already_active'

    // Bước 3: Tìm [aria-label="Chuyển sang {targetName}"]
    const exactBtn = document.querySelector(`[aria-label="Chuyển sang ${targetName}"]`)
    if (exactBtn) {
      exactBtn.scrollIntoView({ behavior: 'instant', block: 'center' })
      exactBtn.click()
      return 'clicked'
    }

    // Partial aria-label match
    const partialBtn = items.find(el =>
      (el.getAttribute('aria-label') || '').includes(targetName)
    )
    if (partialBtn) {
      partialBtn.scrollIntoView({ behavior: 'instant', block: 'center' })
      partialBtn.click()
      return 'clicked'
    }

    // Fallback: span text match trong panel
    const spans = panel
      ? [...panel.querySelectorAll('span[dir="auto"]')]
      : [...document.querySelectorAll('span[dir="auto"]')]
    const span = spans.find(s => {
      const t = s.textContent.trim()
      return t === targetName || t.includes(targetName) || targetName.includes(t)
    })
    if (span) {
      span.scrollIntoView({ behavior: 'instant', block: 'center' })
      let el = span
      for (let i = 0; i < 8; i++) {
        if (!el) break
        if (el.getAttribute('role') === 'button') { el.click(); return 'clicked' }
        if (window.getComputedStyle(el).cursor === 'pointer') { el.click(); return 'clicked' }
        el = el.parentElement
      }
      span.click()
      return 'clicked'
    }

    return 'not_found'
  }, targetName)
}

// ─── Puppeteer: Upload video to Facebook Reels ───────────────
async function uploadVideoToFacebook(browser, row, channel) {
  const pageUrl = channel.pageUrl
  if (!pageUrl) throw new Error(`Kênh "${channel.name}": chưa cấu hình Facebook Page URL`)

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
  await switchToPage(page, channel)
  const freshPages = await browser.pages()
  page = freshPages.find(p => p.url().includes('facebook.com')) || page
  sendLog(`Đã switch sang "${channel.name}" ✓`, 'ok')
  await sleep(2000)
  const reelsUrl = pageUrl.includes('?')
    ? `${pageUrl}&sk=reels_tab`
    : `${pageUrl}?sk=reels_tab`

  sendLog(`Mở trang Reels: ${reelsUrl}`, 'info')
  await page.goto(reelsUrl, { waitUntil: 'networkidle2', timeout: 60000 })
  await sleep(3000)

  // ── Bước 2: Click nút "Tạo thước phim" ──
  sendLog('Tìm nút "Tạo thước phim"...', 'info')
  const foundCreate = await page.evaluate(() => {
    const span = [...document.querySelectorAll('span')]
      .find(el => el.textContent.trim() === 'Tạo thước phim')
    if (!span) return false
    span.scrollIntoView({ behavior: 'instant', block: 'center' })
    let el = span
    for (let i = 0; i < 10; i++) {
      const tag = el.tagName?.toLowerCase()
      const role = el.getAttribute?.('role')
      if (tag === 'a' || tag === 'button' || role === 'button') { el.click(); return true }
      const style = window.getComputedStyle(el)
      if (style.cursor === 'pointer') { el.click(); return true }
      if (!el.parentElement) break
      el = el.parentElement
    }
    span.click(); return true
  })
  if (!foundCreate) throw new Error('Không tìm thấy nút "Tạo thước phim"')
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

  // Click nút "Tải lên" bằng JS — không dùng tọa độ
  sendLog('Tìm nút "Tải lên"...', 'info')
  const foundUpload = await page.evaluate(() => {
    const span = [...document.querySelectorAll('span')]
      .find(el => ['Tải lên', 'Thêm video', 'Upload'].includes(el.textContent.trim()))
    if (!span) return false
    span.scrollIntoView({ behavior: 'instant', block: 'center' })
    let el = span
    for (let i = 0; i < 10; i++) {
      const tag = el.tagName?.toLowerCase()
      const role = el.getAttribute?.('role')
      if (tag === 'a' || tag === 'button' || role === 'button') { el.click(); return true }
      const style = window.getComputedStyle(el)
      if (style.cursor === 'pointer') { el.click(); return true }
      if (!el.parentElement) break
      el = el.parentElement
    }
    span.click(); return true
  })
  if (!foundUpload) sendLog('Không tìm thấy nút "Tải lên" — thử input trực tiếp', 'warn')
  else sendLog('Đã click "Tải lên" ✓', 'ok')
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
  debugLog(`Chờ beforeDescription (${DELAY.beforeDescription}ms)...`)
  await sleep(DELAY.beforeDescription)
  if (row.description) {
    sendLog('Điền mô tả thước phim...', 'info')

    // Focus ô mô tả và xóa sạch trước bằng keyboard (tránh React double-render)
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
      return true
    })

    if (focused) {
      // Xóa bằng keyboard thật trước (tránh React restore nội dung cũ)
      await page.keyboard.down('Control')
      await page.keyboard.press('a')
      await page.keyboard.up('Control')
      await sleep(100)
      await page.keyboard.press('Delete')
      await sleep(100)

      // Điền bằng clipboard paste — tránh autocomplete gợi ý
      await page.evaluate((text) => navigator.clipboard.writeText(text).catch(() => {}), row.description)
      await sleep(200)
      await page.keyboard.down('Control')
      await page.keyboard.press('v')
      await page.keyboard.up('Control')
      await sleep(300)

      // Đóng gợi ý autocomplete nếu có
      await page.keyboard.press('Escape')
      await sleep(200)

      sendLog('Đã điền mô tả ✓', 'ok')
    } else {
      sendLog('Không tìm thấy ô mô tả, bỏ qua...', 'warn')
    }

    debugLog(`Chờ afterDescription (${DELAY.afterDescription}ms)...`)
    await sleep(DELAY.afterDescription)
  }

  // ── Bước 9: Click "Đăng" ──
  const d3 = await humanDelayLog('beforePublish', DELAY.beforePublishMin, DELAY.beforePublishMax)
  sendLog(`Tìm nút "Đăng" (sau delay ${d3}ms)...`, 'info')
  await waitForButtonActive(page, ['Đăng', 'Publish', 'Share'])
  await humanDelay(500, 1500)

  // Snapshot danh sách reel ID hiện có TRƯỚC khi đăng
  // reelsUrl đã được khai báo ở Bước 1, dùng lại ở đây
  sendLog('Snapshot danh sách reel hiện có...', 'info')
  const existingReelIds = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="/reel/"]')]
    return links.map(l => {
      const m = l.href.match(/\/reel\/(\d{10,})/)
      return m ? m[1] : null
    }).filter(Boolean)
  })
  sendLog(`Hiện có ${existingReelIds.length} reels: [${existingReelIds.slice(0, 3).join(', ')}...]`, 'info')

  // Setup network interceptor để bắt video ID từ API response
  let networkVideoId = null
  const responseHandler = async (response) => {
    try {
      const url = response.url()
      if (!url.includes('facebook.com')) return
      if (
        url.includes('graphql') ||
        url.includes('video') ||
        url.includes('reel') ||
        url.includes('composer')
      ) {
        const status = response.status()
        if (status < 200 || status >= 300) return
        const text = await response.text().catch(() => '')
        if (!text || text.length < 10) return

        const patterns = [
          /"video_id"\s*:\s*"?(\d{12,18})"?/,
          /"reel_id"\s*:\s*"?(\d{12,18})"?/,
          /"creation_story_id"\s*:\s*"?(\d{12,18})"?/,
          /"post_id"\s*:\s*"?(\d{12,18})"?/,
        ]
        for (const pattern of patterns) {
          const m = text.match(pattern)
          if (m && m[1] && !existingReelIds.includes(m[1])) {
            networkVideoId = m[1]
            sendLog(`✓ Bắt được video ID mới từ network: ${networkVideoId}`, 'ok')
            return
          }
        }
      }
    } catch (_) {}
  }
  page.on('response', responseHandler)

  // Click "Đăng" — dùng rightmost span để tránh nhầm "Lưu" [Lưu][Đăng]
  // Facebook không dùng role="button" cho nút Đăng nên cần tìm theo vị trí
  sendLog('Click nút "Đăng"...', 'info')
  const dangClicked = await page.evaluate(() => {
    // Tìm tất cả span text = "Đăng" đang visible
    const allSpans = [...document.querySelectorAll('span')]
    const dangSpans = allSpans.filter(s => {
      const t = s.textContent.trim()
      // Chỉ lấy span có text chính xác = "Đăng" (không phải "Đăng ký" v.v.)
      return t === 'Đăng' || t === 'Publish' || t === 'Share'
    })
    if (dangSpans.length === 0) return false

    // Sort theo left DESC → span nằm xa nhất bên phải = nút "Đăng"
    // Facebook layout: [Lưu] [Đăng] — Đăng luôn bên phải hơn
    dangSpans.sort((a, b) =>
      b.getBoundingClientRect().left - a.getBoundingClientRect().left
    )
    const span = dangSpans[0]

    // scrollIntoView để đảm bảo element trong viewport
    span.scrollIntoView({ behavior: 'instant', block: 'center' })

    // JS click span trước
    span.click()

    // Rồi leo lên tìm parent cursor:pointer để click thêm
    let el = span.parentElement
    for (let i = 0; i < 8; i++) {
      if (!el) break
      const style = window.getComputedStyle(el)
      if (style.cursor === 'pointer') { el.click(); break }
      el = el.parentElement
    }
    return true
  })

  if (dangClicked) {
    sendLog('Đã click nút "Đăng" (JS rightmost) ✓', 'ok')
  } else {
    // Fallback: clickButtonByText
    sendLog('Fallback: dùng clickButtonByText...', 'warn')
    await clickButtonByText(page, ['Đăng', 'Publish', 'Share'])
  }

  // Chờ network ID (tối đa 15s)
  sendLog('Chờ video ID từ network response...', 'info')
  for (let i = 0; i < 30 && !networkVideoId; i++) {
    await sleep(500)
  }
  page.off('response', responseHandler)

  if (networkVideoId) {
    sendLog(`Video ID từ network: ${networkVideoId}`, 'ok')
    const link = `https://www.facebook.com/reel/${networkVideoId}`
    sendLog(`📎 Link video: ${link}`, 'ok')
    return networkVideoId
  }

  // Fallback: Refresh trang Reels nhiều lần để tìm video mới nhất
  sendLog('Network không bắt được ID — thử refresh trang Reels để tìm...', 'warn')

  let realVideoId = null
  const maxRefresh = DELAY.refreshAttempts || 5
  const refreshInterval = DELAY.refreshInterval || 30000 // 30s mỗi lần

  for (let attempt = 1; attempt <= maxRefresh; attempt++) {
    sendLog(`[Refresh ${attempt}/${maxRefresh}] Chờ ${refreshInterval/1000}s...`, 'info')
    await sleep(refreshInterval)

    sendLog(`[Refresh ${attempt}/${maxRefresh}] Reload trang Reels...`, 'info')
    await page.goto(reelsUrl, { waitUntil: 'networkidle2', timeout: 30000 })
      .catch(() => page.reload({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}))
    await sleep(3000)

    // Scan tất cả reel ID trên trang
    const currentIds = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href*="/reel/"]')]
      return links.map(l => {
        const m = l.href.match(/\/reel\/(\d{10,})/)
        return m ? m[1] : null
      }).filter(Boolean)
    })

    sendLog(`[Refresh ${attempt}] Tìm thấy ${currentIds.length} reels`, 'info')

    // Tìm ID mới (không có trong snapshot ban đầu)
    const newIds = currentIds.filter(id => !existingReelIds.includes(id))
    if (newIds.length > 0) {
      // Lấy ID đầu tiên (mới nhất — Facebook sort newest first)
      realVideoId = newIds[0]
      sendLog(`✓ Tìm được ${newIds.length} video mới: ${newIds.join(', ')}`, 'ok')
      sendLog(`Chọn ID mới nhất: ${realVideoId}`, 'ok')
      break
    }

    sendLog(`[Refresh ${attempt}] Chưa thấy video mới, thử lại...`, 'warn')
  }

  if (!realVideoId) {
    sendLog('⚠️ Không tìm được video ID sau nhiều lần refresh', 'warn')
    sendLog(`Kiểm tra thủ công tại: ${reelsUrl}`, 'warn')
    realVideoId = `UNKNOWN_${Date.now()}`
  }

  const reelLink = realVideoId.startsWith('UNKNOWN')
    ? `Không xác định — xem thủ công: ${reelsUrl}`
    : `https://www.facebook.com/reel/${realVideoId}`

  sendLog(`✓ Đã đăng Reels thành công!`, 'ok')
  sendLog(`📎 Link video: ${reelLink}`, 'ok')
  return realVideoId
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
  afterPublish:      15000, // chờ network response sau khi bấm "Đăng"
  // Refresh trang Reels để tìm video ID mới
  refreshAttempts:   5,     // số lần refresh tối đa
  refreshInterval:   30000, // chờ 30s giữa mỗi lần refresh
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

// ─── Helper: click nút theo text — dùng mouse thật ──────────
async function clickButtonByText(page, texts) {
  // JS click trực tiếp — scrollIntoView trước, không cần tọa độ
  // Hoạt động kể cả khi element ngoài viewport (màn hình nhỏ)
  const result = await page.evaluate((texts) => {
    for (const text of texts) {
      const span = [...document.querySelectorAll('span')]
        .find(s => s.textContent.trim() === text)
      if (!span) continue

      // Leo lên tìm clickable parent
      let clickTarget = span
      let el = span
      for (let i = 0; i < 10; i++) {
        const tag = el.tagName?.toLowerCase()
        const role = el.getAttribute?.('role')
        const disabled = el.disabled || el.getAttribute?.('aria-disabled') === 'true'
        if (disabled) break
        if (tag === 'button' || role === 'button') { clickTarget = el; break }
        const style = window.getComputedStyle(el)
        if (style.cursor === 'pointer') clickTarget = el
        if (!el.parentElement) break
        el = el.parentElement
      }

      // scrollIntoView rồi JS click — không cần visible trong viewport
      clickTarget.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })
      clickTarget.click()
      return text
    }
    return null
  }, texts)

  if (result) {
    sendLog(`Đã click "${result}" (JS click) ✓`, 'ok')
    await sleep(300)
    return result
  }

  sendLog(`Không tìm thấy nút [${texts.join('/')}]`, 'warn')
  return null
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

// Resolve file path từ tên file + channel config
function resolveFilePath(fileName, channel) {
  if (path.isAbsolute(fileName)) return fileName
  const baseDir = (channel && channel.videoBaseDir) || ''
  return baseDir ? path.join(baseDir, fileName) : fileName
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))