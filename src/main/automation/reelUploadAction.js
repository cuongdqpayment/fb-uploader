// ============================================================
//  ReelUploadAction — đăng 1 video dạng Reels lên đúng Trang.
//  Port nguyên vẹn từ uploadVideoToFacebook() (index.js cũ),
//  chỉ tách thành các bước (method) trong 1 class kế thừa
//  BaseFacebookAction để dễ đọc / dễ sửa từng bước riêng lẻ.
// ============================================================
const fs = require('fs')
const { debugLog } = require('../logger')
const { sleep } = require('../utils/sleep')
const { resolveFilePath } = require('../utils/filePaths')
const { clickButtonByText, waitForButtonActive, waitForButtonEnabled, humanDelay, humanDelayLog } = require('./domUtils')
const { getDelay } = require('./delayConfig')
const { buildPostContent } = require('./contentBuilder')
const BaseFacebookAction = require('./baseFacebookAction')

class ReelUploadAction extends BaseFacebookAction {
  get actionName() {
    return `Đăng Reels: ${this.row.file_name}`
  }

  async execute() {
    // Đọc delay mới nhất từ store — áp dụng ngay thay đổi ở tab
    // Cấu hình → Delay Upload cho lượt đăng này (không cache lại).
    this.delay = getDelay()

    const pageUrl = this.channel.pageUrl
    if (!pageUrl) throw new Error(`Kênh "${this.channel.name}": chưa cấu hình Facebook Page URL`)

    const reelsUrl = pageUrl.includes('?')
      ? `${pageUrl}&sk=reels_tab`
      : `${pageUrl}?sk=reels_tab`

    this.log(`Mở trang Reels: ${reelsUrl}`)
    await this.page.goto(reelsUrl, { waitUntil: 'networkidle2', timeout: 60000 })
    await sleep(3000)

    // ── Bước 2: Click nút "Tạo thước phim" ──
    await this._openCreateReelComposer()

    // ── Bước 3+4: Upload file (chặn dialog OS, inject trực tiếp) ──
    await this._selectAndUploadFile()

    // ── Bước 5: Chờ Facebook xử lý xong upload (an toàn để đăng, hoặc
    // với tài khoản cá nhân chưa bật Chế độ chuyên nghiệp: nút "Tiếp" bật) ──
    this.log('Chờ Facebook upload + xử lý xong...')
    await this._waitUntilReadyForNext(this.delay.safeToPostTimeoutMin * 60000)

    await this._clickNextStep(1, this.delay.beforeNext1Min, this.delay.beforeNext1Max, this.delay.afterNext1)

    // ── Bước 7: Chờ "Tiếp" lần 2 sẵn sàng rồi click ──
    this.log('Chờ nút "Tiếp" bước 2 xuất hiện...')
    await this._waitUntilReadyForNext(this.delay.safeToPostTimeoutMin * 60000)
    await this._clickNextStep(2, this.delay.beforeNext2Min, this.delay.beforeNext2Max, this.delay.afterNext2, ' - bỏ qua chỉnh sửa')

    // ── Bước 8: Điền mô tả ──
    await this._fillDescriptionIfPresent()

    // ── Bước 9: Click "Đăng" + xác định video ID ──
    return this._publishAndResolveVideoId(reelsUrl)
  }

  async _openCreateReelComposer() {
    this.log('Tìm nút "Tạo thước phim"...')
    const foundCreate = await this.page.evaluate(() => {
      const span = [...document.querySelectorAll('span')]
        .find(el => el.textContent.trim() === 'Tạo thước phim')
      if (!span) return false
      span.scrollIntoView({ behavior: 'instant', block: 'center' })
      let el = span
      for (let i = 0; i < 10; i++) {
        const tag = el.tagName?.toLowerCase()
        const role = el.getAttribute?.('role')
        if (tag === 'a' || tag === 'button' || role === 'button') { el.click(); return true }
        const style = window.getComputedStyle(el)
        if (style.cursor === 'pointer') { el.click(); return true }
        if (!el.parentElement) break
        el = el.parentElement
      }
      span.click(); return true
    })
    if (!foundCreate) throw new Error('Không tìm thấy nút "Tạo thước phim"')
    this.log('Đã click "Tạo thước phim" ✓', 'ok')
    await sleep(4000)
  }

