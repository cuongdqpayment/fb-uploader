// ============================================================
//  pageNavigator — chuyển đúng tài khoản Trang (channel) trên
//  Facebook. Dùng CHUNG cho mọi loại hành động (đăng Reels, đăng
//  bài viết, đăng bản tin, comment...) vì hành động nào cũng cần
//  đứng đúng Trang trước khi thao tác.
//
//  Cấu trúc menu "Trang cá nhân của bạn" (đã xác nhận qua HTML thật lấy
//  trực tiếp từ Facebook — QUAN TRỌNG, khác giả định ban đầu):
//
//    <a href="/me/">...<span>{Tên tài khoản ĐANG ACTIVE}</span></a>  ← nằm
//                                                                      RIÊNG, NGOÀI danh sách switch
//    <div aria-label="Chuyển nhanh trang cá nhân" role="list">
//      <div aria-label="Chuyển sang {Tên kênh A}" role="button">...</div>
//      <div aria-label="Chuyển sang {Tên kênh B}" role="button">...</div>
//      ... (KHÔNG bao gồm tài khoản đang active — danh sách này chỉ chứa
//           các kênh CÓ THỂ chuyển sang)
//    </div>
//
//  Tức là: tài khoản đang active KHÔNG phải "item đầu tiên của danh
//  sách" (giả định cũ, đã SAI — gây bug đăng nhầm kênh vì item[0] của
//  danh sách switch thực ra là kênh CÓ THỂ chuyển sang đầu tiên, không
//  phải kênh đang đứng). Tên tài khoản đang active phải đọc từ link
//  href="/me/" nằm ngoài danh sách.
//
//  Nếu kênh cần chuyển không có trong danh sách rút gọn → bấm
//  aria-label="Xem tất cả trang cá nhân" để mở rộng, rồi tìm lại.
// ============================================================
const { sendLog, debugLog } = require('../logger')
const { sleep } = require('../utils/sleep')

const PROFILE_MENU_ARIA = 'Chuyển nhanh trang cá nhân'
const SEE_ALL_ARIA = 'Xem tất cả trang cá nhân'
const ME_LINK_SELECTOR = 'a[href="/me/"]'

// So khớp tên kênh: đúng tuyệt đối, hoặc 1 bên là 1 phần của bên kia (tên
// kênh người dùng nhập trong Cấu hình chỉ cần khớp/là 1 phần tên hiển thị
// thật trên Facebook — xem README).
function _namesMatch(a, b) {
  if (!a || !b) return false
  return a === b || a.includes(b) || b.includes(a)
}

// Đọc 1 lần: tên tài khoản đang active (từ link /me/) + danh sách kênh có
// thể chuyển sang (từ danh sách "Chuyển nhanh trang cá nhân"). Gộp vào 1
// evaluate() để đỡ round-trip và đảm bảo cả 2 được đọc cùng 1 thời điểm.
async function _readSnapshot(page) {
  return page.evaluate((menuAria, meSelector) => {
    const panel = document.querySelector(`[aria-label="${menuAria}"]`)
    const items = panel
      ? [...panel.querySelectorAll('[role="button"]')]
      : [...document.querySelectorAll('[role="button"][aria-label^="Chuyển sang"]')]
    const labels = items.map(el => (el.getAttribute('aria-label') || '').replace('Chuyển sang ', '').trim())

    const meLink = document.querySelector(meSelector)
    let activeName = meLink ? (meLink.textContent || '').trim() : ''
    let activeSource = 'me_link'
    if (!activeName) {
      // Dự phòng nếu Facebook đổi DOM và không tìm thấy link /me/ — kém
      // tin cậy hơn (đây chính là giả định CŨ đã biết là sai), chỉ dùng
      // khi cách chính xác không khả dụng.
      activeName = labels[0] || ''
      activeSource = 'fallback_first_item'
    }

    return { activeName, activeSource, labels }
  }, PROFILE_MENU_ARIA, ME_LINK_SELECTOR)
}

