// ============================================================
//  sheetsService — đọc/ghi Google Sheet cho từng kênh.
// ============================================================
const fs = require('fs')
const { google } = require('googleapis')
const store = require('../store')

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

  // Chỉ giữ lại dòng status=pending — các trạng thái khác (bản nháp,
  // posted, error...) bị bỏ qua NGAY tại đây, không dựng object / không
  // đưa vào danh sách trả về, tránh phình bộ nhớ khi sheet có nhiều dòng
  // lịch sử đã đăng hoặc nháp chưa dùng tới.
  const result = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const status = row[6] || 'pending'
    if (status !== 'pending') continue

    const file_name = row[1] || ''
    if (!file_name) continue

    result.push({
      rowIndex:     i + 1,
      channelId:    channel.id,
      channelName:  channel.name,
      seq:          row[0] || '',
      file_name,
      file_path:    row[2] || '',
      scheduled_at: row[3] || '',
      caption:      row[4] || '',
      description:  row[5] || '',
      status,
      fb_video_id:  row[7] || '',
    })
  }
  return result
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

// ─── Ghi lỗi vào Sheet để theo dõi (không phải mở logfile) ──────
const MAX_ERROR_LEN = 300

// "LỖI <giờ VN>: <nội dung>" — gom về 1 dòng, cắt ngắn cho dễ đọc. Luôn bắt
// đầu bằng chữ nên không bao giờ bị Sheets hiểu nhầm là công thức (=...)
// dù ghi bằng USER_ENTERED.
function formatErrorForSheet(message) {
  const ts = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })
  const text = String(message || 'Lỗi không xác định').replace(/\s+/g, ' ').trim()
  const body = text.length > MAX_ERROR_LEN ? text.slice(0, MAX_ERROR_LEN - 1) + '…' : text
  return `LỖI ${ts}: ${body}`
}

// Đăng bài lỗi: G = 'error', H (fb_video_id) = nội dung lỗi, I (reel_link) = rỗng.
// KHÔNG dùng updateRowStatusForChannel vì hàm đó dựng reel_link từ cột ID.
async function writeRowErrorForChannel(channel, rowIndex, message) {
  const sheets = await getSheetsClient()
  await sheets.spreadsheets.values.update({
    spreadsheetId: channel.sheetId,
    range: `${channel.sheetTab}!G${rowIndex}:I${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['error', formatErrorForSheet(message), '']] },
  })
}

// Comment lỗi: chỉ ghi K (comment_id) = nội dung lỗi, giữ nguyên status
// 'posted' (video vẫn đã đăng). Cột K khác rỗng nên fetchCommentReady...
// sẽ KHÔNG tự thử lại — muốn comment lại thì xoá ô K.
async function writeCommentErrorForChannel(channel, rowIndex, message) {
  const sheets = await getSheetsClient()
  await sheets.spreadsheets.values.update({
    spreadsheetId: channel.sheetId,
    range: `${channel.sheetTab}!K${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[formatErrorForSheet(message)]] },
  })
}

// Lấy các dòng đã đăng xong (status=posted), có link Facebook sẵn sàng
// (cột I) và có nội dung bình luận đầu tiên (cột J) nhưng CHƯA bình luận
// (cột K comment_id còn rỗng) — tránh bình luận lặp lại ở lượt quét sau.
async function fetchCommentReadyRowsForChannel(channel) {
  if (!channel.sheetId) throw new Error(`Channel "${channel.name}": chưa cấu hình Sheet ID`)
  const sheets = await getSheetsClient()

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: channel.sheetId,
    range: `${channel.sheetTab}!A:K`,
  })

  const rows = res.data.values || []
  if (rows.length < 2) return []

  const result = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const status = row[6] || ''
    if (status !== 'posted') continue

    const reel_link = row[8] || ''
    const first_comment = row[9] || ''
    const comment_id = row[10] || ''
    if (!reel_link || !first_comment || comment_id) continue

    result.push({
      rowIndex:     i + 1,
      channelId:    channel.id,
      channelName:  channel.name,
      seq:          row[0] || '',
      file_name:    row[1] || '',
      status,
      fb_video_id:  row[7] || '',
      reel_link,
      first_comment,
      comment_id,
    })
  }
  return result
}

// Ghi lại kết quả bình luận: G = status ('commented'), K = comment_id.
async function updateRowCommentForChannel(channel, rowIndex, status, commentId = '') {
  const sheets = await getSheetsClient()
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: channel.sheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `${channel.sheetTab}!G${rowIndex}`, values: [[status]] },
        { range: `${channel.sheetTab}!K${rowIndex}`, values: [[commentId]] },
      ],
    },
  })
}

module.exports = {
  getChannel,
  getSheetsClient,
  fetchPendingRowsForChannel,
  updateRowStatusForChannel,
  fetchCommentReadyRowsForChannel,
  updateRowCommentForChannel,
  writeRowErrorForChannel,
  writeCommentErrorForChannel,
  formatErrorForSheet,
}
