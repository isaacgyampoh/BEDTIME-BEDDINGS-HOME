import { createClient } from '@supabase/supabase-js'
const url = 'https://wqkgfvmvuljzexhevlnp.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indxa2dmdm12dWxqemV4aGV2bG5wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwMTc5NzEsImV4cCI6MjEwMDU5Mzk3MX0.BOAaKOnE_RaZtTBa_GED793Xn5hdjRxT4hEvG_Ivkpo'
export const supabase = createClient(url, key)

/**
 * Call a Postgres function, or return null if it is not there.
 *
 * Migration 044 replaces the shop's direct reads and writes on whatsapp_orders
 * with functions scoped to a single order, so the public key stops being able
 * to list every customer's name, phone and address. Until it is applied those
 * functions do not exist, so each caller keeps its original query and this
 * returns null to choose it — which is what makes deploying this ahead of the
 * migration safe.
 *
 * A function that answers `{ success: false }` is a real answer, not an
 * absence, and comes back unchanged.
 */
export async function rpcOrNull(name, args) {
  try {
    const { data, error } = await supabase.rpc(name, args)
    if (error) return null
    return data ?? null
  } catch {
    return null
  }
}
