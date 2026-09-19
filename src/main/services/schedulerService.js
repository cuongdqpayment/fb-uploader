// ============================================================
//  schedulerService — quản lý cron job chạy nền, dùng chung cho
//  toàn bộ kênh (kích hoạt runUploadQueue theo chu kỳ cấu hình).
// ============================================================
const cron = require('node-cron')
const store = require('../store')
const { sendLog } = require('../logger')
const { getMainWindow } = require('../windowState')

let cronJob = null

async function _tick() {
  // require trễ (lazy) để tránh vòng lặp phụ thuộc lúc load module
  // (uploadQueueRunner/commentQueueRunner không phụ thuộc ngược lại schedulerService)
  const { getIsRunning, runUploadQueue } = require('../queue/uploadQueueRunner')
  const { getIsRunning: getCommentIsRunning, runCommentQueue } = require('../queue/commentQueueRunner')

  try {
    // Đăng video trước — chỉ video đến giờ (force=false)
    if (!getIsRunning()) await runUploadQueue(false)
    // Sau đó quét bình luận: các dòng đã posted + có first_comment sẽ
    // được bình luận ngay, không phụ thuộc scheduled_at.
    if (!getCommentIsRunning()) await runCommentQueue()
  } catch (e) {
    sendLog(`Scheduler tick lỗi: ${e.message}`, 'error')
  }
}

// Chỉ dừng timer cron trong bộ nhớ — KHÔNG đổi cờ đã lưu trong store.
// Dùng khi app thoát (before-quit): lần mở app sau vẫn tự khôi phục
// nếu trước đó người dùng đã bật scheduler.
function stopCronTimer() {
  if (cronJob) {
    try { cronJob.stop() } catch (_) {}
    cronJob = null
  }
}

function startScheduler() {
  const cronExpr = store.get('scheduleCron') || '*/15 * * * *'
  stopCronTimer()
  cronJob = cron.schedule(cronExpr, _tick)
  store.set('schedulerEnabled', true) // Lưu trạng thái
  sendLog(`Scheduler started: ${cronExpr}`, 'ok')
  return { ok: true }
}

function stopScheduler() {
  stopCronTimer()
  store.set('schedulerEnabled', false) // Lưu trạng thái
  sendLog('Scheduler stopped', 'warn')
  return { ok: true }
}

function getSchedulerState() {
  return { enabled: !!cronJob && store.get('schedulerEnabled') === true }
}

// Gọi 1 lần lúc app khởi động — tự bật lại cron nếu trước đó đang bật
function restoreSchedulerIfEnabled() {
  if (!store.get('schedulerEnabled')) return
  const cronExpr = store.get('scheduleCron') || '*/15 * * * *'
  stopCronTimer()
  cronJob = cron.schedule(cronExpr, _tick)
  // Thông báo sau khi window sẵn sàng
  setTimeout(() => {
    sendLog(`Scheduler auto-restored: ${cronExpr}`, 'ok')
    const win = getMainWindow()
    if (win) win.webContents.send('scheduler:state', true)
  }, 3000)
}

module.exports = {
  startScheduler,
  stopScheduler,
  stopCronTimer,
  getSchedulerState,
  restoreSchedulerIfEnabled,
}
