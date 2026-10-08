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
const { fetchPendingRowsForChannel, updateRowStatusForChannel, writeRowErrorForChannel } = require('../services/sheetsService')
const { acquireBrowser, releaseBrowser, getBrowser } = require('../browser/browserConnection')
const { ACTION_TYPES, createAction } = require('../automation/actionRegistry')

let isRunning = false
// Owner key of the run currently holding the shared CDP connection
let currentOwner = null
let runSeq = 0

function getIsRunning() {
  return isRunning
}

async function stopRun() {
  isRunning = false
  // Release (not close!) the CDP connection: if no other queue holds it,
  // this disconnects and interrupts the in-flight action. Chrome stays open.
  if (currentOwner) await releaseBrowser(currentOwner)
  sendStatus('idle')
  sendLog('Đã dừng upload', 'warn')
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

  const owner = currentOwner = `upload#${++runSeq}`
  try {
    await acquireBrowser(owner)
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
        // Định dạng ngày do người dùng cấu hình theo từng kênh (tick "kiểu
        // Việt Nam"), không tự đoán. Chưa cấu hình → mặc định kiểu Việt Nam.
        const parseOpts = { vietnameseFormat: channel.dateFormatVN !== false }
        const fmtLabel = parseOpts.vietnameseFormat ? 'Việt Nam D/M/YYYY' : 'Mỹ M/D/YYYY'
        let notYet = 0
        let invalid = 0
        const due = rows.filter(r => {
          if (force) return true
          if (!r.scheduled_at) return true
          const t = parseScheduledAt(r.scheduled_at, parseOpts)
          if (!t) {
            // Không hiểu được ngày giờ → KHÔNG đăng (trước đây "chạy ngay" là
            // đoán ý người dùng, rủi ro đăng sớm hàng loạt nếu chọn sai định dạng)
            invalid++
            sendLog(`[${channel.name}] ⚠ "${r.file_name}": không hiểu ngày giờ "${r.scheduled_at}" theo định dạng ${fmtLabel} → BỎ QUA dòng này (kiểm tra ô scheduled_at hoặc tick định dạng ngày của kênh)`, 'warn')
            return false
          }
          const isDue = t <= now
          if (!isDue) notYet++
          debugLog(`[${r.file_name}] ${r.scheduled_at} → ${t.toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})} due=${isDue}`)
          return isDue
        })

        if (!force) {
          sendLog(`[${channel.name}] ${rows.length} pending: ${due.length} đã đến giờ, ${notYet} chưa đến giờ, ${invalid} sai định dạng (đang hiểu ngày theo ${fmtLabel})`, 'info')
        }

        if (due.length === 0) {
          const next = rows
            .map(r => ({ ...r, _t: parseScheduledAt(r.scheduled_at, parseOpts) }))
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
            const fbVideoId = await createAction(ACTION_TYPES.REEL_UPLOAD, { browser: await getBrowser(), channel, row }).run()
            await updateRowStatusForChannel(channel, row.rowIndex, 'posted', fbVideoId)
            sendLog(`[${channel.name}] ✓ Đã đăng: ${row.file_name}`, 'ok')
            getMainWindow()?.webContents.send('row:done', {
              channelId: channel.id,
              rowIndex: row.rowIndex,
              fbVideoId,
            })
          } catch (e) {
            sendLog(`[${channel.name}] ✗ Lỗi ${row.file_name}: ${e.message}`, 'error')
            // Ghi nội dung lỗi vào Sheet (cột H) để theo dõi; việc ghi này mà
            // lỗi cũng không được làm dừng các dòng còn lại.
            try {
              await writeRowErrorForChannel(channel, row.rowIndex, e.message)
            } catch (we) {
              sendLog(`[${channel.name}] ⚠ Không ghi được lỗi vào Sheet (dòng ${row.rowIndex}): ${we.message}`, 'warn')
            }
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
  } finally {
    // Always give the connection back, even on error/stop, so idle = 0 connections
    await releaseBrowser(owner)
    if (currentOwner === owner) currentOwner = null
  }

  isRunning = false
  sendStatus('idle')
  sendLog('Hoàn tất tất cả kênh.', 'ok')
}

module.exports = { runUploadQueue, getIsRunning, stopRun }
