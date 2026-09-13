// ============================================================
//  windowState — tham chiếu BrowserWindow chính, dùng chung cho
//  logger, ipc handlers... để tránh mỗi module tự giữ 1 biến riêng.
// ============================================================
let mainWindow = null

function setMainWindow(win) {
  mainWindow = win
}

function getMainWindow() {
  return mainWindow
}

module.exports = { setMainWindow, getMainWindow }
