const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('autodave', {
  backendInfo: () => ipcRenderer.invoke('backend-info'),
  openApp: (hash) => ipcRenderer.invoke('open-app', hash),
  pickFolder: (defaultPath) => ipcRenderer.invoke('pick-folder', defaultPath),
  resizePanel: (h) => ipcRenderer.invoke('resize-panel', h),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  setLoginItem: (on) => ipcRenderer.invoke('set-login-item', on),
  trayAlert: (on) => ipcRenderer.invoke('tray-alert', on),
})
