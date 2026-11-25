/**
 * When should the till (re)load the books?
 *
 * Pure, so the rule can be tested without mounting the app.
 *
 * THE BUG THIS ENCODES
 *
 * The data load used to be a bare loadAll() on mount. That runs before anyone
 * has entered a PIN and before a stored session has been restored, so every
 * request went out as `anon`. Since the row policies return zero rows to anon
 * for sales, orders, customers and expenses -- while still answering 200, so
 * nothing throws and no error banner fires -- the store filled with empty
 * arrays and simply stayed that way. Signing in changed nothing, because
 * nothing asked again.
 *
 * Measured on the shop's own phone: 18 amounts on screen, every one GHS 0.00,
 * with a valid session in storage that could read 1,416 sales. A single reload
 * turned the same screen into 673 amounts, 670 of them non-zero.
 *
 * @param {object}  s
 * @param {boolean} s.restoring  still working out whether a session exists
 * @param {string|null} s.userId the signed-in cashier, or null
 * @param {string|null|undefined} s.loadedFor  who the current data was loaded
 *        for; `undefined` means nothing has been loaded yet
 */
export function shouldLoad({ restoring, userId, loadedFor }) {
  // Never load while the identity is still unknown: that is the anon load.
  if (restoring) return false

  // First load, now that we know whether a session was restored.
  if (loadedFor === undefined) return true

  // Somebody signed in, or a different cashier took over the terminal.
  if (userId && userId !== loadedFor) return true

  // Signing out does not reload. The PIN screen is all there is to show, and
  // refetching as anon would only generate denials.
  return false
}