  async _selectAndUploadFile() {
    this.log(`Upload file: ${this.row.file_name}`)
    const filePath = resolveFilePath(this.row.file_name, this.channel)
    if (!fs.existsSync(filePath)) {
      throw new Error(`File không tồn tại: ${filePath}`)
    }

    // Puppeteer waitForFileChooser() chặn native dialog và inject file trực tiếp
    // Phải set TRƯỚC khi trigger click để bắt được event
    this.log('Chuẩn bị intercept file chooser...')
    const fileChooserPromise = this.page.waitForFileChooser({ timeout: 10000 })

    // Click nút "Tải lên" bằng JS — không dùng tọa độ
    this.log('Tìm nút "Tải lên"...')
    const foundUpload = await this.page.evaluate(() => {
      const span = [...document.querySelectorAll('span')]
        .find(el => ['Tải lên', 'Thêm video', 'Upload'].includes(el.textContent.trim()))
      if (!span) return false
      span.scrollIntoView({ behavior: 'instant', block: 'center' })
      let el = span
      for (let i = 0; i < 10; i++) {
        const tag = el.tagName?.toLowerCase()
        const role = el.getAttribute?.('role')
        if (tag === 'a' || tag === 'button' || role === 'button') { el.click(); return true }
        const style = window.getComputedStyle(el)
        if (style.cursor === 'pointer') { el.click(); return true }
        if (!el.parentElement) break
        el = el.parentElement
      }
      span.click(); return true
    })
    if (!foundUpload) this.log('Không tìm thấy nút "Tải lên" — thử input trực tiếp', 'warn')
    else this.log('Đã click "Tải lên" ✓', 'ok')
    this.log('Đang chờ file chooser...')

    // Đợi file chooser bị intercept (native dialog bị chặn bởi Puppeteer)
    let fileChooser = null
    try {
      fileChooser = await fileChooserPromise
      this.log('File chooser đã bị intercept ✓ (native dialog không mở)', 'ok')
    } catch (e) {
      this.log(`waitForFileChooser timeout: ${e.message}`, 'warn')
      this.log('Thử tìm input file trực tiếp...')
    }

    if (fileChooser) {
      // Inject file qua file chooser — native dialog KHÔNG mở
      await fileChooser.accept([filePath])
      this.log(`File "${this.row.file_name}" đã inject ✓ — Facebook đang upload...`, 'ok')
    } else {
      // Fallback: inject trực tiếp vào input element
      this.log('Fallback: inject trực tiếp vào input[type="file"]...', 'warn')
      await this.page.waitForFunction(
        () => document.querySelectorAll('input[type="file"]').length > 0,
        { timeout: 10000 }
      ).catch(() => {})

      const fileInputEl = await this.page.evaluateHandle(() => {
        const inputs = [...document.querySelectorAll('input[type="file"]')]
        return inputs.find(i => {
          const accept = i.getAttribute('accept') || ''
          return accept.includes('video') || accept.includes('mp4')
        }) || inputs[0] || null
      }).then(h => h.asElement ? h.asElement() : null)

      if (!fileInputEl) throw new Error('Không tìm thấy input file video')
      await fileInputEl.uploadFile(filePath)
      this.log('File inject fallback ✓', 'ok')
    }

    if (this.delay.afterFileSelect > 0) {
      await sleep(this.delay.afterFileSelect)
    }
  }

  // Chọn cách chờ phù hợp trước khi bấm "Tiếp": mặc định chờ text
  // "an toàn để đăng" (Facebook Trang/tài khoản Chuyên nghiệp có quét bản
  // quyền); nếu kênh bật `skipCopyrightCheck` (tài khoản cá nhân CHƯA bật
  // Chế độ chuyên nghiệp thì Facebook không quét bản quyền, text này
  // không bao giờ xuất hiện) → chuyển sang chờ nút "Tiếp" tự bật lên.
  async _waitUntilReadyForNext(timeoutMs) {
    if (this.channel.skipCopyrightCheck) {
      return this._waitUntilNextButtonEnabled(timeoutMs)
    }
    return this._waitUntilSafeToPost(timeoutMs)
  }

