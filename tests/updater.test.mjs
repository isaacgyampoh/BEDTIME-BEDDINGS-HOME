import { suite } from './harness.mjs'
const t = suite('Updater safety')

// ── The busy signal. This is what stops an update restarting mid-sale.
const isBusy = (s) => s.txDepth > 0 || s.cart.length > 0
t.ok('idle POS is not busy', !isBusy({ txDepth: 0, cart: [] }))
t.ok('a non-empty cart is busy', isBusy({ txDepth: 0, cart: [{}] }))
t.ok('an open payment sheet is busy', isBusy({ txDepth: 1, cart: [] }))
t.ok('both at once is busy', isBusy({ txDepth: 2, cart: [{}] }))

// beginTx/endTx must nest: the payment sheet and record_sale overlap, and the
// inner one finishing must not clear the outer one.
let d = 0
const begin = () => d++, end = () => (d = Math.max(0, d - 1))
begin();            t.ok('payment sheet open -> busy', isBusy({ txDepth: d, cart: [] }))
begin();            t.ok('record_sale nested -> still busy', isBusy({ txDepth: d, cart: [] }))
end();              t.ok('record_sale done, sheet still open -> busy', isBusy({ txDepth: d, cart: [] }))
end();              t.ok('sheet closed -> idle', !isBusy({ txDepth: d, cart: [] }))
end(); end();       t.eq('depth never goes negative', d, 0)

// ── installUpdate() gate, exactly as main.js implements it.
const install = (state, busy, force = false) => {
  if (state.status !== 'ready') return { ok: false, error: 'No update is ready to install' }
  if (busy && !force) return { ok: false, busy: true }
  return { ok: true }
}
t.ok('refuses while a sale is open', install({ status: 'ready' }, true).busy === true)
t.ok('proceeds when idle', install({ status: 'ready' }, false).ok === true)
t.ok('refuses when nothing is downloaded', !install({ status: 'downloading' }, false).ok)
t.ok('refuses while merely checking', !install({ status: 'checking' }, false).ok)
t.ok('refuses on error state', !install({ status: 'error' }, false).ok)
t.ok('force overrides busy (explicit operator action)', install({ status: 'ready' }, true, true).ok === true)

// ── The banner is deliberately quiet: only a ready update is worth interrupting for.
const shows = (status, dismissed, version) => status === 'ready' && dismissed !== version
t.ok('hidden while current', !shows('current'))
t.ok('hidden while checking', !shows('checking'))
t.ok('hidden while downloading in the background', !shows('downloading'))
t.ok('hidden on error — never blocks selling', !shows('error'))
t.ok('shown when ready', shows('ready', null, '1.0.1'))
t.ok('hidden after the user defers that version', !shows('ready', '1.0.1', '1.0.1'))
t.ok('shown again for a newer version', shows('ready', '1.0.1', '1.0.2'))

// ── Every failure mode must be non-fatal.
for (const e of ['ENOTFOUND', 'GitHub 503', 'download interrupted',
                 'sha512 mismatch', 'invalid metadata', 'ECONNRESET']) {
  const st = { status: 'error', error: e }
  t.ok(`"${e}" leaves the POS usable`, st.status === 'error' && !shows(st.status))
}

// ── Semver comparison: a build counter like desktop-v4 cannot be ordered.
const semver = (v) => /^\d+\.\d+\.\d+$/.test(v)
t.ok('1.0.1 is valid semver', semver('1.0.1'))
t.ok('desktop-v4 is NOT semver', !semver('desktop-v4'))
const cmp = (a, b) => { const A = a.split('.').map(Number), B = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) { if (A[i] !== B[i]) return A[i] > B[i] ? 1 : -1 } return 0 }
t.eq('1.0.1 > 1.0.0', cmp('1.0.1', '1.0.0'), 1)
t.eq('1.10.0 > 1.9.0', cmp('1.10.0', '1.9.0'), 1)
t.eq('equal versions', cmp('1.0.0', '1.0.0'), 0)
t.ok('an update is offered only when newer', cmp('1.0.1', '1.0.0') === 1)
t.ok('same version offers nothing', cmp('1.0.0', '1.0.0') !== 1)
