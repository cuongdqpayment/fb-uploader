// ============================================================
//  CommentAction — bình luận đầu tiên vào 1 Reel đã đăng, lấy từ
//  cột first_comment. Yêu cầu row có sẵn reel_link (đã đăng xong).
//
//  Luồng (theo debug DOM thực tế của Facebook):
//   1. this.page.goto(this.row.reel_link)
//   2. Bấm icon "Bình luận" (svg bong bóng chat) nếu ô nhập chưa mở sẵn
//   3. Gõ nội dung vào ô [contenteditable="true"][aria-label*="Bình luận dưới tên"]
//   4. Chờ nút [aria-label="Đăng bình luận"] hết aria-disabled rồi click
//   5. Xác định comment id: ưu tiên bắt qua network response (GraphQL),
//      fallback quét DOM tìm link mới có "comment_id=" chưa từng thấy
//      trước khi gửi.
// ============================================================
const { sleep } = require('../utils/sleep')
const BaseFacebookAction = require('./baseFacebookAction')

// Phần đầu path của svg icon "Bình luận" (bong bóng chat) — đủ đặc trưng
// để nhận diện, không phụ thuộc class CSS (obfuscated, đổi theo build FB).
const COMMENT_ICON_PATH_HINT = 'M12 .5C18.351.5 23.5 5.649 23.5 12'
const SEND_BUTTON_LABEL = 'Đăng bình luận'

class CommentAction extends BaseFacebookAction {
  get actionName() {
    return `Bình luận: ${this.row?.reel_link || ''}`
  }

