const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('autowright', {
  backendInfo: () => ipcRenderer.invoke('backend-info'),
  openApp: (hash) => ipcRenderer.invoke('open-app', hash),
  pickFolder: (defaultPath) => ipcRenderer.invoke('pick-folder', defaultPath),
  resizePanel: (h) => ipcRenderer.invoke('resize-panel', h),
  // §5.1 transfer archives: native dialogs + file IO for export/import
  saveFile: (defaultName, data) => ipcRenderer.invoke('save-file', defaultName, data),
  openArchive: () => ipcRenderer.invoke('open-archive'),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  setLoginItem: (on) => ipcRenderer.invoke('set-login-item', on),
  trayAlert: (on) => ipcRenderer.invoke('tray-alert', on),
  // Deep-link target ('/app?auto=<id>') pushed by main when the window already
  // exists — a reload would drop the WS and all renderer state.
  onOpenTarget: (cb) => ipcRenderer.on('open-target', (_e, hash) => cb(hash)),
})
