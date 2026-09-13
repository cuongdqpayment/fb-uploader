// ============================================================
//  CommentAction — khung sẵn cho tính năng "comment tự động"
//  trên 1 bài viết/Reel có sẵn của Trang.
//  CHƯA triển khai — kế thừa BaseFacebookAction, xem ghi chú
//  trong postAction.js để biết các thứ đã có sẵn.
//
//  Khác biệt: action này cần điều hướng tới URL của MỘT bài viết
//  cụ thể (không phải trang Reels/Timeline chung) — dòng Sheet
//  cho action này nên có thêm cột post_url + comment_text.
//
//  Gợi ý luồng khi triển khai:
//   1. this.page.goto(this.row.post_url)
//   2. Bấm ô "Viết bình luận..." (thường là [contenteditable="true"]
//      hoặc [aria-label chứa "bình luận"])
//   3. Gõ/paste nội dung comment (this.row.comment_text)
//   4. Enter hoặc bấm nút gửi
// ============================================================
const BaseFacebookAction = require('./baseFacebookAction')

class CommentAction extends BaseFacebookAction {
  get actionName() {
    return `Bình luận: ${this.row?.post_url || ''}`
  }

  async execute() {
    throw new Error('CommentAction chưa được triển khai')
  }
}

module.exports = CommentAction
