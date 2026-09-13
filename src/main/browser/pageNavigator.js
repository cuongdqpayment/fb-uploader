// ============================================================
//  pageNavigator — chuyển đúng tài khoản Trang (channel) trên
//  Facebook. Dùng CHUNG cho mọi loại hành động (đăng Reels, đăng
//  bài viết, đăng bản tin, comment...) vì hành động nào cũng cần
//  đứng đúng Trang trước khi thao tác.
// ============================================================
const { sendLog, debugLog } = require('../logger')
const { sleep } = require('../utils/sleep')

// ─── Tìm và click kênh trong panel hiện tại ──────────────────
// Return: 'already_active' | 'clicked' | 'not_found'
async function _findAndClickChannel(page, targetName) {
  return await page.evaluate((targetName) => {
    // Panel "Chuyển nhanh trang cá nhân" — aria-label chuẩn
    const panel = document.querySelector('[aria-label="Chuyển nhanh trang cá nhân"]')
    const items = panel
      ? [...panel.querySelectorAll('[role="button"]')]
      : [...document.querySelectorAll('[role="button"][aria-label^="Chuyển sang"]')]

    if (items.length === 0) return 'not_found'

    // Bước 2: Item đầu tiên = kênh đang active
    const firstLabel = (items[0]?.getAttribute('aria-label') || '')
      .replace('Chuyển sang ', '').trim()
    if (
      firstLabel.length > 0 && (
        firstLabel === targetName ||
        firstLabel.includes(targetName) ||
        targetName.includes(firstLabel)
      )
    ) return 'already_active'

    // Bước 3: Tìm [aria-label="Chuyển sang {targetName}"]
    const exactBtn = document.querySelector(`[aria-label="Chuyển sang ${targetName}"]`)
    if (exactBtn) {
      exactBtn.scrollIntoView({ behavior: 'instant', block: 'center' })
      exactBtn.click()
      return 'clicked'
    }

    // Partial aria-label match
    const partialBtn = items.find(el =>
      (el.getAttribute('aria-label') || '').includes(targetName)
    )
    if (partialBtn) {
      partialBtn.scrollIntoView({ behavior: 'instant', block: 'center' })
      partialBtn.click()
      return 'clicked'
    }

    // Fallback: span text match trong panel
    const spans = panel
      ? [...panel.querySelectorAll('span[dir="auto"]')]
      : [...document.querySelectorAll('span[dir="auto"]')]
    const span = spans.find(s => {
      const t = s.textContent.trim()
      return t === targetName || t.includes(targetName) || targetName.includes(t)
    })
    if (span) {
      span.scrollIntoView({ behavior: 'instant', block: 'center' })
      let el = span
      for (let i = 0; i < 8; i++) {
        if (!el) break
        if (el.getAttribute('role') === 'button') { el.click(); return 'clicked' }
        if (window.getComputedStyle(el).cursor === 'pointer') { el.click(); return 'clicked' }
        el = el.parentElement
      }
      span.click()
      return 'clicked'
    }

    return 'not_found'
  }, targetName)
}