  async _waitUntilNextButtonEnabled(timeoutMs) {
    this.log('Bỏ qua quét bản quyền (kênh cá nhân) — chờ nút "Tiếp" bật lên...')
    const ok = await waitForButtonEnabled(this.page, ['Tiếp', 'Next'], timeoutMs)
    if (!ok) {
      throw new Error(`Timeout ${Math.round(timeoutMs / 60000)} phút: nút "Tiếp" không bật lên (upload có thể chưa xong hoặc bị lỗi)`)
    }
    this.log('Nút "Tiếp" đã bật ✓ (coi như an toàn để đăng)', 'ok')
    return true
  }

  // Chờ Facebook hiện "Thước phim của bạn an toàn để đăng!" — tín hiệu
  // chính xác nhất: upload xong + quét bản quyền xong.
  async _waitUntilSafeToPost(timeout = 600000) {
    const page = this.page
    const start = Date.now()
    let lastLog = 0

    const SAFE_MESSAGES = [
      'Thước phim của bạn an toàn để đăng!',
      'Your reel is safe to post!',
      'an toàn để đăng',
      'safe to post',
    ]
    const PROCESSING_MESSAGES = [
      'Đang tải lên',
      'Đang xử lý',
      'Uploading',
      'Processing',
      'Đang kiểm tra',
      'Checking',
    ]

    this.log('Đang chờ Facebook xác nhận an toàn đăng...')

    while (Date.now() - start < timeout) {
      const result = await page.evaluate((safeMsgs, processMsgs) => {
        const allText = document.body.innerText || ''
        for (const msg of safeMsgs) { if (allText.includes(msg)) return { status: 'safe', msg } }
        for (const msg of processMsgs) { if (allText.includes(msg)) return { status: 'processing', msg } }
        return { status: 'waiting' }
      }, SAFE_MESSAGES, PROCESSING_MESSAGES)

      if (result.status === 'safe') {
        this.log(`Facebook xác nhận: "${result.msg}" ✓`, 'ok')
        return true
      }

      const elapsed = Math.round((Date.now() - start) / 1000)
      if (elapsed - lastLog >= 10) {
        lastLog = elapsed
        if (result.status === 'processing') {
          this.log(`[${elapsed}s] Facebook đang xử lý: "${result.msg}"...`)
        } else {
          this.log(`[${elapsed}s] Chờ Facebook upload + quét bản quyền...`)
        }
      }

      await sleep(2000)
    }

    throw new Error('Timeout 10 phút: Facebook chưa xác nhận an toàn đăng')
  }

  // stepNo: 1 hoặc 2 — 2 bước "Tiếp" của composer, cùng 1 logic, khác label/delay
  async _clickNextStep(stepNo, minMs, maxMs, afterMs, extraLabel = '') {
    const delayLabel = stepNo === 1 ? 'beforeNext1' : 'beforeNext2'
    const screenLabel = stepNo === 1 ? 'chỉnh sửa' : 'cài đặt'
    const d = await humanDelayLog(delayLabel, minMs, maxMs)
    this.log(`Click "Tiếp" bước ${stepNo}${extraLabel} (sau delay ${d}ms)...`)
    await clickButtonByText(this.page, ['Tiếp', 'Next'])
    this.log(`Chờ afterNext${stepNo} (${afterMs}ms) — màn ${screenLabel} load...`)
    await sleep(afterMs)
  }

