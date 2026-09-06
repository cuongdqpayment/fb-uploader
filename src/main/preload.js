// ============================================================
//  FB Video Uploader — preload.js
//  Secure bridge: expose safe IPC APIs to renderer (React).
// ============================================================

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig:    ()     => ipcRenderer.invoke('config:get'),
  setConfig:    (data) => ipcRenderer.invoke('config:set', data),

  // Dialogs
  openFile: (filters) => ipcRenderer.invoke('dialog:openFile', filters),
  openDir:  ()        => ipcRenderer.invoke('dialog:openDir'),
  openUrl:  (url)     => ipcRenderer.invoke('shell:openExternal', url),

  // Google Sheets — single channel
  testSheets:  (channelId) => ipcRenderer.invoke('sheets:test', channelId),
  fetchSheets: (channelId) => ipcRenderer.invoke('sheets:fetch', channelId),
  // Google Sheets — tất cả channels
  fetchAllSheets: () => ipcRenderer.invoke('sheets:fetchAll'),

  // Upload control
  runNow:       (channelId) => ipcRenderer.invoke('upload:runNow', channelId),
  runScheduled: (channelId) => ipcRenderer.invoke('upload:runScheduled', channelId),
  stopRun: ()               => ipcRenderer.invoke('upload:stop'),

  // Scheduler
  startScheduler: () => ipcRenderer.invoke('scheduler:start'),
  stopScheduler:  () => ipcRenderer.invoke('scheduler:stop'),

  // Events from main → renderer
  onLog:    (cb) => ipcRenderer.on('log',    (_, d) => cb(d)),
  onStatus: (cb) => ipcRenderer.on('status', (_, d) => cb(d)),
  onRowProcessing: (cb) => ipcRenderer.on('row:processing', (_, d) => cb(d)),
  onRowDone:       (cb) => ipcRenderer.on('row:done',       (_, d) => cb(d)),
  onRowError:      (cb) => ipcRenderer.on('row:error',      (_, d) => cb(d)),

  // Cleanup listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
})