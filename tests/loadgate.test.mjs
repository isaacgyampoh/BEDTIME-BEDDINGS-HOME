import { suite } from './harness.mjs'
import { shouldLoad } from '../src/lib/loadGate.js'

const t = suite('The books are loaded for whoever is actually signed in')

/**
 * Measured on the shop's own phone before this existed: 18 amounts on screen,
 * every one GHS 0.00, while a valid session sat in storage that could read
 * 1,416 sales. One reload turned the same screen into 673 amounts, 670 of them
 * non-zero. The load had simply run as `anon` before the PIN was entered, and
 * nothing ever asked again.
 */

// --- never load before we know who is asking ------------------------------
t.ok('no load while the session is still being restored',
  !shouldLoad({ restoring: true, userId: null, loadedFor: undefined }))
t.ok('no load while restoring, even with a user already in the store',
  !shouldLoad({ restoring: true, userId: 'staff-1', loadedFor: undefined }))

// --- first load, once the identity has settled ----------------------------
t.ok('loads once restoring finishes with a restored session',
  shouldLoad({ restoring: false, userId: 'staff-1', loadedFor: undefined }))
t.ok('loads once restoring finishes with no session (public pages need data)',
  shouldLoad({ restoring: false, userId: null, loadedFor: undefined }))

// --- signing in must re-ask -----------------------------------------------
t.ok('reloads when a cashier signs in after an anon load',
  shouldLoad({ restoring: false, userId: 'staff-1', loadedFor: null }))
t.ok('reloads when a DIFFERENT cashier takes the terminal',
  shouldLoad({ restoring: false, userId: 'staff-2', loadedFor: 'staff-1' }))

// --- and must not re-ask pointlessly --------------------------------------
t.ok('does not reload for the same cashier',
  !shouldLoad({ restoring: false, userId: 'staff-1', loadedFor: 'staff-1' }))
t.ok('does not reload on sign-out',
  !shouldLoad({ restoring: false, userId: null, loadedFor: 'staff-1' }))
t.ok('does not reload repeatedly while signed out',
  !shouldLoad({ restoring: false, userId: null, loadedFor: null }))
