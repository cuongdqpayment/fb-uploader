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
}
