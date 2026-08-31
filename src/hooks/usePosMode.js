import { useEffect, useState } from 'react'

/**
 * Touch-POS detection.
 *
 * A POS terminal (e.g. the GS-3063 this shop runs) is a big landscape screen
 * driven entirely by finger. It reports a DESKTOP viewport width, so every
 * `md:` breakpoint in the app treats it as a mouse machine — but it has no
 * hover and usually no physical keyboard. That combination is what broke the
 * sidebar (hover-only expansion) and the login screen (focused text inputs).
 *
 * Detection order:
 *   1. explicit per-machine override, so an installer can force either mode
 *   2. the browser's own answer: no hover + coarse pointer
 */

const KEY = 'pos-touch-mode' // '1' = force on, '0' = force off, unset = auto

export function getPosOverride() {
  try {
    const v = localStorage.getItem(KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch { return null }
}

export function setPosOverride(on) {
  try {
    if (on === null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, on ? '1' : '0')
  } catch {}
}

/** True when this machine should get the touch-first POS treatment. */
export function isTouchPOS() {
  const override = getPosOverride()
  if (override !== null) return override
  if (typeof window === 'undefined' || !window.matchMedia) return false
  // `hover: none` is the reliable signal — a touchscreen cannot hover, so any
  // interaction that only appears on hover is unreachable.
  return window.matchMedia('(hover: none)').matches ||
         window.matchMedia('(pointer: coarse)').matches
}

/** True on a phone-sized screen, where the app already has a mobile layout. */
export function isSmallScreen() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(max-width: 767px)').matches
}

/**
 * Reactive version. Also stamps `data-pos="touch"` on <html> so the stylesheet
 * can enlarge tap targets and suppress hover-only affordances without every
 * component needing to know.
 */
export function usePosMode() {
  const [touch, setTouch] = useState(isTouchPOS)

  useEffect(() => {
    const update = () => setTouch(isTouchPOS())
    const queries = ['(hover: none)', '(pointer: coarse)'].map(q => window.matchMedia(q))
    queries.forEach(q => q.addEventListener?.('change', update))
    window.addEventListener('pos-mode-change', update)
    return () => {
      queries.forEach(q => q.removeEventListener?.('change', update))
      window.removeEventListener('pos-mode-change', update)
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.pos = touch ? 'touch' : 'mouse'
  }, [touch])

  return touch
}
