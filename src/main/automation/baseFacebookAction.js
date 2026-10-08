// ============================================================
//  BaseFacebookAction — lớp nền cho MỌI hành động tự động trên
//  Facebook (đăng Reels, đăng bài viết, đăng bản tin, comment...).
//
//  Mỗi action con chỉ cần:
//    1. Override getter `actionName` (tên hiển thị trong log)
//    2. Override method `execute()` — chứa logic riêng của action đó
//
//  Phần dùng chung cho mọi action (lấy/tạo tab facebook.com, switch
//  đúng Trang, log có tiền tố tên kênh) nằm hết ở đây — KHÔNG lặp
//  lại ở từng action con. Xem reelUploadAction.js làm ví dụ.
// ============================================================
const { sendLog } = require('../logger')
const { sleep } = require('../utils/sleep')
const { switchToPage } = require('../browser/pageNavigator')

class BaseFacebookAction {
  /**
   * @param {object} params
   * @param {import('puppeteer-core').Browser} params.browser
   * @param {object} params.channel - cấu hình kênh (name, pageUrl, ...)
   * @param {object} params.row - dòng dữ liệu từ Google Sheet (caption, file_name, ...)
   */
  constructor({ browser, channel, row }) {
    this.browser = browser
    this.channel = channel
    this.row = row
    this.page = null
  }

  // Tên hành động hiển thị trong log — override ở class con
  get actionName() {
    return this.constructor.name
  }

  // Log có tiền tố tên kênh — dùng thống nhất trong mọi action
  log(message, type = 'info') {
    sendLog(`[${this.channel.name}] ${message}`, type)
  }

  // Lấy tab facebook.com đang mở, hoặc tạo mới nếu chưa có
  async _getOrCreateFacebookPage() {
    const pages = await this.browser.pages()
    let page = pages.find(p => p.url().includes('facebook.com')) || null
    if (!page) {
      page = await this.browser.newPage()
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
        window.chrome = { runtime: {} }
      })
    }
    return page
  }

  // Đảm bảo đang đứng đúng Trang (channel) trước khi thao tác
  async _switchToChannel() {
    this.log(`Switch sang tài khoản: ${this.channel.name}...`)
    await this.page.goto('https://www.facebook.com', { waitUntil: 'networkidle2', timeout: 30000 })
    await sleep(2000)

    // QUAN TRỌNG: switchToPage() trả về true/false — PHẢI kiểm tra, nếu
    // không thì kể cả khi switch thất bại (sai kênh/không tìm thấy), code
    // vẫn tiếp tục đăng bài như bình thường, dẫn tới đăng NHẦM kênh hoặc
    // lỗi "không tìm thấy nút..." khó hiểu ở bước sau (đã từng xảy ra).
    const switched = await switchToPage(this.page, this.channel)
    if (!switched) {
      throw new Error(`Không thể chuyển sang đúng kênh "${this.channel.name}" — dừng lại để tránh đăng nhầm kênh khác`)
    }

    const freshPages = await this.browser.pages()
    this.page = freshPages.find(p => p.url().includes('facebook.com')) || this.page
    this.log(`Đã switch sang "${this.channel.name}" ✓`, 'ok')
    await sleep(2000)
  }

  // Template method — KHÔNG override ở class con, chỉ override execute()
  async run() {
    this.page = await this._getOrCreateFacebookPage()
    await this._switchToChannel()
    return this.execute()
  }

  // Bắt buộc override ở class con: chứa logic riêng của từng loại hành động
  async execute() {
    throw new Error(`${this.constructor.name} chưa triển khai execute()`)
  }
}

module.exports = BaseFacebookAction
