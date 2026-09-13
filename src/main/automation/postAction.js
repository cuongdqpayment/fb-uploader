// ============================================================
//  PostAction — khung sẵn cho tính năng "đăng bài viết" (status
//  post lên Timeline của Trang, có thể kèm ảnh/video).
//  CHƯA triển khai — kế thừa BaseFacebookAction nên đã có sẵn:
//    - this.page: tab facebook.com
//    - this.channel / this.row
//    - đã tự switch đúng Trang trước khi execute() chạy
//    - this.log(...) để log có tiền tố tên kênh
//
//  Gợi ý luồng khi triển khai (tham khảo reelUploadAction.js):
//   1. this.page.goto(this.channel.pageUrl)
//   2. Bấm ô "Bạn đang nghĩ gì?" để mở composer bài viết
//   3. Điền nội dung: this.row.caption / this.row.description
//   4. (Tuỳ chọn) đính kèm ảnh/video — dùng page.waitForFileChooser()
//      giống _selectAndUploadFile() trong ReelUploadAction
//   5. Bấm "Đăng" — dùng clickButtonByText() từ ./domUtils
//   6. Lấy post id (bắt qua network response hoặc parse URL sau khi đăng)
// ============================================================
const BaseFacebookAction = require('./baseFacebookAction')

class PostAction extends BaseFacebookAction {
  get actionName() {
    return `Đăng bài viết: ${this.row?.caption || this.row?.file_name || ''}`
  }

  async execute() {
    throw new Error('PostAction chưa được triển khai')
  }
}

module.exports = PostAction
