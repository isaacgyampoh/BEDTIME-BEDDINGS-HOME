import { useEffect, useState } from 'react'
import Modal from './Modal'
import { isDesktop } from '../lib/desktop'
import { callFunction } from '../lib/supabase'

const DISMISS_KEY = 'pos-install-prompt-dismissed'

/** Windows, and not already inside the desktop app. */
export function canInstallDesktop() {
  if (isDesktop()) return false
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const platform = navigator.userAgentData?.platform || navigator.platform || ''
  return /Windows/i.test(ua) || /Win/i.test(platform)
}

const mb = (n) => (Number(n || 0) / 1048576).toFixed(0)

/**
 * Install the Windows desktop app from inside the POS.
 *
 * Staff should never have to find a GitHub page. The version and download link
 * come from the server (GitHub does not send CORS headers on release assets, so
 * the browser cannot read them directly), and the link always points at the
 * newest release — nothing here needs changing when a version ships.
 */
export default function InstallDesktop({ open, onClose }) {
  const [rel, setRel] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open) return
    let live = true
    callFunction('desktop-latest')
      .then(r => { if (!live) return; r?.success ? setRel(r) : setFailed(true) })
      .catch(() => live && setFailed(true))
    return () => { live = false }
  }, [open])

  return (
    <Modal open={open} onClose={onClose} title="Install the desktop app"
      footer={<>
        <button onClick={onClose} className="h-12 px-5 border border-stone-300 rounded-xl text-sm font-semibold text-stone-600">
          Not now
        </button>
        <a
          href={rel?.url || 'https://github.com/isaacgyampoh/BEDTIME-BEDDINGS-HOME/releases/latest'}
          target="_blank" rel="noopener noreferrer"
          onClick={() => { try { localStorage.setItem(DISMISS_KEY, '1') } catch {} }}
          className={`flex-1 h-12 rounded-xl text-sm font-bold flex items-center justify-center transition active:scale-[.98] ${
            rel ? 'bg-[#16181d] hover:bg-[#2a2d34] text-white' : 'bg-gray-200 text-gray-500 pointer-events-none'}`}>
          {rel ? `Download (${mb(rel.size)} MB)` : failed ? 'Unavailable' : 'Checking…'}
        </a>
      </>}>

      <div className="space-y-5">
        <div>
          <p className="text-[14px] text-gray-700 leading-relaxed">
            This terminal is running the POS in a web browser. The desktop app is
            the same POS, but it can reach the till's hardware directly.
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-[#f6f6f5] p-4 space-y-2.5">
          {[
            ['Receipts print straight to the built-in printer',
             'No print dialog and no Windows driver — the reason the browser could only offer OneNote and Fax.'],
            ['Customer screen goes to the second monitor',
             'Placed by the operating system instead of guessed by the browser.'],
            ['Runs full screen, and starts with the machine',
             'No address bar, no tabs to close by accident.'],
            ['Updates itself',
             'You download this file once. Future versions install themselves.'],
          ].map(([t, d]) => (
            <div key={t} className="flex gap-2.5">
              <svg className="flex-shrink-0 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0e7c86" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-gray-800">{t}</div>
                <div className="text-[12px] text-gray-500 leading-snug">{d}</div>
              </div>
            </div>
          ))}
        </div>

        {rel && (
          <div className="text-[12px] text-gray-500">
            Version <span className="font-semibold text-gray-700">{rel.version}</span> · Windows · {mb(rel.size)} MB
          </div>
        )}
        {failed && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[12px] text-amber-800">
            Could not reach the download server. Check the internet connection and try again.
          </div>
        )}

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5">
          <div className="text-[13px] font-bold text-amber-900">Windows will show a warning</div>
          <p className="text-[12px] text-amber-800 mt-1 leading-relaxed">
            A blue <b>“Windows protected your PC”</b> screen appears because the
            installer is not code-signed — not because anything is wrong with it.
            Click <b>More info</b>, then <b>Run anyway</b>.
          </p>
        </div>

        <ol className="text-[12px] text-gray-600 space-y-1.5 list-decimal pl-4">
          <li>Download the file, then double-click it.</li>
          <li>It installs and opens on its own — no administrator password needed.</li>
          <li>Log in with the same staff PIN.</li>
          <li>Set the paper size when prompted and print a test page.</li>
        </ol>
      </div>
    </Modal>
  )
}

/** One-time nudge, shown only on a Windows browser. */
export function useInstallPrompt() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!canInstallDesktop()) return
    try { if (localStorage.getItem(DISMISS_KEY) === '1') return } catch { return }
    const t = setTimeout(() => setShow(true), 4000)   // let the POS load first
    return () => clearTimeout(t)
  }, [])
  const dismiss = () => { try { localStorage.setItem(DISMISS_KEY, '1') } catch {} ; setShow(false) }
  return [show, dismiss]
}