// Chờ menu render ỔN ĐỊNH thay vì sleep cố định: đọc snapshot 2 lần cách
// nhau 300ms, chỉ coi là sẵn sàng khi 2 lần đọc GIỐNG HỆT nhau (active
// name + danh sách switch). Facebook populate menu bằng gọi async sau khi
// mở — đọc quá sớm (đặc biệt ngay sau khi Chrome vừa khởi động lại) có
// thể trúng lúc dữ liệu chưa đầy đủ.
async function _waitForMenuReady(page, timeoutMs = 10000) {
  const start = Date.now()
  let prev = null
  while (Date.now() - start < timeoutMs) {
    const snap = await _readSnapshot(page)
    const hasData = !!snap.activeName || snap.labels.length > 0
    if (
      hasData && prev !== null &&
      prev.activeName === snap.activeName &&
      prev.labels.length === snap.labels.length &&
      prev.labels.every((l, i) => l === snap.labels[i])
    ) {
      return snap
    }
    prev = snap
    await sleep(300)
  }
  return prev || { activeName: '', activeSource: 'timeout', labels: [] }
}

async function _openAvatarMenu(page) {
  sendLog('Click avatar mở menu...', 'info')

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
    const vw = await page.evaluate(() => window.innerWidth)
    await page.mouse.click(vw - 40, 35)
    sendLog('Avatar fallback click (tọa độ)', 'warn')
  } else {
    debugLog(`Avatar clicked (${avatarClicked.method})`)
  }
}

async function _closeMenu(page) {
  await page.keyboard.press('Escape').catch(() => {})
  await sleep(300)
}

// Tìm và click đúng kênh trong danh sách switch dựa trên snapshot ĐÃ ĐỌC
// ỔN ĐỊNH sẵn. Return: 'already_active' | 'clicked' | 'not_found'
async function _findAndClickChannel(page, targetName, snapshot) {
  // Tài khoản đang active đọc từ link /me/ — KHÔNG phải item đầu danh sách
  if (snapshot.activeName && _namesMatch(snapshot.activeName, targetName)) {
    return 'already_active'
  }

  return page.evaluate((targetName) => {
    // Ưu tiên khớp đúng tuyệt đối aria-label
    const exactBtn = document.querySelector(`[aria-label="Chuyển sang ${targetName}"]`)
    if (exactBtn) {
      exactBtn.scrollIntoView({ behavior: 'instant', block: 'center' })
      exactBtn.click()
      return 'clicked'
    }

    const panel = document.querySelector('[aria-label="Chuyển nhanh trang cá nhân"]')
    const items = panel
      ? [...panel.querySelectorAll('[role="button"]')]
      : [...document.querySelectorAll('[role="button"][aria-label^="Chuyển sang"]')]

    const partialBtn = items.find(el => (el.getAttribute('aria-label') || '').includes(targetName))
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

// Thực hiện 1 lượt chuyển kênh đầy đủ (mở menu → tìm/click → nếu chưa
// thấy thì mở rộng "Xem tất cả" → tìm/click lại). Return true/false —
// KHÔNG tự ý coi thành công nếu không thực sự tìm thấy/click được.
async function _switchOnce(page, targetName) {
  await _openAvatarMenu(page)
  let snap = await _waitForMenuReady(page)
  sendLog(`Đang active: "${snap.activeName || '(không rõ)'}"${snap.activeSource === 'fallback_first_item' ? ' [dự phòng — không đọc được /me/]' : ''} — có thể chuyển sang: [${snap.labels.join(', ')}]`, 'info')

  let result = await _findAndClickChannel(page, targetName, snap)
  debugLog(`_findAndClickChannel: ${result}`)

  if (result === 'already_active') {
    sendLog(`Đã đúng kênh "${targetName}" (active) ✓`, 'ok')
    await _closeMenu(page)
    return true
  }

  if (result === 'clicked') {
    sendLog(`Đã click kênh "${targetName}" ✓ — chờ switch...`, 'ok')
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
      sleep(500),
    ])
    await sleep(6000)
    return true
  }

  // not_found trong danh sách rút gọn → mở rộng "Xem tất cả trang cá nhân"
  sendLog('Kênh chưa thấy trong menu rút gọn — click "Xem tất cả trang cá nhân"...', 'info')
  const expanded = await page.evaluate((seeAllAria) => {
    const btn = document.querySelector(`[aria-label="${seeAllAria}"]`)
    if (btn) { btn.scrollIntoView({ behavior: 'instant', block: 'center' }); btn.click(); return true }
    const span = [...document.querySelectorAll('span')].find(s => s.textContent.trim().includes('Xem tất cả'))
    if (span) { span.scrollIntoView({ behavior: 'instant', block: 'center' }); span.click(); return true }
    return false
  }, SEE_ALL_ARIA)

  if (!expanded) {
    sendLog(`Không tìm thấy kênh "${targetName}" và không có nút "Xem tất cả"`, 'warn')
    await _closeMenu(page)
    return false
  }

  sendLog('"Xem tất cả" đã click ✓ — chờ danh sách đầy đủ...', 'ok')
  snap = await _waitForMenuReady(page)
  sendLog(`Danh sách đầy đủ — đang active: "${snap.activeName || '(không rõ)'}" — có thể chuyển sang: [${snap.labels.join(', ')}]`, 'info')

  result = await _findAndClickChannel(page, targetName, snap)
  debugLog(`_findAndClickChannel (đầy đủ): ${result}`)

  if (result === 'already_active') {
    sendLog(`Đã đúng kênh "${targetName}" ✓`, 'ok')
    await _closeMenu(page)
    return true
  }

  if (result === 'clicked') {
    sendLog(`Đã click kênh "${targetName}" ✓`, 'ok')
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
      sleep(500),
    ])
    await sleep(6000)
    return true
  }

  sendLog(`Không tìm thấy kênh "${targetName}" trong danh sách trang cá nhân`, 'warn')
  await _closeMenu(page)
  return false
}

