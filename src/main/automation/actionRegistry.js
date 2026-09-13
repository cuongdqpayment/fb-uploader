// ============================================================
//  actionRegistry — map loại hành động → class action tương ứng.
//  Khi thêm tính năng mới (đăng bài viết, đăng bản tin, comment...),
//  chỉ cần viết class kế thừa BaseFacebookAction rồi đăng ký thêm
//  1 dòng ở đây — KHÔNG cần sửa uploadQueueRunner.js hay ipc.
// ============================================================
const ReelUploadAction = require('./reelUploadAction')
const PostAction = require('./postAction')
const NewsPostAction = require('./newsPostAction')
const CommentAction = require('./commentAction')

const ACTION_TYPES = {
  REEL_UPLOAD: 'reel_upload',
  POST: 'post',
  NEWS_POST: 'news_post',
  COMMENT: 'comment',
}

const REGISTRY = {
  [ACTION_TYPES.REEL_UPLOAD]: ReelUploadAction,
  [ACTION_TYPES.POST]: PostAction,
  [ACTION_TYPES.NEWS_POST]: NewsPostAction,
  [ACTION_TYPES.COMMENT]: CommentAction,
}

// params: { browser, channel, row } — xem BaseFacebookAction
function createAction(type, params) {
  const ActionClass = REGISTRY[type] || ReelUploadAction
  return new ActionClass(params)
}

module.exports = { ACTION_TYPES, createAction }
