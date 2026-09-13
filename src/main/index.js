// ============================================================
//  FB Video Uploader — Main Process (Electron) — bootstrap.
//  Toàn bộ logic nghiệp vụ nằm ở services/, browser/, automation/,
//  queue/, ipc/ — file này chỉ khởi tạo app + window + wiring.
// ============================================================
const { app, BrowserWindow } = require('electron')
const path = require('path')

const { setMainWindow, getMainWindow } = require('./windowState')
const { registerIpcHandlers } = require('./ipc/registerIpcHandlers')
const schedulerService = require('./services/schedulerService')
const queueRunner = require('./queue/uploadQueueRunner')

// ─── Window ──────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 600,   // cho phép thu nhỏ hơn
    minHeight: 500,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
  })
  setMainWindow(win)

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
  if (isDev) {
    win.loadURL('http://localhost:5173')
    // DevTools tắt mặc định — mở bằng Ctrl+Shift+I khi cần debug
    // win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  win.on('closed', () => setMainWindow(null))
}

app.whenReady().then(() => {
  createWindow()
  registerIpcHandlers()
  app.on('activate', () => { if (!getMainWindow()) createWindow() })

  // Auto-restore scheduler nếu trước đó đã bật
  schedulerService.restoreSchedulerIfEnabled()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await queueRunner.closeBrowserOnQuit()
  schedulerService.stopCronTimer()
})