// ─── Switch sang đúng tài khoản Page ─────────────────────────
// Sau khi _switchOnce() báo thành công, LUÔN mở menu lại 1 lần nữa để
// XÁC MINH (qua link /me/) thực sự đang đứng đúng targetName rồi mới báo
// true — vì _switchOnce chỉ dựa trên 1 lần đọc, nếu Facebook chưa kịp cập
// nhật hoặc bị đọc nhầm, tin luôn kết quả đó có thể khiến chương trình
// đăng NHẦM kênh mà không hề biết. Cho phép thử lại tối đa 2 lượt trước
// khi thật sự báo lỗi.
async function switchToPage(page, channel) {
  const targetName = channel.name.trim()
  const MAX_ATTEMPTS = 2

  try {
    await page.bringToFront()
    await sleep(500)

    if (!page.url().includes('facebook.com')) {
      await page.goto('https://www.facebook.com', { waitUntil: 'networkidle2', timeout: 30000 })
      await sleep(2000)
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        sendLog(`Thử lại lần ${attempt} chuyển sang kênh "${targetName}"...`, 'warn')
        await sleep(2000)
      }

      const switched = await _switchOnce(page, targetName)

      if (switched) {
        // Xác minh lại — mở menu thêm 1 lần, đọc đúng tên active từ /me/
        sendLog(`Xác minh lại đang đứng đúng kênh "${targetName}"...`, 'info')
        await _openAvatarMenu(page)
        const finalSnap = await _waitForMenuReady(page)
        sendLog(`[Xác minh] Kênh đang active: "${finalSnap.activeName || '(không rõ)'}"`, 'info')
        await _closeMenu(page)

        if (finalSnap.activeName && _namesMatch(finalSnap.activeName, targetName)) {
          sendLog(`✓ Xác minh đúng: đang đứng ở kênh "${targetName}"`, 'ok')
          return true
        }

        sendLog(`⚠ Xác minh KHÔNG khớp — kênh đang active là "${finalSnap.activeName || '(không rõ)'}", không phải "${targetName}"`, 'warn')
      }

      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`Không xác minh được đang đứng đúng kênh "${targetName}" sau ${MAX_ATTEMPTS} lần thử`)
      }
    }

    return false
  } catch (e) {
    sendLog(`switchToPage lỗi: ${e.message}`, 'error')
    return false
  }
}

module.exports = { switchToPage }
