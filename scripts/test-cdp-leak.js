#!/usr/bin/env node
// ============================================================
//  test-cdp-leak — verifies src/main/browser/browserConnection.js
//  does not leak CDP connections or pages.
//
//  - Starts a THROWAWAY Chrome on port 9333 with a temp profile
//    (never touches the real Chrome on 9222).
//  - Control: shows the old pattern (connect without disconnect)
//    really leaks, so the counter is trustworthy.
//  - Runs 50 jobs through acquireBrowser/getBrowser/releaseBrowser,
//    some throwing on purpose, some concurrent, plus a forced drop to
//    exercise reconnect.
//  - Asserts: <= 3 connections to 9333, page count back to baseline.
//  - Kills the temp Chrome and deletes its profile.
//
//  Usage: node scripts/test-cdp-leak.js   (CHROME_PATH=... to override)
// ============================================================
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execSync } = require('child_process')
const puppeteer = require('puppeteer-core')
const conn = require('../src/main/browser/browserConnection')

const PORT = 9333
const BROWSER_URL = `http://127.0.0.1:${PORT}`
const TOTAL_JOBS = 50
const MAX_CONNECTIONS = 3

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'],
  }
  const found = (candidates[process.platform] || []).find(p => fs.existsSync(p))
  if (!found) throw new Error('Chrome not found — set CHROME_PATH')
  return found
}

// ESTABLISHED TCP connections from THIS process to PORT
function countConnections() {
  try {
    if (process.platform === 'darwin') {
      const out = execSync(
        `lsof -nP -a -p ${process.pid} -iTCP:${PORT} -sTCP:ESTABLISHED`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      )
      return out.trim().split('\n').slice(1).filter(Boolean).length
    }
    const out = execSync(
      `ss -Htnp state established '( dport = :${PORT} )'`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return out.split('\n').filter(l => l.includes(`pid=${process.pid},`)).length
  } catch (e) {
    // lsof exits 1 when nothing matches
    if (e.status === 1) return 0
    throw e
  }
}

async function waitForPort(timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if ((await conn.countChromePages()) !== null) return
    await sleep(250)
  }
  throw new Error(`Chrome did not open port ${PORT}`)
}

// HTTP keep-alive sockets used by puppeteer's /json/version lookup
// linger a few seconds; wait until the count settles
async function settledConnections(maxWaitMs = 8000, target = 0) {
  const start = Date.now()
  let n = countConnections()
  while (n > target && Date.now() - start < maxWaitMs) {
    await sleep(500)
    n = countConnections()
  }
  return n
}

let failures = 0
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failures++
}

// One simulated job, shaped like a queue runner + action
async function runJob(i, { fail }) {
  const owner = `job#${i}`
  await conn.acquireBrowser(owner)
  let page = null
  try {
    const browser = await conn.getBrowser()
    page = await browser.newPage()
    const onResponse = () => {}
    page.on('response', onResponse)
    try {
      await page.goto('about:blank')
      if (fail) throw new Error(`intentional failure in job ${i}`)
    } finally {
      page.off('response', onResponse)
    }
    return 'ok'
  } finally {
    if (page) await page.close().catch(() => {})
    await conn.releaseBrowser(owner)
  }
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-leak-test-'))
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    'about:blank',
  ], { stdio: 'ignore' })
  console.log(`Temp Chrome pid=${chrome.pid}, profile=${userDataDir}`)

  try {
    conn.configureBrowserConnection({
      debugPort: PORT,
      connect: () => puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null }),
      log: () => {},
    })
    await waitForPort()

    const basePages = await conn.countChromePages()
    const baseConns = await settledConnections()
    console.log(`Baseline: pages=${basePages}, connections=${baseConns}`)

    // ── Control: old pattern (connect per run, never disconnect) ──
    const leaked = []
    for (let i = 0; i < 5; i++) {
      const b = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null })
      await b.pages()
      leaked.push(b)
    }
    const leakedConns = await settledConnections(1000)
    check(leakedConns >= 5, `control: old pattern leaks (${leakedConns} connections after 5 runs)`)
    await Promise.all(leaked.map(b => b.disconnect()))
    check((await settledConnections()) === 0, 'control: connections released after disconnect()')

    // ── 50 jobs through the new module ──
    let ok = 0
    let failed = 0
    let peak = 0
    const failSet = new Set([3, 9, 17, 22, 31, 44])
    for (let i = 0; i < TOTAL_JOBS;) {
      // Mix sequential and concurrent batches (1..5 jobs at once)
      const batch = []
      const size = Math.min(1 + (i % 5), TOTAL_JOBS - i)
      for (let k = 0; k < size; k++, i++) {
        batch.push(runJob(i, { fail: failSet.has(i) }))
      }
      const results = await Promise.allSettled(batch)
      for (const r of results) r.status === 'fulfilled' ? ok++ : failed++
      peak = Math.max(peak, countConnections())
    }
    console.log(`Jobs: ${ok} ok, ${failed} failed (expected ${failSet.size} failures)`)
    check(failed === failSet.size, 'intentional failures propagated, others succeeded')

    // ── Long-held connection: many jobs share ONE socket ──
    await conn.acquireBrowser('holder')
    for (let i = 0; i < 10; i++) {
      const b = await conn.getBrowser()
      const p = await b.newPage()
      await p.close()
    }
    const heldConns = await settledConnections(8000, 1)
    check(heldConns <= 1, `while held, all jobs share one connection (${heldConns})`)

    // ── Forced drop → transparent reconnect ──
    const before = await conn.getBrowser()
    await before.disconnect()
    await sleep(200)
    const after = await conn.getBrowser()
    check(after !== before && after.connected, 'reconnects automatically after "disconnected"')
    await conn.releaseBrowser('holder')

    // ── Final assertions ──
    const finalConns = await settledConnections()
    const finalPages = await conn.countChromePages()
    console.log(`Peak connections during jobs: ${peak}`)
    check(finalConns <= MAX_CONNECTIONS, `connections to ${PORT} after run: ${finalConns} (<= ${MAX_CONNECTIONS})`)
    check(finalPages === basePages, `pages back to baseline: ${finalPages} (baseline ${basePages})`)
    check(!conn.isConnected() && conn.getOwnerCount() === 0, 'module idle: disconnected, no holders')
  } finally {
    chrome.kill('SIGTERM')
    await new Promise(r => { chrome.once('exit', r); setTimeout(r, 5000) })
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL')
    // Chrome may still flush files briefly after exit
    await sleep(500)
    fs.rmSync(userDataDir, { recursive: true, force: true })
    console.log(`Temp Chrome stopped, profile removed: ${!fs.existsSync(userDataDir)}`)
  }

  if (failures) {
    console.log(`\n${failures} check(s) FAILED`)
    process.exit(1)
  }
  console.log('\nAll checks passed')
}

main().catch((e) => {
  console.error('Test crashed:', e)
  process.exit(1)
})