  async _fillDescriptionIfPresent() {
    debugLog(`Chờ beforeDescription (${this.delay.beforeDescription}ms)...`)
    await sleep(this.delay.beforeDescription)

    // Nội dung điền = caption + xuống dòng + description (không chỉ description)
    const content = buildPostContent(this.row)

    if (content) {
      this.log('Điền mô tả thước phim...')

      // Lấy 1 HANDLE DOM cố định duy nhất cho ô mô tả — mọi bước sau (focus,
      // xoá, điền, xác minh) đều thao tác trên ĐÚNG element này. Nếu mỗi bước
      // tự dò lại "ô to nhất trên trang" riêng, khi Facebook render thêm 1 ô
      // khác kích thước tương tự (VD panel gợi ý hashtag sau khi dán có
      // "#mshang #viral") các bước sau có thể trúng NHẦM ô khác → verify sai
      // → chạy fallback chèn thêm vào box ban đầu → chồng nội dung.
      const box = await this._findDescriptionBoxHandle()

      if (box) {
        try {
          // Thử lần lượt 2 cách, dừng ngay khi cách nào xác minh thành công.
          // Cách 1 ưu tiên clipboard vì tránh gợi ý tự động Facebook hiện khi
          // gõ trực tiếp (VD gõ "#" bật dropdown hashtag) — nhưng clipboard
          // cần page đang có focus của hệ điều hành, có thể bị Chrome từ
          // chối âm thầm nếu không kiểm tra kỹ. KHÔNG dùng execCommand làm
          // dự phòng — composer Facebook (Lexical) không tuân theo
          // execCommand('selectAll'/'delete'/'insertLineBreak') đúng chuẩn,
          // gây chèn thêm/dính liền dòng thay vì thay thế nội dung.
          let filled = await this._fillDescriptionViaClipboard(box, content)
          if (!filled) {
            this.log('Dán qua clipboard không xác nhận được — thử gõ trực tiếp...', 'warn')
            filled = await this._fillDescriptionViaTyping(box, content)
          }

          if (filled) {
            this.log('Đã điền mô tả ✓ (đã xác minh nội dung)', 'ok')
          } else {
            this.log('⚠ Không xác nhận được mô tả đã điền đúng — kiểm tra/điền tay sau khi đăng', 'warn')
          }
        } finally {
          await box.dispose().catch(() => {})
        }
      } else {
        this.log('Không tìm thấy ô mô tả, bỏ qua...', 'warn')
      }

      debugLog(`Chờ afterDescription (${this.delay.afterDescription}ms)...`)
      await sleep(this.delay.afterDescription)
    }
  }

  // Tìm ô mô tả (textarea hoặc contenteditable đủ lớn) và trả về ElementHandle
  // cố định — dò DUY NHẤT 1 LẦN, dùng lại cho mọi thao tác sau.
  async _findDescriptionBoxHandle() {
    const handle = await this.page.evaluateHandle(() => {
      const allTargets = [
        ...document.querySelectorAll('textarea'),
        ...document.querySelectorAll('[contenteditable="true"]'),
      ]
      return allTargets.find(el => {
        const r = el.getBoundingClientRect()
        return r.width > 50 && r.height > 20
      }) || null
    })
    const el = handle.asElement()
    if (!el) {
      await handle.dispose().catch(() => {})
      return null
    }
    return el
  }

  // Xoá sạch nội dung hiện có trong box bằng phím thật (Ctrl+A + Delete) —
  // KHÔNG dùng execCommand vì composer Facebook (Lexical) không đảm bảo
  // tuân theo execCommand('selectAll'/'delete'), có thể không xoá sạch,
  // dẫn tới nội dung mới bị chèn thêm vào thay vì thay thế.
  async _clearBox(box) {
    await box.evaluate(el => el.focus())
    await this.page.keyboard.down('Control')
    await this.page.keyboard.press('a')
    await this.page.keyboard.up('Control')
    await sleep(100)
    await this.page.keyboard.press('Delete')
    await sleep(100)
  }

  // Cách 1 (ưu tiên): ghi vào clipboard hệ thống rồi Ctrl+V — tránh gợi ý
  // tự động Facebook hiện theo từng ký tự gõ. navigator.clipboard.writeText()
  // đòi hỏi document đang có focus của hệ điều hành, nếu không sẽ throw
  // NotAllowedError — bắt lỗi rõ ràng ở đây thay vì nuốt âm thầm như trước,
  // để không paste nhầm nội dung cũ/rỗng trong clipboard khi ghi thất bại.
  async _fillDescriptionViaClipboard(box, content) {
    await box.evaluate(el => el.focus())
    await this.page.bringToFront()
    await sleep(200)

    const writeError = await this.page.evaluate(async (text) => {
      try {
        await navigator.clipboard.writeText(text)
        return null
      } catch (e) {
        return e?.message || String(e)
      }
    }, content)

    if (writeError) {
      this.log(`Ghi clipboard thất bại: ${writeError}`, 'warn')
      return false
    }

    await this._clearBox(box)
    await this.page.keyboard.down('Control')
    await this.page.keyboard.press('v')
    await this.page.keyboard.up('Control')
    await sleep(400)
    await this.page.keyboard.press('Escape') // đóng gợi ý autocomplete nếu có
    await sleep(200)

    return this._verifyBoxContains(box, content)
  }

