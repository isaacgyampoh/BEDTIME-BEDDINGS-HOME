import { createClient } from '@supabase/supabase-js'

// Read from Vite env when provided so the project can be rotated/pointed at a
// staging instance without a code change. Falls back to the live project so
// existing deploys keep working with no env configuration.
export const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || 'https://wqkgfvmvuljzexhevlnp.supabase.co'

const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indxa2dmdm12dWxqemV4aGV2bG5wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwMTc5NzEsImV4cCI6MjEwMDU5Mzk3MX0.BOAaKOnE_RaZtTBa_GED793Xn5hdjRxT4hEvG_Ivkpo'

/** Base URL for the deployed Edge Functions (the `super-service` router). */
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1/super-service`

/** Public storage base for the product-images bucket. */
export const STORAGE_URL = `${SUPABASE_URL}/storage/v1/object/public`

/** Call an Edge Function action and return the parsed JSON body. */
export async function callFunction(action, body) {
  const res = await fetch(`${FUNCTIONS_URL}?action=${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res.json()
}

const supabaseInstance = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Staff sign in with a PIN, which the server exchanges for a real session
    // (see startStaffSession). Persisting it means a refresh or a reopened
    // browser on the terminal does not drop the cashier back to `anon`.
    persistSession: true,
    autoRefreshToken: true,
    // Nothing here uses email links or OAuth redirects, and the POS runs on a
    // hash router, so leave the URL alone.
    detectSessionInUrl: false,
  },
})

export function getSupabase() {
  return supabaseInstance
}

/**
 * Exchange a verified PIN for a Supabase session.
 *
 * Until every staff member has one of these, the row policies cannot
 * distinguish the admin portal from a stranger holding the public key, because
 * both arrive as `anon`. Returns the staff record on success.
 *
 * Deliberately falls back: if the function is unreachable or the project has
 * not been migrated yet, this returns null and the caller carries on with the
 * old verify_pin path, so a till can always sell.
 */
export async function startStaffSession(pin) {
  try {
    const res = await callFunction('staff-login', { pin })
    if (res?.success && res?.session) {
      // fall through to setSession below
    } else {
      // Only a response that actually carries `success: false` is a verdict on
      // the PIN. Anything else — a router that does not know this action yet
      // because the function has not been deployed, a gateway error, an HTML
      // error page — is an infrastructure failure, and the caller must fall
      // back to verify_pin rather than show the cashier whatever came back.
      // The router's own "unknown action" reply has no `success` key at all,
      // which is exactly the case this distinguishes.
      const rejected = typeof res?.success === 'boolean' && res.success === false
      return { ok: false, error: rejected ? (res.error || 'Incorrect PIN') : null }
    }
    const { error } = await supabaseInstance.auth.setSession({
      access_token: res.session.access_token,
      refresh_token: res.session.refresh_token,
    })
    if (error) return { ok: false, error: null }
    return { ok: true, staff: { id: res.id, name: res.name, role: res.role } }
  } catch {
    return { ok: false, error: null }
  }
}

/** Drop the staff session. Safe to call when there is none. */
export async function endStaffSession() {
  try { await supabaseInstance.auth.signOut() } catch { /* already gone */ }
}
