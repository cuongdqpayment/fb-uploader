// ============================================================
//  logger — sendLog/debugLog/sendStatus dùng chung cho toàn app.
//  Mọi module (services, browser, automation, queue, ipc) log
//  qua đây để đảm bảo đồng nhất 1 kênh log/1 log level duy nhất.
// ============================================================
const { getMainWindow } = require('./windowState')
const store = require('./store')

const LOG_LEVEL_MAP = { error: 0, warn: 1, ok: 2, info: 3, debug: 4 }

function getLogLevel() {
  return LOG_LEVEL_MAP[store.get('logLevel') || 'info'] ?? 3
}

function sendLog(message, type = 'info') {
  const msgLevel = LOG_LEVEL_MAP[type] ?? 3
  if (msgLevel > getLogLevel()) return
  const ts = new Date().toLocaleTimeString('vi-VN', { hour12: false })
  const fullMsg = `[${ts}] ${message}`
  const win = getMainWindow()
  if (win) {
    win.webContents.send('log', { message: fullMsg, type, time: new Date().toISOString() })
  }
  console.log(`[${type.toUpperCase()}] ${fullMsg}`)
}

// debugLog — chỉ hiện khi logLevel = 'debug'
function debugLog(message) {
  sendLog(message, 'debug')
}

function sendStatus(status) {
  const win = getMainWindow()
  if (win) win.webContents.send('status', status)
}

module.exports = { sendLog, debugLog, sendStatus, getLogLevel, LOG_LEVEL_MAP }
