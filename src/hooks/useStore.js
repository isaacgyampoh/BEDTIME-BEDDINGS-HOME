import { create } from 'zustand'
import { isAuthFailure } from '../lib/authFailure.js'
import { getSupabase, endStaffSession } from '../lib/supabase'
import { orderCounts, unbookedPaid, tableCount } from '../lib/counts'
import { num } from '../lib/utils'
import { sanitizeCart } from '../lib/cartSafety'

const mapProduct = p => ({ id: p.id, name: p.name, category: p.category || '', costPrice: num(p.cost_price), price: num(p.price), wholesalePrice: num(p.wholesale_price), wholesaleMinQty: num(p.wholesale_min_qty) || 0, quantity: num(p.quantity), image: p.image || '', groupTag: (p.group_tag || '').trim().toLowerCase(), description: p.description || '' })

// Recalculate pricing across the whole cart.
// NOTE: automatic wholesale grouping is currently DISABLED — every line stays
// at its retail price. Re-enable by restoring the group-quantity logic here.
function applyWholesale(cart, products) {
  const prodById = {}
  for (const p of products) prodById[p.id] = p
  return cart.filter(Boolean).map(c => {
    if (c.isBundle) return { ...c, lineTotal: c.qty * c.price }
    const prod = prodById[c.productId]
    const retail = c.originalPrice || (prod ? prod.price : c.price)
    return { ...c, price: retail, lineTotal: c.qty * retail }
  })
}
const mapBundle = b => ({ id: b.id, name: b.name, products: typeof b.products === 'string' ? JSON.parse(b.products) : (b.products || []), bundlePrice: num(b.bundle_price), active: b.active })
const mapSale = s => ({ id: s.id, receiptNo: s.receipt_no, date: s.date, items: typeof s.items === 'string' ? JSON.parse(s.items) : (s.items || []), subtotal: num(s.subtotal), discount: num(s.discount), total: num(s.total), profit: num(s.profit), payment: s.payment, splitCash: num(s.split_cash), splitMomo: num(s.split_momo), customer: s.customer || 'Walk-in', type: s.type || 'Retail', cashier: s.cashier || '', voided: s.voided })
const mapStaff = s => ({ id: s.id, name: s.name, role: s.role, active: s.active })
const mapExpense = e => ({ id: e.id, date: e.date, category: e.category, description: e.description, amount: num(e.amount) })
const mapCustomer = c => ({ id: c.id, phone: c.phone, visitCount: num(c.visit_count), totalSpent: num(c.total_spent), lastVisit: c.last_visit })
const mapWAOrder = o => ({ id: o.id, orderNo: o.order_no, date: o.date, customerName: o.customer_name, customerPhone: o.customer_phone, items: typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []), subtotal: num(o.subtotal), deliveryFee: num(o.delivery_fee), total: num(o.total), address: o.address, notes: o.notes, status: o.status, paystackRef: o.paystack_ref, paidAt: o.paid_at, processedBy: o.processed_by, processedAt: o.processed_at, ussdCode: o.ussd_code, trackingNo: o.tracking_no || '', deliveryStatus: o.delivery_status || '', deliveryGuy: o.delivery_guy || '', deliveredAt: o.delivered_at, deliveryNotes: o.delivery_notes || '', source: o.source || (String(o.order_no||'').startsWith('WEB-') ? 'web' : String(o.order_no||'').startsWith('WA-') ? 'whatsapp' : 'walkin'), detailsFilled: !!o.details_filled, saleReceiptNo: o.sale_receipt_no || null })
const mapRefund = r => ({ id: r.id, refundNo: r.refund_no, date: r.date, originalReceiptNo: r.original_receipt_no, items: typeof r.items === 'string' ? JSON.parse(r.items) : (r.items || []), refundAmount: num(r.refund_amount), reason: r.reason, processedBy: r.processed_by, customer: r.customer, status: r.status })
const mapPromo = p => ({ id: p.id, name: p.name, startDate: p.start_date, endDate: p.end_date, items: typeof p.items === 'string' ? JSON.parse(p.items) : (p.items || []), active: p.active })
const mapInvoice = i => ({ id: i.id, invoiceId: i.invoice_id, date: i.date, supplier: i.supplier, amount: num(i.amount), notes: i.notes, image: i.image || '' })
const mapStockTake = s => ({ id: s.id, date: s.date, items: typeof s.items === 'string' ? JSON.parse(s.items) : (s.items || []), notes: s.notes, conductedBy: s.conducted_by })
const mapStockAdj = a => ({ id: a.id, date: a.date, productId: a.product_id, productName: a.product_name, qty: num(a.qty), reason: a.reason, notes: a.notes, adjustedBy: a.adjusted_by })

