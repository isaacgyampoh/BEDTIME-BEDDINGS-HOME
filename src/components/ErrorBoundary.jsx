import { Component } from 'react'

/**
 * Last line of defence against a blank till.
 *
 * Without this, one exception during render unmounts the entire app and the
 * cashier is left with an empty white screen and no way back but knowing to
 * press F5. The case that proved it: a single malformed item in a saved cart
 * blanked the whole POS at login.
 *
 * The reset clears only what is saved on this terminal for the till itself —
 * carts and held carts — never sales, stock or settings on the server.
 */
const LOCAL_TILL_KEYS = ['carts-by-cashier', 'heldCarts']

export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Kept for whoever reads the console; never shown to the cashier.
    console.error('POS render error:', error, info?.componentStack)
  }

  resetTill = () => {
    try { LOCAL_TILL_KEYS.forEach(k => localStorage.removeItem(k)) } catch { /* storage unavailable */ }
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="fixed inset-0 z-[10000] bg-[#f1f1ee] flex items-center justify-center px-6">
        <div className="bg-white border border-gray-300 rounded-lg max-w-[440px] w-full p-6">
          <h1 className="text-lg font-bold text-gray-900 mb-2">This screen stopped working</h1>
          <p className="text-[14px] text-gray-700 leading-relaxed mb-5">
            No sale has been lost. Reload first. If it happens again, clear the carts
            saved on this till — that removes unfinished and held carts on this
            machine only, not any completed sales.
          </p>
          <div className="flex gap-3 flex-wrap">
            <button onClick={() => window.location.reload()}
              className="flex-1 min-w-[140px] h-12 bg-[#16181d] text-white rounded text-sm font-bold">Reload</button>
            <button onClick={this.resetTill}
              className="flex-1 min-w-[140px] h-12 border border-gray-300 rounded text-sm font-semibold text-gray-800">Clear saved carts</button>
          </div>
        </div>
      </div>
    )
  }
}
