import { useState, useEffect } from 'react'
import { useStore } from '../hooks/useStore'
import { getSupabase } from '../lib/supabase'
import { usePosMode } from '../hooks/usePosMode'
import Keypad from './Keypad'
import { Logo } from './Logo'

export default function Login() {
  // Single PIN string rather than four focused <input>s. A POS terminal has no
  // physical keyboard and a desktop-mode browser will not raise the OS touch
  // keyboard, so the old focus-driven inputs could not be filled at all.
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { login, setPage } = useStore()
  const touchPOS = usePosMode()

  const submit = async (candidate) => {
    if (loading) return
    setLoading(true)
    setError('')
    try {
      const sb = getSupabase()
      const { data } = await sb.rpc('verify_pin', { p_pin: candidate })
      if (data?.success) {
        const isAdmin = data.role === 'Admin'
        // The login tap is the user gesture browsers require for fullscreen.
        // Running kiosk-style removes the title bar on the terminal.
        try {
          if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
            await document.documentElement.requestFullscreen()
          }
        } catch {}
        login({ id: data.id, name: data.name, role: data.role }, isAdmin)
        setPage(isAdmin ? 'dash' : 'pos')
        return
      }
      // The server now returns a message when the throttle trips.
      setError(data?.error || 'Incorrect PIN. Please try again.')
    } catch {
      setError('Could not reach the server. Check the connection.')
    }
    setLoading(false)
    setPin('')
  }

  // Auto-submit on the 4th digit, matching the old behaviour.
  useEffect(() => {
    if (pin.length === 4 && !loading) submit(pin)
  }, [pin]) // eslint-disable-line

  const handleChange = (next) => {
    if (loading) return
    if (error) setError('')
    setPin(next.slice(0, 4))
  }

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-[#f6f6f5] px-6 py-6 overflow-y-auto">
      <div className={`w-full text-center ${touchPOS ? 'max-w-[420px]' : 'max-w-[380px]'}`}>

        {/* Logo — trimmed on short POS screens so the keypad always fits */}
        <div className="mb-6 md:mb-8 flex justify-center">
          <Logo height={touchPOS ? 76 : 104} tagline={true} />
        </div>

        <p className="text-[#5e6b62] text-[15px] mb-5 tracking-wide">Enter your staff PIN</p>

        {error && (
          <div className="bg-[#fbeae6] text-[#c0492f] px-4 py-3 rounded-2xl mb-5 text-[13px] font-medium" role="alert">
            {error}
          </div>
        )}

        {/* PIN dots */}
        <div className="flex gap-4 justify-center mb-6">
          {[0, 1, 2, 3].map(i => {
            const filled = i < pin.length
            const next = i === pin.length && !loading
            return (
              <div key={i}
                className="w-16 h-16 rounded-2xl border-2 flex items-center justify-center transition-all duration-200"
                style={{
                  borderColor: filled ? '#16181d' : next ? '#8fb39e' : '#dde2dc',
                  background: filled ? '#16181d' : '#fafafa',
                }}>
                {filled && <div className="w-2.5 h-2.5 rounded-full bg-white" />}
              </div>
            )
          })}
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-7 h-7 border-[2.5px] border-[#dde2dc] border-t-[#16181d] rounded-full animate-spin" />
          </div>
        ) : (
          // The keypad is always shown: it is the only input method on a
          // keyboard-less terminal, and it also captures real keystrokes so a
          // USB numpad or a laptop keyboard keeps working.
          <Keypad
            value={pin}
            onChange={handleChange}
            maxLength={4}
            size={touchPOS ? 'lg' : 'md'}
            className="mx-auto max-w-[300px]"
          />
        )}
      </div>
    </div>
  )
}