// Fast query with select only needed columns where possible. Failures come
// back as [] so one secondary table cannot stop the till loading — which is
// right for most tables and wrong for products (see loadAll).
const failedTables = new Set()

// The detector lives in its own module so it can be tested without pulling
// the whole store (and its Vite-resolved imports) into Node.
let onAuthFailure = () => {}
export function setAuthFailureHandler(fn) { onAuthFailure = typeof fn === 'function' ? fn : () => {} }
const q = async (sb, table, opts = {}) => {
  try {
    let query = sb.from(table).select(opts.select || '*')
    if (opts.order) query = query.order(opts.order, { ascending: opts.asc ?? false })
    if (opts.limit) query = query.limit(opts.limit)
    if (opts.gt) query = query.gt(opts.gt[0], opts.gt[1])
    const { data, error } = await query
    if (error) {
      console.warn(`[store] ${table} query failed:`, error.message)
      failedTables.add(table)
      if (isAuthFailure(error)) onAuthFailure(table, error)
      return []
    }
    return data || []
  } catch (e) { console.warn(`[store] ${table} query threw:`, e); failedTables.add(table); return [] }
}

/**
 * Every row in a table, fetched a page at a time.
 *
 * WHY THIS REPLACED A `limit`
 * The money figures were computed from arrays that had been capped: sales at
 * 500 rows of 1,137. Ordered newest-first, that window reached back only to
 * 6 October 2026 while the shop's first sale was 15 August — so "All Time
 * revenue" on the front page read GHS 255,153 against an actual GHS 526,690,
 * and a report run for August or September came back empty. The arithmetic was
 * never wrong; it was given half the books.
 *
 * Paging the whole table costs about 140 KB gzipped for 1,137 sales — less
 * than one product photo — because only the needed columns are selected and
 * the response compresses well.
 *
 * CEIL is a safety stop, not a limit anyone should reach: at this shop's rate
 * it is roughly twenty years of trading. If it is ever hit the table is
 * reported as truncated rather than quietly short, so a screen can say the
 * figure is partial instead of presenting it as fact.
 */
const PAGE = 1000
const CEIL = 25000
const truncatedTables = new Set()

const qAll = async (sb, table, opts = {}) => {
  const rows = []
  truncatedTables.delete(table)
  for (let from = 0; from < CEIL; from += PAGE) {
    let query = sb.from(table).select(opts.select || '*')
    if (opts.order) query = query.order(opts.order, { ascending: opts.asc ?? false })
    // A stable tiebreak: two sales recorded in the same millisecond must not
    // be able to swap places between pages, or one is fetched twice and the
    // other never. Ordering by date alone made that possible.
    query = query.order('id', { ascending: false })
    try {
      const { data, error } = await query.range(from, from + PAGE - 1)
      if (error) {
        console.warn(`[store] ${table} page ${from} failed:`, error.message)
        failedTables.add(table)
        if (isAuthFailure(error)) onAuthFailure(table, error)
        // Pages already fetched are real rows, but the set is incomplete.
        if (rows.length) truncatedTables.add(table)
        return rows
      }
      const page = data || []
      rows.push(...page)
      if (page.length < PAGE) return rows
    } catch (e) {
      console.warn(`[store] ${table} page ${from} threw:`, e)
      failedTables.add(table)
      if (rows.length) truncatedTables.add(table)
      return rows
    }
  }
  console.warn(`[store] ${table} hit the ${CEIL}-row ceiling; figures are partial`)
  truncatedTables.add(table)
  return rows
}

/** Which tables came back incomplete, so a screen can mark its totals. */
export const isTruncated = (table) => truncatedTables.has(table)

