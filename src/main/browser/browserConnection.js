// ============================================================
//  browserConnection — the ONLY place that owns the Puppeteer
//  connection to Chrome (CDP, port 9222).
//
//  Why: previously every queue run called puppeteer.connect() and
//  never disconnected, so each scheduler tick leaked one WebSocket
//  plus one CDP session per tab (with Network/Page/Runtime enabled),
//  making both Chrome and Electron grow without bound.
//
//  Rules:
//    - getBrowser() returns ONE shared Browser (singleton). If the
//      connection drops ('disconnected'), the cache is cleared and
//      the next getBrowser() reconnects transparently.
//    - Queue runners hold the connection via acquireBrowser(owner)
//      and give it back with releaseBrowser(owner). When nobody holds
//      it any more we disconnect, so an idle app keeps 0 connections.
//    - NEVER browser.close() a Chrome we connected to: on a CDP
//      connection that shuts down the user's logged-in Chrome. Only
//      disconnect(). A Chrome that Puppeteer launched itself (fallback
//      path) is also only disconnected, matching previous behaviour
//      of leaving the window open after a run.
//
//  No electron imports at module load: deps are required lazily so
//  scripts/test-cdp-leak.js can run this module under plain Node.
// ============================================================
const http = require('http')

const DIAG_INTERVAL_MS = 10 * 60 * 1000

let browser = null          // connected Browser, or null
let connecting = null       // in-flight connect promise (dedupe concurrent callers)
let owners = new Set()      // who currently holds the connection (e.g. 'upload', 'comment')
let diagTimer = null

// Overridable for tests; defaults use the real app modules
let connectFn = null
let logFn = null
let debugPort = 9222

function configureBrowserConnection(opts = {}) {
  if (opts.connect) connectFn = opts.connect
  if (opts.log) logFn = opts.log
  if (opts.debugPort) debugPort = opts.debugPort
}

function log(message, type = 'info') {
  if (!logFn) logFn = require('../logger').sendLog
  logFn(message, type)
}

function connectChrome() {
  if (!connectFn) connectFn = require('./browserManager').launchBrowser
  return connectFn()
}

function isConnected() {
  return !!browser && browser.connected
}

// Shared Browser; connects (or reconnects after a drop) when needed
async function getBrowser() {
  if (isConnected()) return browser
  if (connecting) return connecting

  connecting = (async () => {
    const b = await connectChrome()
    b.once('disconnected', () => {
      // Only clear if this is still the current instance (an older
      // instance may fire late after we already reconnected)
      if (browser === b) browser = null
      log('CDP connection to Chrome closed — will reconnect on next use', 'info')
    })
    browser = b
    return b
  })()

  try {
    return await connecting
  } finally {
    connecting = null
  }
}

async function acquireBrowser(owner) {
  owners.add(owner)
  try {
    return await getBrowser()
  } catch (e) {
    owners.delete(owner)
    throw e
  }
}

// Give the connection back; disconnects when no owner is left.
// Safe to call more than once for the same owner.
async function releaseBrowser(owner) {
  owners.delete(owner)
  if (owners.size === 0) await disconnectBrowser()
}

function getOwnerCount() {
  return owners.size
}

// Drop the CDP connection without touching Chrome itself
async function disconnectBrowser() {
  const pending = connecting
  if (pending) await pending.catch(() => {})
  const b = browser
  browser = null
  if (b && b.connected) {
    await b.disconnect().catch(() => {})
  }
}

// Count page targets via the HTTP endpoint (does NOT open a CDP connection)
function countChromePages() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: debugPort, path: '/json/list', agent: false }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).filter(t => t.type === 'page').length)
        } catch (_) {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(3000, () => { req.destroy(); resolve(null) })
  })
}

async function logDiagnostics() {
  const pages = await countChromePages()
  log(
    `[diag] CDP ${isConnected() ? 'connected' : 'disconnected'}, ` +
    `holders=${owners.size}${owners.size ? ` (${[...owners].join(',')})` : ''}, ` +
    `chrome pages=${pages === null ? 'n/a (port ' + debugPort + ' unreachable)' : pages}`,
    'info'
  )
}

function startDiagnostics(intervalMs = DIAG_INTERVAL_MS) {
  stopDiagnostics()
  diagTimer = setInterval(() => { logDiagnostics().catch(() => {}) }, intervalMs)
  diagTimer.unref?.()
}

function stopDiagnostics() {
  if (diagTimer) {
    clearInterval(diagTimer)
    diagTimer = null
  }
}

module.exports = {
  configureBrowserConnection,
  getBrowser,
  acquireBrowser,
  releaseBrowser,
  getOwnerCount,
  disconnectBrowser,
  isConnected,
  countChromePages,
  logDiagnostics,
  startDiagnostics,
  stopDiagnostics,
}
