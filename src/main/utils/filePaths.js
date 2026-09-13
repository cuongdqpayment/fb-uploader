const path = require('path')

// Resolve file path từ tên file + channel config
function resolveFilePath(fileName, channel) {
  if (path.isAbsolute(fileName)) return fileName
  const baseDir = (channel && channel.videoBaseDir) || ''
  return baseDir ? path.join(baseDir, fileName) : fileName
}

module.exports = { resolveFilePath }
