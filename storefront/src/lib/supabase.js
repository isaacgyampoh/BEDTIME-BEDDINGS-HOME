import { createClient } from '@supabase/supabase-js'
// Read from Vite env when provided, so the shop can be pointed at a different
// project without editing code — matching how the POS already does it.
//
// This mattered on 26 October 2026: the project was deleted and the shop served
// an empty catalogue for as long as it took to get it back. Had it been
// restored into a NEW project, the shop could not have been repointed without a
// code change and a rebuild. The current project stays the default, so existing
// deploys keep working with no configuration.
const url = import.meta.env.VITE_SUPABASE_URL || 'https://wqkgfvmvuljzexhevlnp.supabase.co'
const key = import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indxa2dmdm12dWxqemV4aGV2bG5wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwMTc5NzEsImV4cCI6MjEwMDU5Mzk3MX0.BOAaKOnE_RaZtTBa_GED793Xn5hdjRxT4hEvG_Ivkpo'

export const SUPABASE_URL = url
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
