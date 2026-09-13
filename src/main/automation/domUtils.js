// ============================================================
//  domUtils — helper Puppeteer dùng chung cho MỌI hành động
//  Facebook (đăng Reels, đăng bài viết, đăng bản tin, comment...).
//  Viết mới 1 action KHÔNG cần viết lại logic tìm/bấm element.
// ============================================================
const { sendLog } = require('../logger')
const { sleep } = require('../utils/sleep')

// Delay ngẫu nhiên giống người dùng thật
function humanDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs)
  return sleep(Math.round(ms))
}

// humanDelay có return giá trị delay thực tế để log
async function humanDelayLog(label, minMs, maxMs) {
  const ms = Math.round(minMs + Math.random() * (maxMs - minMs))
  sendLog(`[delay:${label}] chờ ${ms}ms...`, 'info')
  await sleep(ms)
  return ms
}

// Click nút theo text — JS click trực tiếp, scrollIntoView trước,
// không cần tọa độ; hoạt động kể cả khi element ngoài viewport.
async function clickButtonByText(page, texts) {
  const result = await page.evaluate((texts) => {
    for (const text of texts) {
      const span = [...document.querySelectorAll('span')]
        .find(s => s.textContent.trim() === text)
      if (!span) continue

      // Leo lên tìm clickable parent
      let clickTarget = span
      let el = span
      for (let i = 0; i < 10; i++) {
        const tag = el.tagName?.toLowerCase()
        const role = el.getAttribute?.('role')
        const disabled = el.disabled || el.getAttribute?.('aria-disabled') === 'true'
        if (disabled) break
        if (tag === 'button' || role === 'button') { clickTarget = el; break }
        const style = window.getComputedStyle(el)
        if (style.cursor === 'pointer') clickTarget = el
        if (!el.parentElement) break
        el = el.parentElement
      }

      // scrollIntoView rồi JS click — không cần visible trong viewport
      clickTarget.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })
      clickTarget.click()
      return text
    }
    return null
  }, texts)

  if (result) {
    sendLog(`Đã click "${result}" (JS click) ✓`, 'ok')
    await sleep(300)
    return result
  }

  sendLog(`Không tìm thấy nút [${texts.join('/')}]`, 'warn')
  return null
}

// Chờ nút bất kỳ trong danh sách text xuất hiện trên trang
// (chỉ kiểm tra TỒN TẠI trong DOM — không kiểm tra có bị khoá hay không.
// Xem waitForButtonEnabled() nếu cần chờ nút thực sự bấm được).
async function waitForButtonActive(page, texts, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const found = await page.evaluate((texts) => {
      const allEls = [...document.querySelectorAll('span, button, div[role="button"]')]
      for (const text of texts) {
        const el = allEls.find(e => e.textContent.trim() === text)
        if (el) return true
      }
      return false
    }, texts)
    if (found) return true
    await sleep(1000)
  }
  sendLog(`Nút [${texts.join('/')}] không xuất hiện sau ${timeout/1000}s`, 'warn')
}

// Chờ nút theo text thực sự BẤM ĐƯỢC (không bị disabled/aria-disabled/
// pointer-events:none) — dùng khi không có tín hiệu text nào khác đáng
// tin cậy để biết bước xử lý trước đó đã xong (VD: tài khoản cá nhân
// chưa bật Chế độ chuyên nghiệp thì Facebook không quét bản quyền nên
// không có text "an toàn để đăng" — nút "Tiếp" bật lên là tín hiệu duy
// nhất cho biết Facebook đã nhận file xong).
async function waitForButtonEnabled(page, texts, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const enabled = await page.evaluate((texts) => {
      for (const text of texts) {
        const span = [...document.querySelectorAll('span')]
          .find(s => s.textContent.trim() === text)
        if (!span) continue

        // Leo lên tìm phần tử button/role=button thực sự (giống clickButtonByText)
        let el = span
        for (let i = 0; i < 10; i++) {
          const tag = el.tagName?.toLowerCase()
          const role = el.getAttribute?.('role')
          if (tag === 'button' || role === 'button') break
          if (!el.parentElement) break
          el = el.parentElement
        }

        const disabled =
          el.disabled === true ||
          el.getAttribute?.('aria-disabled') === 'true' ||
          window.getComputedStyle(el).pointerEvents === 'none'

        if (!disabled) return true
      }
      return false
    }, texts)
    if (enabled) return true
    await sleep(1000)
  }
  return false
}

module.exports = { humanDelay, humanDelayLog, clickButtonByText, waitForButtonActive, waitForButtonEnabled }
