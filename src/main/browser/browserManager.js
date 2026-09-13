// ============================================================
//  browserManager — kết nối/khởi động Chrome cho Puppeteer.
//  Ưu tiên CONNECT vào 1 Chrome đang chạy sẵn (giữ session Facebook
//  đã đăng nhập) qua remote-debugging-port 9222; chỉ launch Chrome
//  mới (chưa login) khi không kết nối được.
// ============================================================
const fs = require('fs')
const http = require('http')
const { exec } = require('child_process')
const puppeteer = require('puppeteer-core')
const store = require('../store')
const { sendLog } = require('../logger')
const { sleep } = require('../utils/sleep')

// Kiểm tra Chrome debug port có active không
async function checkChromeAlive() {
  try {
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

async function launchBrowser() {
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

module.exports = { launchBrowser, checkChromeAlive, waitForChrome, findChrome }
