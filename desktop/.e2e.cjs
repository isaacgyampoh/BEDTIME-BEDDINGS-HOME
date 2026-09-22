// Drives the real web app in Chromium as "Chrome on a Windows touch till".
const { app, BrowserWindow, session } = require('electron')
const URL = process.argv[2]
const MODE = process.argv[3] || 'touch'       // 'touch' | 'mouse'
app.disableHardwareAcceleration()
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
app.on('ready', async () => {
  // Never let the probe write a sale to production.
  const blocked = []
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*.supabase.co/rest/v1/rpc/record_sale*', '*://*.supabase.co/functions/*'] }, (d, cb) => { blocked.push(d.url.split('?')[0].split('/').pop()); cb({ cancel: true }) })
  const w = new BrowserWindow({ show: false, width: 1366, height: 768, webPreferences: { } })
  w.webContents.setUserAgent(WIN_UA)
  const logs = []
  w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) logs.push(msg.slice(0, 200)) })
  console.log('step: loading'); await w.loadURL(URL); console.log('step: loaded')
  const dbg = w.webContents.debugger; dbg.attach('1.3')
  if (MODE === 'touch') {
    await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 10 })
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }, { name: 'any-pointer', value: 'coarse' }, { name: 'any-hover', value: 'none' }] }).catch(e => console.log('media emu:', e.message))
    await w.webContents.executeJavaScript('location.reload()').catch(() => {})
    await sleep(2500)
    console.log('step: touch on; media coarse =', await w.webContents.executeJavaScript("matchMedia('(pointer: coarse)').matches + ' hover-none=' + matchMedia('(hover: none)').matches"))
  }
  await sleep(1500)
  const js = (s, label='js') => Promise.race([w.webContents.executeJavaScript(s), sleep(8000).then(() => { throw new Error('TIMEOUT ' + label) })])
  console.log('step: login'); await js(`(async () => {
    const m = await import('/src/hooks/useStore.js')
    window.__store = m.useStore
    m.useStore.getState().login({ id: 'probe', name: 'Probe', role: 'Cashier' }, false)
    m.useStore.getState().setPage('pos')
  })()`)
  console.log('step: waiting for products')
  for (let i = 0; i < 30; i++) { await sleep(500); if (await js(`document.querySelectorAll('main button, .content-shell button').length > 20`)) break }
  await sleep(1500)
  console.log('step: probing'); const probe = await js(`(() => {
    const s = window.__store.getState()
    const cards = [...document.querySelectorAll('button')].filter(b => b.querySelector('.aspect-\\\\[4\\\\/3\\\\]') && !b.disabled)
    const c = cards[0]; if (!c) return { products: s.products.length, cards: 0, pos: document.documentElement.dataset.pos }
    c.scrollIntoView({ block: 'center' })
    const r = c.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    let chain = [], n = hit; while (n && chain.length < 6) { chain.push(n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ').slice(0,3).join('.') : '')); n = n.parentElement }
    return { products: s.products.length, cards: cards.length, pos: document.documentElement.dataset.pos, x, y, hitIsCard: c.contains(hit), hitChain: chain, cartBefore: s.cart.length, name: c.innerText.split('\\n')[0] }
  })()`)
  console.log('PROBE', JSON.stringify(probe, null, 1))
  await sleep(4000)
  console.log('MODAL', await js(`(() => {
    const ov = [...document.querySelectorAll('div')].find(d => (d.className || '').toString().includes('z-[400]')); if (!ov) return 'none'
    const panel = ov.querySelector('.pos-modal'); const r = panel && panel.getBoundingClientRect(); const cs = panel && getComputedStyle(panel)
    return JSON.stringify({ title: ov.querySelector('h3') && ov.querySelector('h3').innerText, panelRect: r && [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], opacity: cs && cs.opacity, visibility: cs && cs.visibility, animation: cs && cs.animationName, viewport: [innerWidth, innerHeight] })
  })()`, 'modal'))
  if (probe.cards) {
    if (MODE === 'touch') {
      await dbg.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: probe.x, y: probe.y }] })
      await sleep(60)
      await dbg.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else {
      w.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(probe.x), y: Math.round(probe.y), button: 'left', clickCount: 1 })
      w.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(probe.x), y: Math.round(probe.y), button: 'left', clickCount: 1 })
    }
    await sleep(800)
    console.log('CART AFTER TAP', await js(`window.__store.getState().cart.length`))
  }
  console.log('ERRORS', JSON.stringify(logs.filter(l => !/Security Warning|Realtime send|DevTools|React Router|download the React/.test(l)).slice(0, 8), null, 1))
  app.exit(0)
})
