// Render the app/dock icon: accent rounded square + hammer glyph — same mark
// the UI draws (App.tsx) — rasterized via Electron's own Chromium so the
// Font Awesome glyph and oklch accent match exactly.
// Run from app/: ./node_modules/.bin/electron ../scripts/gen_app_icon.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const OUT = path.join(__dirname, '..', 'app', 'electron', 'appIcon.png')
const FONT = path.join(
  __dirname, '..', 'app', 'node_modules',
  '@fortawesome', 'fontawesome-free', 'webfonts', 'fa-solid-900.ttf',
)
const FONT_B64 = fs.readFileSync(FONT).toString('base64')

const SIZE = 1024
// macOS icon grid: mark fills ~80% of the canvas, rest is dock margin.
const SQUARE = Math.round(SIZE * 0.805)
// Corner radius matches the in-app mark (9px at 32px ≈ 28%).
const RADIUS = Math.round(SQUARE * 0.28)

const DRAW = `
  (async () => {
    const font = new FontFace('FAB', 'url(data:font/ttf;base64,${FONT_B64})')
    await font.load()
    document.fonts.add(font)
    const c = document.createElement('canvas')
    c.width = c.height = ${SIZE}
    const ctx = c.getContext('2d')
    const off = (${SIZE} - ${SQUARE}) / 2
    ctx.beginPath()
    ctx.roundRect(off, off, ${SQUARE}, ${SQUARE}, ${RADIUS})
    ctx.fillStyle = 'oklch(0.74 0.155 52)'
    ctx.fill()
    ctx.translate(${SIZE} / 2, ${SIZE} / 2)
    ctx.font = '${Math.round(SQUARE * 0.5)}px FAB'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#0b0d11'
    ctx.fillText('\\uf6e3', 0, 0)
    return c.toDataURL('image/png')
  })()
`

setTimeout(() => { console.error('timed out'); process.exit(1) }, 20000)

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } })
  await win.loadURL('data:text/html,<html></html>')
  const dataUrl = await win.webContents.executeJavaScript(DRAW)
  fs.writeFileSync(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'))
  console.log('wrote ' + OUT)
  process.exit(0)
}).catch((err) => { console.error(err); process.exit(1) })
