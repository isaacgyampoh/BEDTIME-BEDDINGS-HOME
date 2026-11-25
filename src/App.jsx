import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { Toaster } from 'react-hot-toast'
import { getSupabase, callFunction, restoreStaffSession } from './lib/supabase'
import { PAYMENTS_ENABLED } from './lib/utils'
import { shouldLoad } from './lib/loadGate'
import { useStore, setAuthFailureHandler } from './hooks/useStore'
import { usePosMode } from './hooks/usePosMode'
import { useCustomerDisplayBroadcast, broadcastDisplay } from './hooks/useCustomerDisplay'
import Loader from './components/Loader'
import Login from './components/Login'
import Navigation from './components/Navigation'
import CartDrawer from './components/CartDrawer'
import ReceiptPreview from './components/ReceiptPreview'
import PromptDialog from './components/PromptDialog'
import UpdateBanner from './components/UpdateBanner'
import FirstRunSetup from './components/FirstRunSetup'
import toast from 'react-hot-toast'

// Lazy load all pages — only loads when needed
const Dashboard = lazy(() => import('./pages/Dashboard'))
const POS = lazy(() => import('./pages/POS'))
const WhatsAppOrders = lazy(() => import('./pages/WhatsAppOrders'))
const Receipts = lazy(() => import('./pages/Receipts'))
const Products = lazy(() => import('./pages/Products'))
const StaffPage = lazy(() => import('./pages/StaffPage'))
const OnlineShop = lazy(() => import('./pages/OnlineShop'))
const ExpensesPage = lazy(() => import('./pages/ExpensesPage'))
const CustomersPage = lazy(() => import('./pages/CustomersPage'))
const BundlesPage = lazy(() => import('./pages/BundlesPage'))
const PerformancePage = lazy(() => import('./pages/PerformancePage'))
const RefundsPage = lazy(() => import('./pages/RefundsPage'))
const ReportsPage = lazy(() => import('./pages/ReportsPage'))
const PromosPage = lazy(() => import('./pages/PromosPage'))
const InvoicesPage = lazy(() => import('./pages/InvoicesPage'))
const StockTakesPage = lazy(() => import('./pages/StockTakesPage'))
const StockAdjustmentsPage = lazy(() => import('./pages/StockAdjustmentsPage'))
const SocialDashboard = lazy(() => import('./pages/SocialDashboard'))
const PromotionHistory = lazy(() => import('./pages/PromotionHistory'))
const RestockPage = lazy(() => import('./pages/RestockPage'))
const InvoicePay = lazy(() => import('./pages/InvoicePay'))
const Catalog = lazy(() => import('./pages/Catalog'))
const DeliveryConfirm = lazy(() => import('./pages/DeliveryConfirm'))
const DeliveryDetails = lazy(() => import('./pages/DeliveryDetails'))
const CustomerDisplay = lazy(() => import('./pages/CustomerDisplay'))

// There was an inactivity auto-logout here, set to ONE MINUTE. A cashier who
// paused to serve a customer, count change or answer the phone came back to a
// PIN pad, and every one of those re-entries minted a fresh GoTrue session --
// which is a large part of why this shop recorded dozens of sign-ins a day.
//
// It is gone deliberately, not by accident. The till is used all day by staff
// already standing behind the counter, so an idle timer protected nothing a
// locked shop door does not, while costing a sale's worth of interruption
// every time it fired. What actually protects the data is unchanged: tokens
// still expire and refresh, the row policies still decide what a session may
// read and write, explicit logout still ends the session, and an administrator
// can still revoke one.
const ADMIN_PAGES = ['products', 'staff', 'promos', 'invoices', 'stocktakes', 'stockadjustments', 'restock', 'social', 'promotions', 'onlineshop']

