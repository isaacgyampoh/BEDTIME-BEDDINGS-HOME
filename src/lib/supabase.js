import { createClient } from '@supabase/supabase-js'
import { classifyStaffLogin, sessionLanded } from './staffLogin'

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
    const verdict = classifyStaffLogin(res)
    if (verdict !== 'accepted') {
      return { ok: false, error: verdict === 'rejected' ? (res.error || 'Incorrect PIN') : null }
    }
    const { error } = await supabaseInstance.auth.setSession({
      access_token: res.session.access_token,
      refresh_token: res.session.refresh_token,
    })
    if (error) return { ok: false, error: null }

    // Confirm the session is really in storage before claiming success.
    //
    // setSession() does not just store what it is given: it fetches
    // GET /auth/v1/user to populate the session, and if that call fails the
    // session is discarded. On this platform that call was blocked for
    // eleven hours after cutover -- self-hosted GoTrue answers a CORS
    // preflight naming any request header with a bare 204 and no
    // Access-Control-* headers, so the browser never sent the request.
    // Hosted Supabase hides this because Kong answers preflights.
    //
    // The visible result was a till signed in against the public anon key:
    // reports at GHS 0.00, no receipts, and 487 denials on whatsapp_orders.
    // So never report a session that is not there -- the caller downgrades
    // and says so instead.
    if (!sessionLanded(await supabaseInstance.auth.getSession())) {
      return { ok: false, error: null }
    }

    return { ok: true, staff: { id: res.id, name: res.name, role: res.role } }
  } catch {
    return { ok: false, error: null }
  }
}

/** True when this browser holds a usable API session, not just a signed-in UI. */
export async function hasApiSession() {
  try {
    const { data } = await supabaseInstance.auth.getSession()
    return !!data?.session?.access_token
  } catch {
    return false
  }
}

/** Drop the staff session. Safe to call when there is none. */
export async function endStaffSession() {
  try { await supabaseInstance.auth.signOut() } catch { /* already gone */ }
}

/**
 * Call a Postgres function, or return null if it is not there.
 *
 * The public order functions (migration 044) scope an anonymous page to the
 * one order whose id it already holds, instead of letting it read the table.
 * Until that migration is applied the functions do not exist, so every caller
 * keeps its original query as a fallback and this returns null to select it.
 * That is what makes it safe to deploy this code before the migration.
 *
 * A function that exists and answers `{ success: false, ... }` is a real
 * answer, not an absence, and is returned as-is.
 */
export async function rpcOrNull(name, args) {
  try {
    const { data, error } = await getSupabase().rpc(name, args)
    if (error) return null
    return data ?? null
  } catch {
    return null
  }
}


/**
 * Restore the signed-in cashier from a session that is already in storage.
 *
 * The Supabase client persists the session across reloads, but the store's
 * `user` starts null, so every refresh dropped the cashier back to the PIN
 * screen — and each re-entry minted a brand new GoTrue session. The live
 * database showed the result: 19 successful PIN entries in two hours against
 * a handful of sessions.
 *
 * staff-login puts staff_id, staff_name and staff_role in app_metadata, so a
 * valid session already carries everything the till needs. Returns null when
 * there is no session, when it has expired, or when it is not a staff token —
 * in each of which cases the PIN screen is the right answer.
 */
export async function restoreStaffSession() {
  try {
    const { data, error } = await supabaseInstance.auth.getSession()
    if (error) return null
    const session = data?.session
    if (!session?.access_token) return null
    const meta = session.user?.app_metadata || {}
    if (!meta.staff_id) return null
    return { id: String(meta.staff_id), name: meta.staff_name || 'Staff', role: meta.staff_role || 'Cashier' }
  } catch {
    return null
  }
}