  // Cách 2 (dự phòng): gõ trực tiếp từng dòng bằng bàn phím thật — chậm hơn
  // và có thể bật gợi ý tự động của Facebook, nhưng đi qua đúng pipeline
  // keydown/input mà composer thật xử lý (không như execCommand — đã bỏ
  // vì Facebook không tuân theo đúng chuẩn, gây chèn thêm/dính liền dòng).
  async _fillDescriptionViaTyping(box, content) {
    await this._clearBox(box)
    await box.evaluate(el => el.focus())

    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      await this.page.keyboard.type(lines[i], { delay: 15 })
      if (i < lines.length - 1) await this.page.keyboard.press('Enter')
    }
    await sleep(300)
    await this.page.keyboard.press('Escape')
    await sleep(200)
    return this._verifyBoxContains(box, content)
  }

  // Đọc lại nội dung của ĐÚNG box đã thao tác để xác nhận đã điền đúng.
  // - .normalize('NFC') trước khi so khớp: tiếng Việt có dấu từ Google
  //   Sheets vs. text đọc lại từ DOM sau khi qua clipboard OS có thể ở 2
  //   dạng chuẩn hoá Unicode khác nhau (NFC/NFD) — nhìn giống hệt nhau
  //   nhưng so sánh chuỗi trực tiếp sẽ lệch, khiến verify báo sai "thất
  //   bại" dù đã điền đúng, kích hoạt fallback chạy thừa gây chồng nội dung.
  // - Thử lại vài lần vì composer có thể mất 1 nhịp render mới cập nhật
  //   xong nội dung sau khi paste.
  async _verifyBoxContains(box, expected) {
    const normalize = (s) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()
    const expectedHead = normalize(expected).slice(0, 30)
    if (!expectedHead) return false

    for (let attempt = 0; attempt < 3; attempt++) {
      const actual = await box.evaluate(el => (el.value !== undefined ? el.value : el.innerText) || '')
      if (normalize(actual).includes(expectedHead)) return true
      await sleep(300)
    }
    return false
  }

  async _publishAndResolveVideoId(reelsUrl) {
    const page = this.page

    const d3 = await humanDelayLog('beforePublish', this.delay.beforePublishMin, this.delay.beforePublishMax)
    this.log(`Tìm nút "Đăng" (sau delay ${d3}ms)...`)
    await waitForButtonActive(page, ['Đăng', 'Publish', 'Share'])
    await humanDelay(500, 1500)

    // Snapshot danh sách reel ID hiện có TRƯỚC khi đăng
    this.log('Snapshot danh sách reel hiện có...')
    const existingReelIds = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href*="/reel/"]')]
      return links.map(l => {
        const m = l.href.match(/\/reel\/(\d{10,})/)
        return m ? m[1] : null
      }).filter(Boolean)
    })
    this.log(`Hiện có ${existingReelIds.length} reels: [${existingReelIds.slice(0, 3).join(', ')}...]`)

    // Setup network interceptor để bắt video ID từ API response
    let networkVideoId = null
    const responseHandler = async (response) => {
      try {
        const url = response.url()
        if (!url.includes('facebook.com')) return
        if (
          url.includes('graphql') ||
          url.includes('video') ||
          url.includes('reel') ||
          url.includes('composer')
        ) {
          const status = response.status()
          if (status < 200 || status >= 300) return
          const text = await response.text().catch(() => '')
          if (!text || text.length < 10) return

          const patterns = [
            /"video_id"\s*:\s*"?(\d{12,18})"?/,
            /"reel_id"\s*:\s*"?(\d{12,18})"?/,
            /"creation_story_id"\s*:\s*"?(\d{12,18})"?/,
            /"post_id"\s*:\s*"?(\d{12,18})"?/,
          ]
          for (const pattern of patterns) {
            const m = text.match(pattern)
            if (m && m[1] && !existingReelIds.includes(m[1])) {
              networkVideoId = m[1]
              this.log(`✓ Bắt được video ID mới từ network: ${networkVideoId}`, 'ok')
              return
            }
          }
        }
      } catch (_) {}
    }
    page.on('response', responseHandler)

    // Click "Đăng" — dùng rightmost span để tránh nhầm "Lưu" [Lưu][Đăng]
    // Facebook không dùng role="button" cho nút Đăng nên cần tìm theo vị trí
    this.log('Click nút "Đăng"...')
    const dangClicked = await page.evaluate(() => {
      const allSpans = [...document.querySelectorAll('span')]
      const dangSpans = allSpans.filter(s => {
        const t = s.textContent.trim()
        return t === 'Đăng' || t === 'Publish' || t === 'Share'
      })
      if (dangSpans.length === 0) return false

      // Sort theo left DESC → span nằm xa nhất bên phải = nút "Đăng"
      dangSpans.sort((a, b) =>
        b.getBoundingClientRect().left - a.getBoundingClientRect().left
      )
      const span = dangSpans[0]

      span.scrollIntoView({ behavior: 'instant', block: 'center' })
      span.click()

      let el = span.parentElement
      for (let i = 0; i < 8; i++) {
        if (!el) break
        const style = window.getComputedStyle(el)
        if (style.cursor === 'pointer') { el.click(); break }
        el = el.parentElement
      }
      return true
    })

    if (dangClicked) {
      this.log('Đã click nút "Đăng" (JS rightmost) ✓', 'ok')
    } else {
      this.log('Fallback: dùng clickButtonByText...', 'warn')
      await clickButtonByText(page, ['Đăng', 'Publish', 'Share'])
    }

    // Chờ network ID (tối đa 15s)
    this.log('Chờ video ID từ network response...')
    for (let i = 0; i < 30 && !networkVideoId; i++) {
      await sleep(500)
    }
    page.off('response', responseHandler)

    if (networkVideoId) {
      this.log(`Video ID từ network: ${networkVideoId}`, 'ok')
      const link = `https://www.facebook.com/reel/${networkVideoId}`
      this.log(`📎 Link video: ${link}`, 'ok')
      return networkVideoId
    }

    // Fallback: Refresh trang Reels nhiều lần để tìm video mới nhất
    this.log('Network không bắt được ID — thử refresh trang Reels để tìm...', 'warn')

    if (this.delay.waitAfterPublishMin > 0) {
      this.log(`Chờ ${this.delay.waitAfterPublishMin} phút trước khi bắt đầu refresh tìm link...`)
      await sleep(this.delay.waitAfterPublishMin * 60000)
    }

    let realVideoId = null
    const maxRefresh = this.delay.refreshAttempts || 5
    const refreshInterval = this.delay.refreshInterval || 30000

    for (let attempt = 1; attempt <= maxRefresh; attempt++) {
      this.log(`[Refresh ${attempt}/${maxRefresh}] Chờ ${refreshInterval / 1000}s...`)
      await sleep(refreshInterval)

      this.log(`[Refresh ${attempt}/${maxRefresh}] Reload trang Reels...`)
      await page.goto(reelsUrl, { waitUntil: 'networkidle2', timeout: 30000 })
        .catch(() => page.reload({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}))
      await sleep(3000)

      // Scan tất cả reel ID trên trang
      const currentIds = await page.evaluate(() => {
        const links = [...document.querySelectorAll('a[href*="/reel/"]')]
        return links.map(l => {
          const m = l.href.match(/\/reel\/(\d{10,})/)
          return m ? m[1] : null
        }).filter(Boolean)
      })

      this.log(`[Refresh ${attempt}] Tìm thấy ${currentIds.length} reels`)

      // Tìm ID mới (không có trong snapshot ban đầu)
      const newIds = currentIds.filter(id => !existingReelIds.includes(id))
      if (newIds.length > 0) {
        realVideoId = newIds[0]
        this.log(`✓ Tìm được ${newIds.length} video mới: ${newIds.join(', ')}`, 'ok')
        this.log(`Chọn ID mới nhất: ${realVideoId}`, 'ok')
        break
      }

      this.log(`[Refresh ${attempt}] Chưa thấy video mới, thử lại...`, 'warn')
    }

    if (!realVideoId) {
      this.log('⚠️ Không tìm được video ID sau nhiều lần refresh', 'warn')
      this.log(`Kiểm tra thủ công tại: ${reelsUrl}`, 'warn')
      realVideoId = `UNKNOWN_${Date.now()}`
    }

    const reelLink = realVideoId.startsWith('UNKNOWN')
      ? `Không xác định — xem thủ công: ${reelsUrl}`
      : `https://www.facebook.com/reel/${realVideoId}`

    this.log('✓ Đã đăng Reels thành công!', 'ok')
    this.log(`📎 Link video: ${reelLink}`, 'ok')
    return realVideoId
  }
}

module.exports = ReelUploadAction
