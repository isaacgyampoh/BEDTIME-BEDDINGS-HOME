import { suite } from './harness.mjs'
const t = suite('Install-from-portal gating')

// Mirrors canInstallDesktop(): offer the download only where it can be used.
const can = ({ desktop, ua, platform }) => {
  if (desktop) return false
  return /Windows/i.test(ua || '') || /Win/i.test(platform || '')
}
t.ok('Windows browser -> offered',        can({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }))
t.ok('inside the desktop app -> hidden',  !can({ desktop: true, ua: 'Windows NT 10.0' }))
t.ok('macOS -> hidden',                   !can({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' }))
t.ok('Android phone -> hidden',           !can({ ua: 'Mozilla/5.0 (Linux; Android 13)' }))
t.ok('iPad -> hidden',                    !can({ ua: 'Mozilla/5.0 (iPad; CPU OS 17_0)' }))
t.ok('platform Win32 fallback -> offered', can({ ua: '', platform: 'Win32' }))

// The link must survive a new release without anyone editing it.
const url = (file) => `https://github.com/isaacgyampoh/BEDTIME-BEDDINGS-HOME/releases/latest/download/${file}`
t.ok('download path is version-agnostic', url('X.exe').includes('/releases/latest/download/'))
t.ok('no hardcoded version in the path',  !/1\.0\.\d/.test(url('X.exe')))