export default function App() {
  const { user, page, setPage, loading, loadAll, logout, isAdmin, darkMode } = useStore()
  const [cartOpen, setCartOpen] = useState(false)
  const [receipt, setReceipt] = useState(null)
  const [salePopup, setSalePopup] = useState(null)

  // Stamps data-pos="touch" on <html> for the touch-terminal stylesheet.
  // Must run above the early returns so the public pages get it too.
  usePosMode()

  // Offers the desktop app once, on a Windows browser only.

  // Broadcast live cart to the customer-facing display (#/customer-display)
  useCustomerDisplayBroadcast()

  // Auto-launch the customer screen on the 2nd display once a cashier is in.
  // Runs after login (which is the user gesture browsers require). Designed so
  // a non-technical client just opens the app and the customer screen appears.
  useEffect(() => {
    if (!user) return
    if (window.location.hash.includes('/customer-display')) return // don't spawn from the customer window itself
    let cancelled = false
    const launch = async () => {
      try {
        const { openCustomerScreenAuto } = await import('./hooks/useCustomerDisplay')
        if (!cancelled) await openCustomerScreenAuto()
      } catch (e) { console.warn('auto customer screen:', e) }
    }
    // slight delay so the POS UI paints first
    const t = setTimeout(launch, 600)
    // keep it alive: only relaunch if the customer window was actually closed
    const keepAlive = setInterval(async () => {
      if (cancelled || window.location.hash.includes('/customer-display')) return
      const { isCustomerScreenOpen } = await import('./hooks/useCustomerDisplay')
      if (!isCustomerScreenOpen()) launch()
    }, 15000)
    return () => { cancelled = true; clearTimeout(t); clearInterval(keepAlive) }
  }, [user])

  // Apply dark mode
  useEffect(() => {
    document.body.classList.toggle('dark', darkMode)
  }, [darkMode])

  // Reload by itself when the connection comes back, if the first load failed.
  useEffect(() => {
    const retry = () => { if (useStore.getState().loadError) loadAll() }
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, []) // eslint-disable-line

  useEffect(() => {
    // loadAll() deliberately does NOT run here. See the effect further down
    // that waits until we know who is signed in: loading as `anon` populates
    // the till with the empty results the row policies return, and nothing
    // ever reloads them.
    const channel = setupRealtime()
    // Tear the subscription down on unmount, otherwise React StrictMode (dev)
    // and any remount leave orphaned realtime channels open.
    return () => { if (channel) { try { getSupabase().removeChannel(channel) } catch {} } }
  }, []) // eslint-disable-line

  // Global image fallback: any product image that fails to load (e.g. dead
  // Cloudinary links) is swapped for a clean neutral placeholder instead of
  // the browser's broken-image icon. Applies app-wide via error capture.
  useEffect(() => {
    const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#f1f0ee"/><path d="M30 62l12-14 8 9 6-7 10 12H30z" fill="#d6d3ce"/><circle cx="38" cy="36" r="6" fill="#d6d3ce"/></svg>'
    )
    const onErr = (e) => {
      const t = e.target
      if (t && t.tagName === 'IMG' && t.src !== PLACEHOLDER) { t.src = PLACEHOLDER; t.style.objectFit = 'cover' }
    }
    window.addEventListener('error', onErr, true) // capture phase catches img errors
    return () => window.removeEventListener('error', onErr, true)
  }, [])

  // App-wide payment auto-confirm: every 20s (from ANY screen, while logged in)
  // ask NaloPay which recent pending orders actually paid, and mark them Paid.
  // This means orders confirm themselves — staff shouldn't need to mark manually.
  useEffect(() => {
    if (!user || !PAYMENTS_ENABLED) return
    const run = async () => {
      try {
        const j = await callFunction('reconcile-payments')
        if (j?.confirmed > 0) { try { loadAll() } catch {} }
      } catch {}
    }
    run()
    const iv = setInterval(run, 20000)
    return () => clearInterval(iv)
  }, [user]) // eslint-disable-line

  // Guard admin pages — redirect non-admin users
  useEffect(() => {
    if (user && !isAdmin && ADMIN_PAGES.includes(page)) {
      setPage('pos')
      toast.error('Admin access required')
    }
  }, [page, user, isAdmin, setPage])

  const playSaleSound = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const osc = ctx.createOscillator(); const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.frequency.setValueAtTime(800, ctx.currentTime)
      osc.frequency.setValueAtTime(1000, ctx.currentTime + 0.1)
      osc.frequency.setValueAtTime(1200, ctx.currentTime + 0.2)
      gain.gain.setValueAtTime(0.3, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5)
      osc.start(); osc.stop(ctx.currentTime + 0.5)
    } catch {}
  }

  const setupRealtime = () => {
    const sb = getSupabase(); if (!sb) return null
    const store = useStore.getState()
    return sb.channel('pos-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_orders' }, () => {
        store.refreshWAOrders()
        // Update PWA badge with pending + paid (unprocessed) count
        setTimeout(() => {
          const s = useStore.getState()
          const badge = s.waOrders.filter(o => o.status === 'Pending' || o.status === 'Paid').length
          updateBadge(badge)
        }, 1000)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => store.refreshProducts())
      // A void is an UPDATE, not an INSERT. Listening only for INSERT meant
      // every open till kept counting a voided sale in today's total until
      // somebody reloaded the app.
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sales' }, () => store.refreshSales())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sales' }, (payload) => {
        store.refreshSales()
        const s = payload.new
        if (s) {
          playSaleSound()
          setSalePopup({ total: s.total, customer: s.customer, payment: s.payment, cashier: s.cashier })
          setTimeout(() => setSalePopup(null), 4000)
          // show thank-you on the customer display
          broadcastDisplay({ status: 'paid', total: s.total, receiptNo: s.receipt_no || s.receiptNo || null, items: [], count: 0, subtotal: 0 })
        }
      })
      .subscribe()
  }

  // Update PWA app icon badge (shows number on app icon)
  const updateBadge = (count) => {
    try {
      if ('setAppBadge' in navigator) {
        if (count > 0) navigator.setAppBadge(count)
        else navigator.clearAppBadge()
      }
      // Also tell service worker
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'UPDATE_BADGE', count })
      }
    } catch {}
  }

  // Update badge whenever waOrders changes
  const waOrders = useStore(s => s.waOrders)
  useEffect(() => {
    const badge = waOrders.filter(o => o.status === 'Pending' || o.status === 'Paid').length
    updateBadge(badge)
  }, [waOrders])

  // Public pages - no login required
  // A lost session used to look like a quiet day: empty lists, zeroed
  // reports, nothing said. Say it instead -- but only when there is a session
  // to have lost.
  //
  // The first version of this fired on ANY auth failure, including the loads
  // that run before anyone has signed in, which are anon by definition and
  // fail by design. The banner then appeared over a perfectly good session
  // and invited the cashier to press "Sign in again", which signed them OUT.
  // GoTrue deletes the session row on sign-out, so the shop ended up with a
  // user who had just authenticated and no session at all -- which is exactly
  // what the live database showed: last_sign_in updated, zero sessions.
  // Before offering the PIN screen, see whether a valid session is already in
  // storage. Without this every reload re-authenticated and minted another
  // GoTrue session, which is why the shop showed 19 sign-ins in two hours.
  const loginToStore = useStore(s => s.login)
  const [restoring, setRestoring] = useState(true)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const staff = await restoreStaffSession()
      if (!cancelled && staff) {
        // A staff record came back only because getSession() produced a valid
        // session, so any warning left over from a sessionless login is stale.
        useStore.getState().setSessionMissing(false)
        loginToStore(staff, String(staff.role).toLowerCase() === 'admin')
      }
      if (!cancelled) setRestoring(false)
    })()
    return () => { cancelled = true }
  }, [loginToStore])

  // Load the books once we know WHO is asking, and again when someone signs in.
  //
  // This used to be a bare loadAll() on mount. That fires before the PIN has
  // been entered and before a stored session has been restored, so every
  // request went out as `anon` -- and since the row policies return zero rows
  // to anon for sales, orders, customers and expenses (while still answering
  // 200, so nothing errors), the till filled up with empty arrays. Signing in
  // then changed nothing, because nothing asked again.
  //
  // That is what "I signed in and it still shows GHS 0.00" was. Measured on
  // the shop's own phone: 18 amounts on screen, every one GHS 0.00, with a
  // valid session sitting in storage that could read 1,416 sales. One reload
  // turned the same screen into 673 amounts, 670 of them non-zero.
  //
  // Reloading on sign-OUT is deliberately not done: the PIN screen is all
  // there is to show, and a refetch as anon would only generate denials.
  const loadedForRef = useRef(undefined)
  useEffect(() => {
    const id = user?.id || null
    if (shouldLoad({ restoring, userId: id, loadedFor: loadedForRef.current })) {
      loadedForRef.current = id
      loadAll()
    } else if (!restoring) {
      loadedForRef.current = id
    }
  }, [restoring, user, loadAll])

  // Tell the service-worker bootstrap in index.html when it must not swap the
  // worker. Activating a waiting worker reloads the page, and doing that with
  // a sale open or a cart filled would throw the transaction away. The same
  // signal the desktop updater uses (txDepth + cart), published where plain
  // script in the document head can read it.
  const cartCount = useStore(s => s.cart.length)
  const txDepth = useStore(s => s.txDepth)
  useEffect(() => {
    window.__posBusy = txDepth > 0 || cartCount > 0
  }, [txDepth, cartCount])

  const authExpired = useStore(s => s.authExpired)
  const setAuthExpired = useStore(s => s.setAuthExpired)
  const sessionMissing = useStore(s => s.sessionMissing)
  const setSessionMissing = useStore(s => s.setSessionMissing)
  const signedIn = useStore(s => !!s.user)
  const signedInRef = useRef(signedIn)
  useEffect(() => { signedInRef.current = signedIn }, [signedIn])
  useEffect(() => {
    // Signing in clears any stale warning from before the session existed.
    if (signedIn) setAuthExpired(false)
  }, [signedIn, setAuthExpired])
  useEffect(() => {
    setAuthFailureHandler(() => {
      if (signedInRef.current) setAuthExpired(true)
    })
    return () => setAuthFailureHandler(null)
  }, [setAuthExpired])

  if (window.location.hash.includes('/customer-display')) return <Suspense fallback={<Loader />}><CustomerDisplay /></Suspense>
  if (window.location.hash.includes('/pay/')) return <Suspense fallback={<Loader />}><InvoicePay /></Suspense>
  if (window.location.hash.includes('/deliver/')) return <Suspense fallback={<Loader />}><DeliveryConfirm /></Suspense>
  if (window.location.hash.includes('/details/')) return <Suspense fallback={<Loader />}><DeliveryDetails /></Suspense>
  if (window.location.hash.includes('/catalog')) return <Suspense fallback={<Loader />}><Catalog /></Suspense>

  // Full screen only for the very first load, before anyone is signed in.
  // Once a cashier is in, the loader is an OVERLAY (see <Loader /> below):
  // replacing the tree unmounts the page underneath, so every "Save" inside a
  // modal threw away the open form — the same on all ten pages that have one.
  // Adding a staff member looked like the button did nothing: the form simply
  // vanished, taking the name and PIN with it.
  if (loading && !user) return <><Loader /><Toaster /></>
  if (!user) return restoring ? <><Loader /><Toaster /></> : <><Login /><Toaster /></>

  const pages = {
    dash: <Dashboard />,
    pos: <POS />,
    whatsapp: <WhatsAppOrders onPrintReceipt={(s) => setReceipt(s)} />,
    receipts: <Receipts onPrintReceipt={(s) => setReceipt({ receiptNo: s.receiptNo, date: s.date, customer: s.customer, cashier: s.cashier, payment: s.payment, type: s.type, items: s.items, total: s.total, discount: s.discount })} />,
    products: <Products />,
    staff: <StaffPage />,
    onlineshop: <OnlineShop />,
    expenses: <ExpensesPage />,
    customers: <CustomersPage />,
    bundles: <BundlesPage />,
    performance: <PerformancePage />,
    refunds: <RefundsPage />,
    reports: <ReportsPage />,
    promos: <PromosPage />,
    invoices: <InvoicesPage />,
    stocktakes: <StockTakesPage />,
    stockadjustments: <StockAdjustmentsPage />,
    social: <SocialDashboard />,
    promotions: <PromotionHistory />,
    restock: <RestockPage />,
  }

  return (
    <div className="min-h-screen">
      {authExpired && (
        <div
          role="alert"
          className="fixed top-0 inset-x-0 z-[300] bg-amber-500 text-black px-4 py-2.5 flex items-center justify-center gap-3 text-[13px] font-semibold shadow"
        >
          <span>Your session has expired, so this screen may be empty or out of date.</span>
          <button
            onClick={() => {
              // Reload only. Signing out here DELETED the GoTrue session of a
              // cashier who had just authenticated, which is the opposite of
              // helping; the login screen appears by itself when there is no
              // valid session.
              setAuthExpired(false)
              window.location.reload()
            }}
            className="px-3 py-1 rounded-full bg-black text-white text-[12px] font-bold"
          >
            Sign in again
          </button>
        </div>
      )}
      {!authExpired && sessionMissing && (
        <div
          role="alert"
          className="fixed top-0 inset-x-0 z-[300] bg-red-600 text-white px-4 py-2.5 flex items-center justify-center gap-3 text-[13px] font-semibold shadow"
        >
          {/* Red, not amber, and worded for what it actually prevents: this
              till cannot save a sale. An RLS-denied read comes back as 200
              with zero rows, so without this the screen just shows GHS 0.00
              and no error anywhere. */}
          <span>No secure session with the server. Sales cannot be saved and figures are not reliable.</span>
          <button
            onClick={() => {
              setSessionMissing(false)
              window.location.reload()
            }}
            className="px-3 py-1 rounded-full bg-white text-red-700 text-[12px] font-bold"
          >
            Retry
          </button>
        </div>
      )}
      <Toaster position="top-center" toastOptions={{ duration: 2000, style: { borderRadius: '14px', padding: '12px 20px', fontWeight: 600, fontSize: '13px', background: darkMode ? '#222' : '#fff', color: darkMode ? '#eee' : '#1a1a1a' } }} />
      <Loader />
      <Navigation onOpenCart={() => setCartOpen(true)} />
      <PromptDialog />
      <UpdateBanner />
      <FirstRunSetup />
      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} onReceipt={setReceipt} />
      {receipt && <ReceiptPreview sale={receipt} onClose={() => setReceipt(null)} />}

      {/* Sale Notification */}
      {salePopup && (
        <div className="fixed top-20 md:top-5 left-1/2 -translate-x-1/2 z-[300] animate-fade">
          <div className="bg-gray-900 text-white rounded-xl px-5 py-3 shadow-lg flex items-center gap-3 min-w-[240px]">
            <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center text-[13px]">+</div>
            <div>
              <div className="text-[13px] font-semibold">GHS {Number(salePopup.total || 0).toFixed(2)}</div>
              <div className="text-[11px] text-white/50">{salePopup.cashier} · {salePopup.payment}</div>
            </div>
          </div>
        </div>
      )}

      <main className="pt-mobile-header md:pt-0 pb-mobile-nav md:pb-10 min-h-screen transition-all duration-200 content-shell">
        <div className="px-4 md:px-7 lg:px-9 py-4 md:py-5 max-w-[1600px] mx-auto">
          <Suspense fallback={<div className="flex items-center justify-center py-20"><div className="w-7 h-7 border-[2.5px] border-stone-200 border-t-gray-800 rounded-full animate-spin" /></div>}>
            {pages[page] || <POS />}
          </Suspense>
        </div>
      </main>
    </div>
  )
}
