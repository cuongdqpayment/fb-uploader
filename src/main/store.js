// ============================================================
//  store — cấu hình persistent (electron-store)
// ============================================================
const Store = require('electron-store')

const store = new Store({
  defaults: {
    // Global settings
    serviceAccountPath: '',
    chromePath: '',
    chromeStartScript: '', // Script khởi động Chrome (VD: ~/start-fb-uploader.sh)
    scheduleCron: '*/15 * * * *',
    delayBetween: 15,
    headless: false,
    // Multi-channel: mảng các kênh
    channels: [
      {
        id: 'channel_1',
        name: 'Kênh 1',
        enabled: true,
        sheetId: '',
        sheetTab: 'upload_facebook',
        pageUrl: '',
        videoBaseDir: '',
        // true = tài khoản cá nhân chưa bật Chế độ chuyên nghiệp (Facebook
        // không quét bản quyền) → bỏ qua chờ "an toàn để đăng", chỉ chờ
        // nút "Tiếp" tự bật lên. Xem automation/reelUploadAction.js.
        skipCopyrightCheck: false,
      }
    ],
  }
})

module.exports = store
