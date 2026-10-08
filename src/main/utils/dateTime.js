// ─── Parse scheduled_at ─────────────────────────────────────────
// KHÔNG tự đoán định dạng. Ngày dạng "a/b/YYYY" được hiểu CHÍNH XÁC theo
// cấu hình của người dùng (tick "định dạng ngày kiểu Việt Nam" của kênh):
//   vietnameseFormat = true  → a = ngày, b = tháng   (D/M/YYYY)
//   vietnameseFormat = false → a = tháng, b = ngày   (M/D/YYYY, kiểu Mỹ)
// Dạng ISO "YYYY-MM-DD[ HH:mm[:ss]]" không mơ hồ nên luôn được chấp nhận.
// Giờ luôn tính theo múi giờ Việt Nam (GMT+7).
// Không hiểu được → trả về null (caller tự quyết định, không đoán).

function _build(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12) return null
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  if (d < 1 || d > daysInMonth) return null
  if (h > 23 || mi > 59 || s > 59) return null
  const p = (n) => String(n).padStart(2, '0')
  const t = new Date(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}+07:00`)
  return isNaN(t) ? null : t
}

const ISO_RE   = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
const SLASH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/

function parseScheduledAt(raw, { vietnameseFormat = true } = {}) {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null

  const iso = s.match(ISO_RE)
  if (iso) {
    return _build(+iso[1], +iso[2], +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0))
  }

  const slash = s.match(SLASH_RE)
  if (slash) {
    const a = +slash[1], b = +slash[2]
    const [day, month] = vietnameseFormat ? [a, b] : [b, a]
    return _build(+slash[3], month, day, +(slash[4] || 0), +(slash[5] || 0), +(slash[6] || 0))
  }

  return null
}

module.exports = { parseScheduledAt }
