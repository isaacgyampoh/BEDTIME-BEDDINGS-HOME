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

const supabaseInstance = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

export function getSupabase() {
  return supabaseInstance
}
