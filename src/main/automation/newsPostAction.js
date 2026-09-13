// ============================================================
//  NewsPostAction — khung sẵn cho tính năng "đăng bản tin"
//  (VD: chia sẻ link tin tức kèm caption lên Timeline của Trang).
//  CHƯA triển khai — kế thừa BaseFacebookAction, xem ghi chú
//  trong postAction.js để biết các thứ đã có sẵn (this.page,
//  this.channel, this.row, this.log, đã tự switch đúng Trang).
//
//  Khác biệt so với PostAction: dòng Sheet cho action này nên có
//  thêm 1 cột link nguồn (VD: news_url) — cân nhắc mở rộng
//  fetchPendingRowsForChannel() ở services/sheetsService.js khi
//  triển khai thật, KHÔNG đổi cấu trúc cột hiện có của luồng Reels.
// ============================================================
const BaseFacebookAction = require('./baseFacebookAction')

class NewsPostAction extends BaseFacebookAction {
  get actionName() {
    return `Đăng bản tin: ${this.row?.caption || this.row?.file_name || ''}`
  }

  async execute() {
    throw new Error('NewsPostAction chưa được triển khai')
  }
}

module.exports = NewsPostAction