export const useStore = create((set, get) => ({
  // Set when a data load fails because the session is gone. The UI shows a
  // banner instead of an empty till, which is the whole point.
  authExpired: false,
  setAuthExpired: v => set({ authExpired: !!v }),
  // Set when a cashier is signed in to the UI but this browser holds no API
  // session, which is a different fault from an expired one and needs saying
  // differently. It happens when staff-login succeeds server-side but the
  // session cannot be stored, and Login falls back to a bare verify_pin.
  //
  // It is not a cosmetic distinction. Since the row policies were tightened,
  // `anon` has no INSERT on sales and no SELECT at all on whatsapp_orders, so
  // a sessionless till cannot record a sale and reads the books as empty --
  // and PostgREST answers an RLS-denied SELECT with 200 and zero rows, so
  // nothing raises an error for the expired-session banner to catch. Reports
  // simply render GHS 0.00 as though the shop had sold nothing.
  sessionMissing: false,
  setSessionMissing: v => set({ sessionMissing: !!v }),
  products: [], bundles: [], sales: [], staff: [], expenses: [],
  customers: [], waOrders: [], refunds: [], promos: [], invoices: [], stockTakes: [], stockAdjustments: [],
  loading: true, loadingText: 'Connecting...',
  user: null, isAdmin: false, loadError: '',
  page: 'pos', cart: [], mode: 'retail', selectedCat: 'all', waFilter: 'Pending', perfPeriod: 'today',
  // Counts the operations that must not be interrupted by an app restart:
  // taking a payment, recording a sale, printing, adjusting stock. Components
  // bracket their critical section with beginTx()/endTx(). A non-empty cart
  // counts as busy on its own.
  txDepth: 0,
  _secondaryLoaded: false,
  darkMode: localStorage.getItem('pos-dark') === 'true',
  toggleDark: () => set(s => { const d = !s.darkMode; localStorage.setItem('pos-dark', d); return { darkMode: d } }),

  setPage: page => {
    set({ page })
    // Lazy load secondary data when navigating to those pages
    const s = get()
    if (!s._secondaryLoaded && ['reports', 'invoices', 'stocktakes', 'stockadjustments', 'promos', 'customers'].includes(page)) {
      s._loadSecondary()
    }
  },
  beginTx: () => set(s => ({ txDepth: s.txDepth + 1 })),
  endTx: () => set(s => ({ txDepth: Math.max(0, s.txDepth - 1) })),
  isBusy: () => { const s = get(); return s.txDepth > 0 || s.cart.length > 0 },

  setMode: mode => set({ mode }), setCat: cat => set({ selectedCat: cat }),
  setWAFilter: f => set({ waFilter: f }), setPerfPeriod: p => set({ perfPeriod: p }),
  setLoading: (loading, text) => set({ loading, loadingText: text || 'Loading...' }),
  // Per-cashier carts: when a cashier logs out, their cart
  // is stashed under their id. When they log back in, it's restored. A DIFFERENT
  // cashier logging in gets their own cart (fresh if none saved). Kept in memory
  // + localStorage so it survives the session.
  login: (user, isAdmin) => {
    let restored = []
    try {
      const saved = JSON.parse(localStorage.getItem('carts-by-cashier') || '{}')
      restored = sanitizeCart(saved && saved[user.id])
    } catch {}
    set({ user, isAdmin, cart: restored })
  },
  logout: () => {
    const { user, cart } = get()
    if (user) {
      try {
        const saved = JSON.parse(localStorage.getItem('carts-by-cashier') || '{}')
        saved[user.id] = cart || []
        localStorage.setItem('carts-by-cashier', JSON.stringify(saved))
      } catch {}
    }
    // Drop the Supabase session as well, or the next person at the terminal
    // inherits the last cashier's access. Fire-and-forget: signing out must
    // never be able to hold up the screen returning to the PIN pad.
    endStaffSession()
    set({ user: null, isAdmin: false, cart: [] })
  },

  // Shop on/off switch (shared with the e-commerce site via store_settings)
  // Figures counted in the database. Null means "not known" — never 0, which
  // would read as a quiet day's trading when a query had simply failed.
  counts: {
    pending: null, paid: null, completed: null, cancelled: null, awaiting: null, total: null,
    // Totals the rest of the app shows as bare numbers. Counted in the
    // database so they do not depend on what finished loading.
    customers: null, sales: null, products: null, unbooked: null,
  },
  refreshCounts: async () => {
    const sb = getSupabase(); if (!sb) return
    const [orders, customers, sales, products, unbooked] = await Promise.all([
      orderCounts(sb),
      tableCount(sb, 'customers'),
      tableCount(sb, 'sales'),
      tableCount(sb, 'products'),
      unbookedPaid(sb),
    ])
    set({ counts: { ...orders, customers, sales, products, unbooked } })
  },

  shopOpen: true,
  shopSettingLoaded: false,
  // What a customer reads on the closed page. The shop front has always shown
  // this; nothing in the POS could ever set it.
  closedMessage: '',
  fetchShopOpen: async () => {
    const sb = getSupabase(); if (!sb) return
    try {
      // closed_message is selected separately so an older database without the
      // column cannot stop the on/off state loading.
      const { data, error } = await sb.from('store_settings').select('shop_open').limit(1)
      if (error) console.error('store_settings read error:', error.message)
      const row = Array.isArray(data) ? data[0] : null
      set({ shopOpen: row ? row.shop_open === true : true, shopSettingLoaded: true })
      const { data: msg } = await sb.from('store_settings').select('closed_message').limit(1)
      const m = Array.isArray(msg) ? msg[0] : null
      if (m && typeof m.closed_message === 'string') set({ closedMessage: m.closed_message })
    } catch (e) { console.error('fetchShopOpen failed:', e); set({ shopSettingLoaded: true }) }
  },

  /** The message customers see while the shop is closed. */
  setClosedMessage: async (message) => {
    const sb = getSupabase(); if (!sb) return { ok: false, error: 'No connection' }
    const previous = get().closedMessage
    const text = String(message || '').trim().slice(0, 300)
    set({ closedMessage: text })
    try {
      const { data, error } = await sb.from('store_settings')
        .upsert({ id: 1, closed_message: text, updated_at: new Date().toISOString() }, { onConflict: 'id' })
        .select('closed_message')
      if (error) { set({ closedMessage: previous }); return { ok: false, error: error.message } }
      const saved = Array.isArray(data) ? data[0] : null
      if (!saved || saved.closed_message !== text) { set({ closedMessage: previous }); return { ok: false, error: 'Save did not persist' } }
      return { ok: true }
    } catch (e) { set({ closedMessage: previous }); return { ok: false, error: String(e) } }
  },
  setShopOpen: async (open) => {
    const sb = getSupabase(); if (!sb) return { ok: false, error: 'No connection' }
    set({ shopOpen: open }) // optimistic
    try {
      // upsert (not update) so a missing row gets created; select back to verify it actually saved
      const { data, error } = await sb.from('store_settings')
        .upsert({ id: 1, shop_open: open, updated_at: new Date().toISOString() }, { onConflict: 'id' })
        .select('shop_open')
      if (error) { set({ shopOpen: !open }); console.error('setShopOpen error:', error.message); return { ok: false, error: error.message } }
      const saved = Array.isArray(data) ? data[0] : null
      if (!saved || saved.shop_open !== open) { set({ shopOpen: !open }); return { ok: false, error: 'Save did not persist (check table/permissions)' } }
      return { ok: true }
    } catch (e) { set({ shopOpen: !open }); console.error('setShopOpen failed:', e); return { ok: false, error: String(e) } }
  },

  addToCart: (item) => {
    let cart = [...get().cart]
    const idx = cart.findIndex(c => c && (c.isBundle ? c.bundleId === item.bundleId : c.productId === item.productId))
    if (idx >= 0) {
      const existing = cart[idx]
      if (!item.isBundle) { const prod = get().products.find(p => p.id === item.productId); if (prod && existing.qty >= prod.quantity) return false }
      cart[idx] = { ...existing, qty: existing.qty + 1 }
    } else { cart.push({ ...item, qty: 1, lineTotal: item.price, originalPrice: item.price }) }
    set({ cart: applyWholesale(cart, get().products) }); return true
  },
  updateCartQty: (index, delta) => {
    let cart = [...get().cart]; const item = cart[index]; if (!item) return
    const newQty = item.qty + delta
    if (newQty < 1) { cart.splice(index, 1) }
    else {
      if (!item.isBundle) {
        const prod = get().products.find(p => p.id === item.productId)
        if (prod && newQty > prod.quantity) return false
      }
      cart[index] = { ...item, qty: newQty }
    }
    set({ cart: applyWholesale(cart, get().products) }); return true
  },
  removeFromCart: index => { const cart = [...get().cart]; cart.splice(index, 1); set({ cart: applyWholesale(cart, get().products) }) },
  clearCart: () => {
    const { user } = get()
    if (user) { try { const saved = JSON.parse(localStorage.getItem('carts-by-cashier') || '{}'); delete saved[user.id]; localStorage.setItem('carts-by-cashier', JSON.stringify(saved)) } catch {} }
    set({ cart: [] })
  },

  // PHASE 1: Load only essential data (products, staff, sales, bundles)
  loadAll: async () => {
    const sb = getSupabase(); if (!sb) { set({ loading: false }); return }
    set({ loading: true, loadingText: 'Loading...', loadError: '' })
    failedTables.delete('products')
    try {
      // PHASE 1: Only what POS needs immediately
      const [prodData, staffData, bunData, promoData] = await Promise.all([
        q(sb, 'products', { select: 'id,name,category,cost_price,price,wholesale_price,wholesale_min_qty,quantity,image,group_tag,description', order: 'name', asc: true }),
        q(sb, 'staff_safe', { select: 'id,name,role,active' }),
        q(sb, 'bundles', { select: 'id,name,products,bundle_price,active' }),
        qAll(sb, 'promos', { select: 'id,name,start_date,end_date,items,active', order: 'created_at' }),
      ])

      // Products are the one list the till cannot work without. An empty list
      // because the query failed used to render as "No products found" — which
      // reads as "the shop has no stock", not "this till is offline".
      if (prodData.length === 0 && failedTables.has('products')) {
        set({
          loading: false,
          loadError: typeof navigator !== 'undefined' && navigator.onLine === false
            ? 'This till is offline. Check the internet connection.'
            : 'Unable to connect to the server. Please check your connection.',
        })
        return
      }

      set({
        products: prodData.map(mapProduct),
        staff: staffData.map(mapStaff),
        bundles: bunData.map(mapBundle),
        promos: promoData.map(mapPromo),
        loading: false,
      })

      // PHASE 2: Load everything else in background (non-blocking)
      get()._loadSecondary()
    } catch (e) {
      console.error('Load error:', e)
      set({ loading: false, loadError: 'Unable to connect to the server. Please check your connection.' })
    }
  },

  // Background load for secondary tables
  _loadSecondary: async () => {
    if (get()._secondaryLoaded) return
    const sb = getSupabase(); if (!sb) return
    try {
      const [saleData, expData, custData, waData, refData, invData, stData, adjData] = await Promise.all([
        qAll(sb, 'sales', { select: 'id,receipt_no,date,items,subtotal,discount,total,profit,payment,split_cash,split_momo,customer,type,cashier,voided', order: 'date' }),
        qAll(sb, 'expenses', { select: 'id,date,category,description,amount', order: 'date' }),
        qAll(sb, 'customers', { select: 'id,phone,visit_count,total_spent,last_visit', order: 'total_spent' }),
        qAll(sb, 'whatsapp_orders', { select: 'id,order_no,date,customer_name,customer_phone,items,subtotal,delivery_fee,total,status,ussd_code,paystack_ref,address,notes,paid_at,source,details_filled,tracking_no,delivery_status,delivery_guy,sale_receipt_no', order: 'date' }),
        qAll(sb, 'refunds', { order: 'date' }),
        qAll(sb, 'invoices', { order: 'date' }),
        qAll(sb, 'stock_takes', { order: 'date' }),
        qAll(sb, 'stock_adjustments', { select: 'id,date,product_id,product_name,qty,reason,notes,adjusted_by', order: 'date' }),
      ])
      set({
        sales: saleData.map(mapSale),
        expenses: expData.map(mapExpense),
        customers: custData.map(mapCustomer),
        waOrders: waData.map(mapWAOrder),
        refunds: refData.map(mapRefund),
        invoices: invData.map(mapInvoice),
        stockTakes: stData.map(mapStockTake),
        stockAdjustments: adjData.map(mapStockAdj),
        _secondaryLoaded: true,
      })
      // Headline figures are counted in the database, not derived from the
      // arrays above, so every screen has them without waiting on its own
      // request — and so a screen can tell a real count from a partial one.
      get().refreshCounts()
    } catch (e) { console.warn('Secondary load:', e) }
  },

  refreshProducts: async () => { const sb = getSupabase(); if (!sb) return; const d = await q(sb, 'products', { order: 'name', asc: true }); set({ products: d.map(mapProduct) }) },
  refreshSales: async () => { const sb = getSupabase(); if (!sb) return; const d = await qAll(sb, 'sales', { select: 'id,receipt_no,date,items,subtotal,discount,total,profit,payment,split_cash,split_momo,customer,type,cashier,voided', order: 'date' }); set({ sales: d.map(mapSale) }) },
  refreshWAOrders: async () => { const sb = getSupabase(); if (!sb) return; const d = await qAll(sb, 'whatsapp_orders', { select: 'id,order_no,date,customer_name,customer_phone,items,subtotal,delivery_fee,total,status,ussd_code,paystack_ref,address,notes,paid_at,source,details_filled,tracking_no,delivery_status,delivery_guy,sale_receipt_no', order: 'date' }); set({ waOrders: d.map(mapWAOrder) }) },
  refreshStaff: async () => { const sb = getSupabase(); if (!sb) return; const d = await q(sb, 'staff_safe', { select: 'id,name,role,active' }); set({ staff: d.map(mapStaff) }) },
  refreshBundles: async () => { const sb = getSupabase(); if (!sb) return; const d = await q(sb, 'bundles'); set({ bundles: d.map(mapBundle) }) },
  refreshExpenses: async () => { const sb = getSupabase(); if (!sb) return; const d = await qAll(sb, 'expenses', { select: 'id,date,category,description,amount', order: 'date' }); set({ expenses: d.map(mapExpense) }) },
  refreshCustomers: async () => { const sb = getSupabase(); if (!sb) return; const d = await qAll(sb, 'customers', { select: 'id,phone,visit_count,total_spent,last_visit', order: 'total_spent' }); set({ customers: d.map(mapCustomer) }) },
  refreshRefunds: async () => { const sb = getSupabase(); if (!sb) return; const d = await qAll(sb, 'refunds', { order: 'date' }); set({ refunds: d.map(mapRefund) }) },
  refreshPromos: async () => { const sb = getSupabase(); if (!sb) return; const d = await qAll(sb, 'promos', { select: 'id,name,start_date,end_date,items,active', order: 'created_at' }); set({ promos: d.map(mapPromo) }) },
  refreshInvoices: async () => { const sb = getSupabase(); if (!sb) return; const d = await qAll(sb, 'invoices', { order: 'date' }); set({ invoices: d.map(mapInvoice) }) },
  refreshStockTakes: async () => { const sb = getSupabase(); if (!sb) return; const d = await qAll(sb, 'stock_takes', { order: 'date' }); set({ stockTakes: d.map(mapStockTake) }) },
  refreshStockAdjustments: async () => { const sb = getSupabase(); if (!sb) return; const d = await qAll(sb, 'stock_adjustments', { select: 'id,date,product_id,product_name,qty,reason,notes,adjusted_by', order: 'date' }); set({ stockAdjustments: d.map(mapStockAdj) }) },

  deductStock: (cartItems) => {
    // Build a delta map first, then produce fresh product objects. Mutating the
    // existing ones in place leaves memoised components holding an unchanged
    // reference, so the stock badge would not re-render after a sale.
    const deltas = {}
    for (const c of cartItems) {
      if (c.isBundle && c.bundleItems) {
        for (const bi of c.bundleItems) deltas[bi.productId] = (deltas[bi.productId] || 0) + num(bi.qty) * c.qty
      } else if (c.productId) {
        deltas[c.productId] = (deltas[c.productId] || 0) + c.qty
      }
    }
    set({
      products: get().products.map(p =>
        deltas[p.id] ? { ...p, quantity: Math.max(0, p.quantity - deltas[p.id]) } : p
      ),
    })
  },
}))

// Development only: lets the end-to-end tests drive the live store. Importing
// the module from a test instead gives a second, empty copy whenever Vite has
// hot-reloaded it — which once made a working POS look like it loaded nothing.
// Stripped from production builds, where import.meta.env.DEV is false.
if (import.meta.env.DEV && typeof window !== 'undefined') window.__POS_STORE__ = useStore
