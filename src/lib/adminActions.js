import { getSupabase } from './supabase'
import { askPin, askConfirm } from '../components/PromptDialog'
import toast from 'react-hot-toast'

/**
 * Delete a row through admin_delete_row.
 *
 * Migration 016 revokes DELETE on these tables from the anon role, because the
 * anon key is public and anyone holding it could otherwise wipe the catalogue.
 * Every delete now proves an admin PIN server-side.
 */
export async function adminDelete(table, id, label) {
  if (!(await askConfirm(`Delete ${label}?`, 'This cannot be undone.'))) return false

  const pin = await askPin('Confirm with your admin PIN', `Deleting ${label}.`)
  if (!pin) return false

  const { data, error } = await getSupabase().rpc('admin_delete_row', {
    p_admin_pin: pin, p_table: table, p_id: id,
  })

  if (error || data?.success === false) {
    toast.error(data?.error || error?.message || 'Delete failed')
    return false
  }
  toast.success('Deleted')
  return true
}
