// ============================================================
//  commentQueueRunner — với mỗi kênh đang bật, lấy các dòng đã
//  đăng xong (status=posted, có reel_link) và có nội dung
//  first_comment nhưng CHƯA bình luận (comment_id rỗng), lần lượt
//  chạy CommentAction rồi ghi lại comment_id + status=commented.
//
//  Cùng khuôn mẫu với uploadQueueRunner.js — giữ state isRunning/
//  browser riêng, KHÔNG chia sẻ với queue upload, để 2 luồng có
//  thể dừng/theo dõi độc lập.
// ============================================================
const store = require('../store')
const { sendLog, sendStatus } = require('../logger')
const { getMainWindow } = require('../windowState')
const { sleep } = require('../utils/sleep')
const { fetchCommentReadyRowsForChannel, updateRowCommentForChannel, writeCommentErrorForChannel } = require('../services/sheetsService')
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
  sendLog('Đã dừng bình luận', 'warn')
}

async function runCommentQueue(targetChannelId = null) {
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

  const owner = currentOwner = `comment#${++runSeq}`
  try {
    await acquireBrowser(owner)
    sendLog('Đã kết nối Chrome ✓', 'ok')

    for (const channel of activeChannels) {
      if (!isRunning) break
      sendLog(`── Kênh: ${channel.name} (bình luận) ──`, 'info')

      try {
        const rows = await fetchCommentReadyRowsForChannel(channel)
        if (rows.length === 0) {
          sendLog(`[${channel.name}] Không có bài nào cần bình luận.`, 'info')
          continue
        }

        sendLog(`[${channel.name}] ${rows.length} bài sẽ bình luận.`, 'ok')

        for (const row of rows) {
          if (!isRunning) break

          sendLog(`[${channel.name}] Bình luận: ${row.reel_link}`, 'info')
          getMainWindow()?.webContents.send('comment:processing', {
            channelId: channel.id,
            rowIndex: row.rowIndex,
          })

          try {
            const commentId = await createAction(ACTION_TYPES.COMMENT, { browser: await getBrowser(), channel, row }).run()
            await updateRowCommentForChannel(channel, row.rowIndex, 'commented', commentId || '')
            sendLog(`[${channel.name}] ✓ Đã bình luận${commentId ? ` (id=${commentId})` : ' (không rõ ID)'}`, 'ok')
            getMainWindow()?.webContents.send('comment:done', {
              channelId: channel.id,
              rowIndex: row.rowIndex,
              commentId,
            })
          } catch (e) {
            sendLog(`[${channel.name}] ✗ Lỗi bình luận ${row.reel_link}: ${e.message}`, 'error')
            // Ghi lỗi vào cột K (comment_id) để theo dõi. Bỏ qua nếu người
            // dùng vừa bấm Dừng (lỗi do bị ngắt, không phải lỗi thật) — ghi vào
            // sẽ khoá việc tự thử lại bình luận dòng này.
            if (isRunning) {
              try {
                await writeCommentErrorForChannel(channel, row.rowIndex, e.message)
              } catch (we) {
                sendLog(`[${channel.name}] ⚠ Không ghi được lỗi vào Sheet (dòng ${row.rowIndex}): ${we.message}`, 'warn')
              }
            }
            getMainWindow()?.webContents.send('comment:error', {
              channelId: channel.id,
              rowIndex: row.rowIndex,
              error: e.message,
            })
          }

          if (isRunning && rows.indexOf(row) < rows.length - 1) {
            const delay = (store.get('delayBetween') || 15) * 1000
            sendLog(`Nghỉ ${delay / 1000}s...`, 'info')
            await sleep(delay)
          }
        }

        if (isRunning && activeChannels.indexOf(channel) < activeChannels.length - 1) {
          sendLog('Chờ 10s trước kênh tiếp theo...', 'info')
          await sleep(10000)
        }

      } catch (e) {
        sendLog(`[${channel.name}] Lỗi: ${e.message}`, 'error')
      }
    }
  } catch (e) {
    sendLog(`Lỗi nghiêm trọng: ${e.message}`, 'error')
  } finally {
    // Always give the connection back, even on error/stop, so idle = 0 connections
    await releaseBrowser(owner)
    if (currentOwner === owner) currentOwner = null
  }

  isRunning = false
  sendStatus('idle')
  sendLog('Hoàn tất bình luận tất cả kênh.', 'ok')
}

module.exports = { runCommentQueue, getIsRunning, stopRun }
