import { useState } from 'react'
import { useStore } from '../hooks/useStore'
import { getSupabase } from '../lib/supabase'
import Modal from '../components/Modal'
import toast from 'react-hot-toast'
import { askPin, askConfirm } from '../components/PromptDialog'

export default function StaffPage() {
  const { staff, refreshStaff, setLoading } = useStore()
  const [modal, setModal] = useState(false)
  const [form, setForm] = useState({ id: '', name: '', role: 'Cashier', pin: '' })
  // Staff changes are authorised by re-entering an admin PIN. The app has no
  // session token, so this is what proves to the database that the caller is
  // actually an admin rather than anyone holding the public anon key.
  const [adminPin, setAdminPin] = useState('')

  const openNew = () => { setForm({ id: '', name: '', role: 'Cashier', pin: '' }); setAdminPin(''); setModal(true) }
  const openEdit = (s) => { setForm({ id: s.id, name: s.name, role: s.role, pin: '' }); setAdminPin(''); setModal(true) }

  const save = async () => {
    if (!form.name.trim()) { toast.error('Name is required'); return }
    // A new member always needs a PIN. When editing, a blank PIN means
    // "leave the existing one alone" — it no longer forces a reset.
    if (!form.id && form.pin.length !== 4) { toast.error('A 4-digit PIN is required'); return }
    if (form.pin && !/^\d{4}$/.test(form.pin)) { toast.error('PIN must be exactly 4 digits'); return }

    if (!/^\d{4}$/.test(adminPin)) { toast.error('Enter your admin PIN to confirm'); return }

    setLoading(true, 'Saving...'); const sb = getSupabase()
    // admin_save_staff verifies the admin PIN server-side, hashes the new PIN
    // and enforces the last-admin rule. The `pin` column is never written from
    // the browser.
    const { data, error } = await sb.rpc('admin_save_staff', {
      p_admin_pin: adminPin,
      p_name: form.name.trim(),
      p_role: form.role,
      p_pin: form.pin || null,
      p_id: form.id || null,
      p_active: true,
    })

    setLoading(false)
    if (error || data?.success === false) { toast.error(data?.error || error?.message || 'Save failed'); return }
    await refreshStaff(); setModal(false); setAdminPin(''); toast.success('Saved!')
  }

  const del = async (s) => {
    // Deleting the only remaining admin would lock everyone out of the
    // admin-only pages. Checked here for a clear message and again server-side.
    const activeAdmins = staff.filter(x => x.role === 'Admin' && x.active !== false)
    if (s.role === 'Admin' && activeAdmins.length <= 1) {
      toast.error('Cannot delete the last admin — add another admin first')
      return
    }
    if (!(await askConfirm(`Delete ${s.name}?`, 'This cannot be undone.'))) return
    const pin = await askPin('Confirm with your admin PIN', `Deleting ${s.name}.`)
    if (!pin) return

    setLoading(true); const sb = getSupabase()
    const { data, error } = await sb.rpc('admin_delete_staff', { p_admin_pin: pin, p_id: s.id })
    await refreshStaff(); setLoading(false)
    if (error || data?.success === false) toast.error(data?.error || error?.message || 'Delete failed')
    else toast.success('Deleted!')
  }

  return (
    <div >
      <div className="flex justify-between items-start flex-wrap gap-4 mb-6">
        <h1 className="text-[22px] md:text-[26px] font-bold">Staff</h1>
        <button onClick={openNew} className="h-12 px-5 bg-gray-700 text-white rounded-xl text-sm font-semibold">Add</button>
      </div>
      <div className="bg-white rounded-2xl p-6 shadow-md overflow-x-auto">
        <table className="w-full min-w-[300px]">
          <thead><tr><th className="p-3 bg-gray-50 text-left text-[11px] font-bold text-gray-500 uppercase">Name</th><th className="p-3 bg-gray-50 text-left text-[11px] font-bold text-gray-500 uppercase">Role</th><th className="p-3 bg-gray-50 text-[11px] font-bold text-gray-500 uppercase">Actions</th></tr></thead>
          <tbody>{staff.map(s => (
            <tr key={s.id} className="border-b border-gray-50">
              <td className="p-3 text-sm font-semibold">{s.name}</td>
              <td className="p-3"><span className={`px-2.5 py-1 rounded-lg text-[11px] font-bold ${s.role === 'Admin' ? 'bg-gray-100 text-gray-600' : 'bg-green-50 text-green-500'}`}>{s.role}</span></td>
              <td className="p-3"><div className="flex gap-2 justify-center"><button onClick={() => openEdit(s)} className="h-9 px-3 border border-stone-300 rounded-lg text-xs font-medium text-stone-600 hover:bg-stone-100 transition">Edit</button><button onClick={() => del(s)} className="h-9 px-3 bg-red-500 text-white rounded-lg text-xs font-medium hover:bg-red-600 transition">Delete</button></div></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <Modal open={modal} onClose={() => setModal(false)} title={form.id ? 'Edit Staff' : 'Add Staff'}
        footer={<><button onClick={() => setModal(false)} className="h-12 px-5 border border-stone-300 rounded-xl text-sm font-semibold text-stone-600">Cancel</button><button onClick={save} className="flex-1 h-12 bg-gray-700 text-white rounded-xl text-sm font-bold">Save</button></>}>
        <div className="space-y-4">
          <div><label className="block text-xs font-semibold text-gray-500 mb-2">Name</label><input className="w-full h-13 px-4 bg-gray-50 border-2 border-gray-200 rounded-xl text-base" value={form.name} onChange={e => setForm({...form, name: e.target.value})} /></div>
          <div><label className="block text-xs font-semibold text-gray-500 mb-2">Role</label><select className="w-full h-13 px-4 bg-gray-50 border-2 border-gray-200 rounded-xl text-base" value={form.role} onChange={e => setForm({...form, role: e.target.value})}><option>Cashier</option><option>Admin</option></select></div>
          <div><label className="block text-xs font-semibold text-gray-500 mb-2">PIN (4 digits)</label><input type="tel" inputMode="numeric" maxLength={4} placeholder={form.id ? 'Leave blank to keep current PIN' : 'e.g. 1024'} className="w-full h-13 px-4 bg-gray-50 border-2 border-gray-200 rounded-xl text-base" value={form.pin} onChange={e => setForm({...form, pin: e.target.value.replace(/\D/g, '')})} /></div>
          <div className="pt-3 border-t border-gray-100">
            <label className="block text-xs font-semibold text-gray-500 mb-2">Confirm with your admin PIN</label>
            <input type="password" inputMode="numeric" maxLength={4} placeholder="••••" className="w-full h-13 px-4 bg-gray-50 border-2 border-gray-200 rounded-xl text-base tracking-widest" value={adminPin} onChange={e => setAdminPin(e.target.value.replace(/\D/g, ''))} />
            <p className="text-xs text-gray-400 mt-1.5">Required to add or change a staff member.</p>
          </div>
        </div>
      </Modal>
    </div>
  )
}
