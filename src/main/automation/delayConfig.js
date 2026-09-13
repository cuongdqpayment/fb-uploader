// ============================================================
//  delayConfig — cấu hình delay cho luồng đăng Reels.
//  Đơn vị: mili giây, TRỪ *Min viết là "phút" (safeToPostTimeoutMin,
//  waitAfterPublishMin) ghi rõ trong tên field.
//
//  DEFAULTS dùng khi tab Cấu hình → Delay Upload CHƯA lưu gì
//  (store.delay rỗng/không có) — đây cũng là hành vi đang chạy hiện
//  tại. Khi người dùng chỉnh + bấm Lưu ở màn Cấu hình, giá trị đó
//  ghi vào store.delay và ĐÈ lên default tương ứng ngay từ lượt
//  đăng kế tiếp — không cần khởi động lại app.
// ============================================================
const store = require('../store')

const DEFAULTS = {
  safeToPostTimeoutMin: 10,   // phút — timeout chờ "an toàn để đăng"
  afterFileSelect:      0,    // ms  — chờ thêm ngay sau khi inject file xong
  beforeNext1Min:       2000,
  beforeNext1Max:       4500,
  afterNext1:           4500,
  beforeNext2Min:       2500,
  beforeNext2Max:       5000,
  afterNext2:           5000,
  beforeDescription:    5000,
  afterDescription:     5000,
  beforePublishMin:     3500,
  beforePublishMax:     5000,
  waitAfterPublishMin:  0,    // phút — chờ thêm trước khi bắt đầu vòng refresh tìm link
  refreshAttempts:      5,
  refreshInterval:      30000,
}

// Đọc cấu hình delay hiện hành: DEFAULTS + override đã lưu ở
// store.delay (SettingsPage ghi vào đây). Gọi lại ở đầu mỗi lượt
// đăng để luôn lấy giá trị mới nhất — không cache.
function getDelay() {
  const overrides = store.get('delay') || {}
  const merged = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const v = overrides[key]
    if (Number.isFinite(v)) merged[key] = v
  }
  return merged
}

module.exports = { getDelay, DEFAULTS }
