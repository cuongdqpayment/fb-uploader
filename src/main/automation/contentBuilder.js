// ============================================================
//  contentBuilder — ghép nội dung đăng bài từ 1 dòng Sheet.
//  Dùng chung cho mọi action (Reels, đăng bài viết, đăng bản tin...)
//  để không mỗi action tự ghép caption/description theo 1 kiểu riêng.
// ============================================================

// Ghép caption + xuống dòng + description làm nội dung đăng.
// - Có cả 2: "caption\ndescription"
// - Chỉ có 1 trong 2: dùng đúng cái đó
// - Không có gì: trả về '' (action gọi chỗ này tự quyết định bỏ qua bước điền)
function buildPostContent(row) {
  return [row?.caption, row?.description]
    .map(s => (s || '').trim())
    .filter(Boolean)
    .join('\n')
}

module.exports = { buildPostContent }
