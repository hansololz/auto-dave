// npm postinstall (§14): brand the dev Electron.app so `npx electron .` shows
// "Autowright" in the menu bar / dock / Cmd+Tab. macOS reads the running
// bundle's CFBundleName — app.setName cannot override it — so patch the plist
// in node_modules and ad-hoc re-sign (a modified plist otherwise invalidates
// the signature and the kernel kills the app). Release builds are named by
// @electron/packager instead (prod.sh), which excludes this file.
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

if (process.platform !== 'darwin') process.exit(0)

const bundle = path.join(__dirname, 'node_modules', 'electron', 'dist', 'Electron.app')
const plist = path.join(bundle, 'Contents', 'Info.plist')
if (!fs.existsSync(plist)) process.exit(0)

const buddy = (cmd) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, plist]).toString().trim()

if (buddy('Print :CFBundleName') !== 'Autowright') {
  buddy('Set :CFBundleName Autowright')
  buddy('Set :CFBundleDisplayName Autowright')
  execFileSync('codesign', ['--force', '--sign', '-', bundle])
  console.log('· branded dev Electron.app as "Autowright"')
}
