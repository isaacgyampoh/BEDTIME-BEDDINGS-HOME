// Starts the real main.js, then inspects the POS window from outside.
process.env.POS_DEV_URL = process.env.POS_DEV_URL || ''
const { app, BrowserWindow } = require('electron')
app.setPath('userData', process.env.SMOKE_UD)
require(require('path').join(__dirname, '../../desktop/main.js'))
app.whenReady().then(() => setTimeout(async () => {
  const w = BrowserWindow.getAllWindows()[0]
  if (!w) { console.log('SMOKE no window'); return app.exit(1) }
  const r = await w.webContents.executeJavaScript(`JSON.stringify({
    bridge: !!window.posDesktop,
    fns: Object.keys(window.posDesktop || {}).filter(k => /print|find|status|Serial/i.test(k)),
    root: document.getElementById('root')?.children.length || 0,
    text: document.body.innerText.slice(0, 60).replace(/\\n+/g, ' / ')
  })`).catch(e => 'exec failed ' + e.message)
  console.log('SMOKE', r)
  const info = await w.webContents.executeJavaScript('window.posDesktop.info()').catch(e => ({ err: e.message }))
  console.log('SMOKE info', JSON.stringify({ serial: info.serial, version: info.version }))
  const ports = await w.webContents.executeJavaScript('window.posDesktop.listSerialPorts()').catch(e => ({ err: e.message }))
  console.log('SMOKE ports', JSON.stringify(ports).slice(0, 200))
  app.exit(0)
}, 6000))