  async execute() {
    const link = this.row.reel_link
    if (!link) throw new Error('Dòng không có reel_link')
    const content = (this.row.first_comment || '').trim()
    if (!content) throw new Error('Dòng không có first_comment')

    this.log(`Mở link: ${link}`)
    await this.page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 })
    await sleep(3000)

    await this._openCommentBox()
    await this._typeComment(content)
    const commentId = await this._sendComment()

    if (commentId) {
      this.log(`✓ Đã đăng bình luận, id=${commentId}`, 'ok')
    } else {
      this.log('⚠ Đã bấm gửi nhưng không xác định được comment ID — kiểm tra thủ công', 'warn')
    }
    return commentId || ''
  }

  // Bấm icon "Bình luận" để mở ô nhập liệu — bỏ qua nếu ô đã sẵn sàng
  // (Facebook đôi khi mở sẵn khung bình luận ngay khi vào trang Reel).
  async _openCommentBox() {
    if (await this._commentBoxVisible()) {
      this.log('Ô bình luận đã sẵn sàng ✓')
      return
    }

    this.log('Tìm nút "Bình luận"...')
    const clicked = await this.page.evaluate((pathHint) => {
      const byAria = document.querySelector(
        '[aria-label="Bình luận"][role="button"], [aria-label*="bình luận" i][role="button"], [aria-label="Comment"][role="button"]'
      )
      let target = byAria
      if (!target) {
        const svg = [...document.querySelectorAll('svg')].find(s => {
          const path = s.querySelector('path')
          return path && path.getAttribute('d')?.startsWith(pathHint)
        })
        target = svg || null
      }
      if (!target) return false

      let clickTarget = target
      let node = target
      for (let i = 0; i < 10; i++) {
        if (node.getAttribute?.('role') === 'button') { clickTarget = node; break }
        if (!node.parentElement) break
        node = node.parentElement
      }
      clickTarget.scrollIntoView({ behavior: 'instant', block: 'center' })
      clickTarget.click()
      return true
    }, COMMENT_ICON_PATH_HINT)

    if (!clicked) throw new Error('Không tìm thấy nút "Bình luận"')
    this.log('Đã click nút "Bình luận" ✓', 'ok')

    const ready = await this._waitForCommentBox(10000)
    if (!ready) throw new Error('Ô nhập bình luận không xuất hiện sau khi click')
  }

  async _commentBoxVisible() {
    return this.page.evaluate(() => {
      const box = document.querySelector(
        '[contenteditable="true"][aria-label*="Bình luận dưới tên" i], [contenteditable="true"][aria-label*="Comment as" i]'
      )
      return !!box
    })
  }

  async _waitForCommentBox(timeout) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await this._commentBoxVisible()) return true
      await sleep(300)
    }
    return false
  }

  async _findCommentBoxHandle() {
    const handle = await this.page.evaluateHandle(() => {
      return document.querySelector(
        '[contenteditable="true"][aria-label*="Bình luận dưới tên" i], ' +
        '[contenteditable="true"][aria-label*="Comment as" i], ' +
        '[contenteditable="true"][role="textbox"]'
      )
    })
    const el = handle.asElement()
    if (!el) {
      await handle.dispose().catch(() => {})
      return null
    }
    return el
  }

  // Gõ bằng bàn phím thật (không paste) — ô bình luận Facebook coi Enter
  // là "gửi", nên xuống dòng phải dùng Shift+Enter.
  async _typeComment(content) {
    this.log('Điền nội dung bình luận...')
    const box = await this._findCommentBoxHandle()
    if (!box) throw new Error('Không tìm thấy ô nhập bình luận')

    try {
      await box.evaluate(el => el.focus())
      await sleep(200)

      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        await this.page.keyboard.type(lines[i], { delay: 20 })
        if (i < lines.length - 1) {
          await this.page.keyboard.down('Shift')
          await this.page.keyboard.press('Enter')
          await this.page.keyboard.up('Shift')
        }
      }
      await sleep(300)
    } finally {
      await box.dispose().catch(() => {})
    }
    this.log('Đã điền nội dung ✓', 'ok')
  }

  async _sendComment() {
    this.log('Chờ nút "Đăng bình luận" sẵn sàng...')
    const enabled = await this._waitForSendButtonEnabled(10000)
    if (!enabled) throw new Error('Nút "Đăng bình luận" không bật lên — có thể chưa gõ đủ nội dung')

    // Snapshot comment_id đã có trên trang TRƯỚC khi gửi, để phân biệt
    // với comment mới sau khi gửi (dùng cho fallback quét DOM).
    const existingIds = await this._scanCommentIdsFromDom()

    let networkCommentId = null
    const responseHandler = async (response) => {
      try {
        const url = response.url()
        if (!url.includes('facebook.com') || !url.includes('graphql')) return
        const status = response.status()
        if (status < 200 || status >= 300) return
        const text = await response.text().catch(() => '')
        if (!text || text.length < 10) return

        const patterns = [
          /"legacy_fbid"\s*:\s*"?(\d{5,20})"?/,
          /"comment_id"\s*:\s*"?(\d{5,20})"?/,
        ]
        for (const pattern of patterns) {
          const m = text.match(pattern)
          if (m && m[1] && !existingIds.includes(m[1])) {
            networkCommentId = m[1]
            this.log(`✓ Bắt được comment ID từ network: ${networkCommentId}`, 'ok')
            return
          }
        }
      } catch (_) {}
    }
    const page = this.page
    page.on('response', responseHandler)
    // Remove the listener on every path (error/timeout/stop) — the tab is reused
    try {
      this.log('Click "Đăng bình luận"...')
      const clicked = await page.evaluate((label) => {
        const el = document.querySelector(`[aria-label="${label}"][role="button"]`)
        if (!el) return false
        if (el.getAttribute('aria-disabled') === 'true') return false
        el.scrollIntoView({ behavior: 'instant', block: 'center' })
        el.click()
        return true
      }, SEND_BUTTON_LABEL)

      if (!clicked) {
        throw new Error('Không click được nút "Đăng bình luận"')
      }
      this.log('Đã click "Đăng bình luận" ✓', 'ok')

      for (let i = 0; i < 20 && !networkCommentId; i++) {
        await sleep(500)
      }
    } finally {
      page.off('response', responseHandler)
    }

    if (networkCommentId) return networkCommentId

    // Fallback: quét lại DOM tìm comment_id mới xuất hiện (chưa có trong snapshot)
    this.log('Network không bắt được ID — quét DOM tìm comment mới...', 'warn')
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(1000)
      const currentIds = await this._scanCommentIdsFromDom()
      const newIds = currentIds.filter(id => !existingIds.includes(id))
      if (newIds.length > 0) {
        this.log(`✓ Tìm được comment ID mới qua DOM: ${newIds[0]}`, 'ok')
        return newIds[0]
      }
    }

    return null
  }

  async _waitForSendButtonEnabled(timeout) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const enabled = await this.page.evaluate((label) => {
        const el = document.querySelector(`[aria-label="${label}"][role="button"]`)
        if (!el) return false
        return el.getAttribute('aria-disabled') !== 'true'
      }, SEND_BUTTON_LABEL)
      if (enabled) return true
      await sleep(300)
    }
    return false
  }

  async _scanCommentIdsFromDom() {
    return this.page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href*="comment_id="]')]
      const ids = links.map(a => {
        try {
          return new URL(a.href).searchParams.get('comment_id')
        } catch (_) {
          return null
        }
      }).filter(Boolean)
      return [...new Set(ids)]
    })
  }
}

module.exports = CommentAction
