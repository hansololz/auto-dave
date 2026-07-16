// Electron main: one app window + a tray (menu-bar) panel window (§9, §13).
const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, ipcMain, shell, screen } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Keep Chromium's profile (Cache, Cookies, Local Storage, …) out of the backend's
// data dir — both default to ~/Library/Application Support/Auto Dave (§5).
app.setPath('userData', path.join(app.getPath('userData'), 'electron'))

let win = null
let panel = null
let tray = null

function backendInfo() {
  const home = process.env.AUTODAVE_HOME
    ? process.env.AUTODAVE_HOME
    : path.join(os.homedir(), 'Library', 'Application Support', 'Auto Dave')
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'backend.json'), 'utf-8'))
  } catch {
    return null
  }
}

function load(w, hash) {
  // AUTODAVE_RENDERER_URL (§15): serve the same renderer source from a dev
  // server (HMR) instead of the built bundle. Configuration only — same code.
  const devUrl = process.env.AUTODAVE_RENDERER_URL
  if (devUrl) {
    const u = new URL(devUrl)
    u.hash = hash
    w.loadURL(u.toString())
  } else {
    w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash })
  }
}

// Right-click copy for selected text; text fields get the full edit menu.
function attachContextMenu(w) {
  w.webContents.on('context-menu', (_e, params) => {
    const items = params.isEditable
      ? [
          { role: 'cut', enabled: params.editFlags.canCut },
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'paste', enabled: params.editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll' },
        ]
      : params.selectionText.trim()
        ? [{ role: 'copy' }]
        : []
    if (items.length) Menu.buildFromTemplate(items).popup({ window: w })
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 15 },
    backgroundColor: '#0b0e12',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  })
  load(win, '/app')
  attachContextMenu(win)
  win.on('closed', () => { win = null })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

function showApp(hash) {
  if (!win) createWindow()
  else if (hash) load(win, hash)
  win.show()
  win.focus()
}

function trayIcon(alert) {
  // §13: red alert dot when any automation failed. The alert variant is a
  // pre-rendered non-template PNG (neutral gray glyph + red dot) so the dot
  // stays red on light and dark menu bars; the normal icon is a template.
  const name = alert ? 'trayAlert.png' : 'trayTemplate.png'
  const icon = nativeImage.createFromPath(path.join(__dirname, name))
  icon.setTemplateImage(!alert)
  return icon
}

function createTray() {
  tray = new Tray(trayIcon(false))
  tray.setToolTip('Auto Dave')
  tray.on('click', () => togglePanel())
}

function togglePanel() {
  if (panel && panel.isVisible()) { panel.hide(); return }
  if (!panel) {
    panel = new BrowserWindow({
      width: 334,
      height: 420,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      transparent: true,
      vibrancy: 'menu',
      visualEffectState: 'active',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
    })
    load(panel, '/menubar')
    attachContextMenu(panel)
    panel.on('blur', () => panel.hide())
  }
  const pt = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(pt)
  const x = Math.min(pt.x - 167, display.bounds.x + display.bounds.width - 344)
  panel.setPosition(Math.round(x), display.workArea.y + 6)
  panel.show()
}

ipcMain.handle('backend-info', () => backendInfo())
ipcMain.handle('open-app', (_e, hash) => { showApp(hash); if (panel) panel.hide() })
ipcMain.handle('resize-panel', (_e, h) => {
  if (panel) panel.setSize(334, Math.min(Math.max(Math.round(h), 120), 640))
})
ipcMain.handle('reveal-path', (_e, p) => {
  const abs = p === '~' || p.startsWith('~/')
    ? path.join(os.homedir(), p.slice(1))
    : p
  let isDir = false
  try { isDir = fs.statSync(abs).isDirectory() } catch { /* fall through */ }
  if (isDir) void shell.openPath(abs)
  else shell.showItemInFolder(abs)
})
ipcMain.handle('pick-folder', async (_e, defaultPath) => {
  const opts = { properties: ['openDirectory', 'createDirectory'] }
  if (defaultPath) opts.defaultPath = defaultPath
  const r = await dialog.showOpenDialog(win, opts)
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('set-login-item', (_e, on) => app.setLoginItemSettings({ openAtLogin: !!on }))
ipcMain.handle('tray-alert', (_e, on) => {
  if (tray) tray.setImage(trayIcon(!!on))
})

app.whenReady().then(() => {
  // Dev launches via `electron .`, which ships the default Electron dock icon —
  // replace it with our mark (generated by scripts/gen_app_icon.cjs).
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'appIcon.png'))
  }
  createWindow()
  createTray()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

// §3: quitting the app never stops the backend — we are always a client.
app.on('window-all-closed', () => { /* stay alive in the tray */ })
