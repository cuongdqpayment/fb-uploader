// ─── Parse scheduled_at — luôn dùng D/M/YYYY (locale VN) ──────
// Google Sheets locale VN trả về: '10/09/2026 18:30:00' = ngày 10, tháng 9
// Khi ambiguous (cả 2 ≤ 12): luôn treat là D/M/YYYY
function parseScheduledAt(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null

  // Format 1: YYYY-MM-DD (an toàn nhất, không ambiguous)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = new Date(s.replace(' ', 'T') + (s.includes('+') ? '' : '+07:00'))
    if (!isNaN(t)) return t
  }

  // Format 2: D/M/YYYY (locale VN) — treat first number là NGÀY, second là THÁNG
  const match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (match) {
    const [, first, second, y, hh = '0', mm = '0', ss = '0'] = match
    const firstN = parseInt(first), secondN = parseInt(second)

    let day, month
    if (firstN > 12) {
      // first > 12 → chắc chắn là ngày (D/M/YYYY)
      day = firstN; month = secondN
    } else if (secondN > 12) {
      // second > 12 → chắc chắn là tháng → first là ngày (D/M/YYYY) thực ra M/D
      day = secondN; month = firstN
    } else {
      // Ambiguous: cả 2 ≤ 12 → theo locale VN = D/M/YYYY
      // first = ngày, second = tháng
      day = firstN; month = secondN
    }

    const dateStr = `${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}` +
                    `T${String(parseInt(hh)).padStart(2,'0')}:${mm.padStart(2,'0')}:${ss.padStart(2,'0')}+07:00`
    const t = new Date(dateStr)
    if (!isNaN(t)) return t
  }

  // Fallback: JS tự parse
  const t = new Date(s)
  return isNaN(t) ? null : t
}

module.exports = { parseScheduledAt }