// ─── Switch sang đúng tài khoản Page ─────────────────────────
// 6 bước theo đúng flow giao diện Facebook
async function switchToPage(page, channel) {
  const targetName = channel.name.trim()

  try {
    // Bước 0: Bring to front (quan trọng khi chạy ngầm)
    await page.bringToFront()
    await sleep(500)

    if (!page.url().includes('facebook.com')) {
      await page.goto('https://www.facebook.com', { waitUntil: 'networkidle2', timeout: 30000 })
      await sleep(2000)
    }

    // ── Bước 1: Click avatar → menu "Chuyển nhanh trang cá nhân" mở ──
    sendLog('Bước 1: Click avatar mở menu...', 'info')

    const avatarClicked = await page.evaluate(() => {
      // Tìm div[role="button"] ở góc phải header
      const btns = [...document.querySelectorAll('[role="button"]')]
        .filter(el => {
          const r = el.getBoundingClientRect()
          return r.top >= 0 && r.top < 70 &&
                 r.right > window.innerWidth * 0.8 &&
                 r.width >= 30 && r.width <= 70
        })
        .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)

      if (btns.length > 0) { btns[0].click(); return { ok: true, method: 'header-btn' } }

      // Fallback: image avatar fbcdn
      const imgs = [...document.querySelectorAll('image')].filter(img => {
        const href = img.getAttribute('xlink:href') || img.getAttribute('href') || ''
        const r = img.getBoundingClientRect()
        return href.includes('fbcdn') && r.top < 70 && r.right > window.innerWidth * 0.7
      })
      if (imgs.length > 0) {
        let el = imgs[0]
        for (let i = 0; i < 8; i++) {
          if (!el.parentElement) break
          el = el.parentElement
          if (el.getAttribute('role') === 'button') { el.click(); return { ok: true, method: 'avatar-img' } }
        }
      }
      return { ok: false }
    })

    if (!avatarClicked?.ok) {
      // Fallback tọa độ
      const vw = await page.evaluate(() => window.innerWidth)
      await page.mouse.click(vw - 40, 35)
      sendLog('Avatar fallback click (tọa độ)', 'warn')
    } else {
      debugLog(`Avatar clicked (${avatarClicked.method})`)
    }

    await sleep(2000) // Chờ menu render

    // ── Bước 2 + 3: Đọc panel và tìm kênh ──
    sendLog(`Bước 2-3: Tìm kênh "${targetName}" trong menu...`, 'info')
    const result1 = await _findAndClickChannel(page, targetName)
    debugLog(`_findAndClickChannel result: ${result1}`)

    if (result1 === 'already_active') {
      sendLog(`Đã đúng kênh "${targetName}" (active) ✓`, 'ok')
      await page.keyboard.press('Escape')
      await sleep(300)
      return true
    }

    if (result1 === 'clicked') {
      sendLog(`Đã click kênh "${targetName}" ✓ — chờ switch...`, 'ok')
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
        sleep(500),
      ])
      await sleep(6000)
      sendLog(`✓ Switch thành công sang "${targetName}"`, 'ok')
      return true
    }

    // result1 === 'not_found'
    // ── Bước 4: Click "Xem tất cả trang cá nhân" ──
    sendLog('Bước 4: Kênh chưa thấy — click "Xem tất cả trang cá nhân"...', 'info')

    const xemTatCaClicked = await page.evaluate(() => {
      // Dùng aria-label chính xác từ HTML thực tế
      const btn = document.querySelector('[aria-label="Xem tất cả trang cá nhân"]')
      if (btn) {
        btn.scrollIntoView({ behavior: 'instant', block: 'center' })
        btn.click()
        return true
      }
      // Fallback text
      const span = [...document.querySelectorAll('span')]
        .find(s => s.textContent.trim().includes('Xem tất cả'))
      if (span) {
        span.scrollIntoView({ behavior: 'instant', block: 'center' })
        span.click()
        return true
      }
      return false
    })

    if (!xemTatCaClicked) {
      await page.keyboard.press('Escape')
      throw new Error(`Không tìm thấy kênh "${targetName}" và không có nút "Xem tất cả"`)
    }

    sendLog('"Xem tất cả" đã click ✓ — chờ danh sách đầy đủ...', 'ok')
    await sleep(2000)

    // ── Bước 5: Gọi lại _findAndClickChannel trong danh sách đầy đủ ──
    sendLog(`Bước 5: Tìm lại "${targetName}" trong danh sách đầy đủ...`, 'info')
    const result2 = await _findAndClickChannel(page, targetName)
    debugLog(`_findAndClickChannel result2: ${result2}`)

    if (result2 === 'already_active') {
      sendLog(`Đã đúng kênh "${targetName}" ✓`, 'ok')
      await page.keyboard.press('Escape')
      return true
    }

    if (result2 === 'clicked') {
      sendLog(`Đã click kênh "${targetName}" ✓`, 'ok')
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
        sleep(500),
      ])
      await sleep(6000)
      sendLog(`✓ Switch thành công sang "${targetName}"`, 'ok')
      return true
    }

    // ── Bước 6: Vẫn not_found → báo lỗi ──
    await page.keyboard.press('Escape')
    throw new Error(`Không tìm thấy kênh "${targetName}" trong danh sách trang cá nhân`)

  } catch (e) {
    sendLog(`switchToPage lỗi: ${e.message}`, 'error')
    return false
  }
}

module.exports = { switchToPage }
