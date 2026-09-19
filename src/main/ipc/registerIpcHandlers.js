// ============================================================
//  registerIpcHandlers — toàn bộ ipcMain.handle(...) của app.
//  Chỉ gọi vào services/queue, KHÔNG chứa logic nghiệp vụ ở đây.
// ============================================================
const { ipcMain, dialog, shell } = require('electron')
const store = require('../store')
const { sendLog } = require('../logger')
const { getMainWindow } = require('../windowState')
const sheetsService = require('../services/sheetsService')
const schedulerService = require('../services/schedulerService')
const queueRunner = require('../queue/uploadQueueRunner')
const commentQueueRunner = require('../queue/commentQueueRunner')

function registerIpcHandlers() {
  // ─── Config ──────────────────────────────────────────────
  ipcMain.handle('config:get', () => store.store)
  ipcMain.handle('config:set', (_, data) => { store.set(data); return true })

  // ─── Dialogs ─────────────────────────────────────────────
  ipcMain.handle('dialog:openFile', async (_, filters) => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile'],
      filters: filters || [{ name: 'All Files', extensions: ['*'] }],
    })
    return result.filePaths[0] || null
  })

  ipcMain.handle('dialog:openDir', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory'],
    })
    return result.filePaths[0] || null
  })

  ipcMain.handle('shell:openExternal', (_, url) => shell.openExternal(url))

  // ─── Google Sheets (multi-channel) ──────────────────────
  ipcMain.handle('sheets:test', async (_, channelId) => {
    try {
      const channel = sheetsService.getChannel(channelId)
      const rows = await sheetsService.fetchPendingRowsForChannel(channel)
      return { ok: true, count: rows.length }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('sheets:fetch', async (_, channelId) => {
    try {
      const channel = sheetsService.getChannel(channelId)
      const rows = await sheetsService.fetchPendingRowsForChannel(channel)
      return { ok: true, rows }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('sheets:fetchCommentReady', async (_, channelId) => {
    try {
      const channel = sheetsService.getChannel(channelId)
      const rows = await sheetsService.fetchCommentReadyRowsForChannel(channel)
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
        const rows = await sheetsService.fetchPendingRowsForChannel(ch)
        results[ch.id] = { ok: true, rows }
      } catch (e) {
        results[ch.id] = { ok: false, error: e.message, rows: [] }
      }
    }
    return results
  })

  // ─── Scheduler ───────────────────────────────────────────
  ipcMain.handle('scheduler:start', () => schedulerService.startScheduler())
  ipcMain.handle('scheduler:stop', () => schedulerService.stopScheduler())
  ipcMain.handle('scheduler:getState', () => schedulerService.getSchedulerState())

  // ─── Upload control ──────────────────────────────────────
  ipcMain.handle('upload:runNow', async (_, channelId) => {
    if (queueRunner.getIsRunning()) return { ok: false, error: 'Đang chạy rồi' }
    // force=true: BỎ QUA check giờ, đăng ngay lập tức
    queueRunner.runUploadQueue(true, channelId || null)
    return { ok: true }
  })

  ipcMain.handle('upload:runScheduled', async (_, channelId) => {
    if (queueRunner.getIsRunning()) return { ok: false, error: 'Đang chạy rồi' }
    // force=false: CHECK giờ scheduled_at — chỉ đăng khi đến giờ
    sendLog('Chạy theo lịch — chỉ đăng video đến giờ...', 'info')
    queueRunner.runUploadQueue(false, channelId || null)
    return { ok: true }
  })

  ipcMain.handle('upload:stop', async () => {
    await queueRunner.stopRun()
    return { ok: true }
  })

  // ─── Comment control ─────────────────────────────────────
  ipcMain.handle('comment:runNow', async (_, channelId) => {
    if (commentQueueRunner.getIsRunning()) return { ok: false, error: 'Đang chạy rồi' }
    commentQueueRunner.runCommentQueue(channelId || null)
    return { ok: true }
  })

  ipcMain.handle('comment:stop', async () => {
    await commentQueueRunner.stopRun()
    return { ok: true }
  })
}

module.exports = { registerIpcHandlers }
