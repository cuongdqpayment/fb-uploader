// ============================================================
//  uploadQueueRunner — orchestration: với mỗi kênh đang bật, lấy
//  danh sách video pending từ Sheet, lọc theo giờ đăng (nếu không
//  force), rồi lần lượt chạy action tương ứng (mặc định: đăng Reels)
//  và ghi kết quả ngược lại Sheet.
//
//  Đây là nơi DUY NHẤT giữ state isRunning/browser của 1 lượt chạy —
//  ipc handlers và scheduler đều thao tác qua các hàm export ở đây,
//  không tự giữ biến riêng để tránh lệch trạng thái.
// ============================================================
const store = require('../store')
const { sendLog, debugLog, sendStatus } = require('../logger')
const { getMainWindow } = require('../windowState')
const { sleep } = require('../utils/sleep')
const { parseScheduledAt } = require('../utils/dateTime')
const { fetchPendingRowsForChannel, updateRowStatusForChannel } = require('../services/sheetsService')
const { launchBrowser } = require('../browser/browserManager')
const { ACTION_TYPES, createAction } = require('../automation/actionRegistry')

let isRunning = false
let browser = null

function getIsRunning() {
  return isRunning
}

async function stopRun() {
  isRunning = false
  if (browser) {
    await browser.close().catch(() => {})
    browser = null
  }
  sendStatus('idle')
  sendLog('Đã dừng upload', 'warn')
}

// Gọi khi app thoát (before-quit) — đóng Chrome đang giữ nếu có
async function closeBrowserOnQuit() {
  if (browser) await browser.close().catch(() => {})
}

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
          getMainWindow()?.webContents.send('row:processing', {
            channelId: channel.id,
            rowIndex: row.rowIndex,
          })

          try {
            const fbVideoId = await createAction(ACTION_TYPES.REEL_UPLOAD, { browser, channel, row }).run()
            await updateRowStatusForChannel(channel, row.rowIndex, 'posted', fbVideoId)
            sendLog(`[${channel.name}] ✓ Đã đăng: ${row.file_name}`, 'ok')
            getMainWindow()?.webContents.send('row:done', {
              channelId: channel.id,
              rowIndex: row.rowIndex,
              fbVideoId,
            })
          } catch (e) {
            await updateRowStatusForChannel(channel, row.rowIndex, 'error')
            sendLog(`[${channel.name}] ✗ Lỗi ${row.file_name}: ${e.message}`, 'error')
            getMainWindow()?.webContents.send('row:error', {
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

module.exports = { runUploadQueue, getIsRunning, stopRun, closeBrowserOnQuit }
