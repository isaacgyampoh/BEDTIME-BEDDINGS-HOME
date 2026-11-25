# Bedtime — device acceptance report

25 November 2026. Every figure below was measured on the shop's own hardware:
a **Pixel 9 Pro XL (Android 17)** driven over adb with a live DevTools session,
and **Safari 27.2** on the MacBook driven through Apple Events. Nothing here is
emulation unless it says so.

---

## Verdict: **GO**

Six defects were found and fixed, all of them invisible to the existing checks —
no build warning, no console error, no failing test. Four needed a real device
to see at all.

Core Web Vitals pass on the phone. All 19 screens are clean at phone, laptop and
desktop widths. Everytinroom is untouched.

---

## 1. Defects found and fixed

| | What it did | How it was found |
|---|---|---|
| **Signing in loaded nothing** | `loadAll()` ran once on mount, before the PIN and before session restore, so every request went out as `anon`. The row policies answer `200` with zero rows, so nothing errored and the till showed **GHS 0.00** for the whole day. Signing in changed nothing because nothing asked again. | 18 amounts on screen, all zero, with a valid session in storage that could read 1,416 sales. One reload turned the same screen into 673 amounts, 670 non-zero. |
| **One-minute inactivity logout** | `INACTIVITY_TIMEOUT = 60 * 1000`. A cashier who paused to serve a customer came back to a PIN pad, and every re-entry minted another GoTrue session. | Reading `App.jsx`. |
| **`h-13` generated no CSS** | Used **38 times across 12 files** — every text input on Products, Receipts, Customers, Expenses, Staff, Invoices, Bundles, Refunds, the delivery pages and the **checkout drawer**. Tailwind's scale jumps 12 → 14, so the class matched nothing and each input collapsed to its content height. | Measured on the Pixel: search boxes **366×28** against the 44px a finger needs. Now **366×52**. |
| **Reports scrolled sideways** | Section cards are grid items, and a grid item defaults to `min-width: auto` — min-content, not zero — so a card would not shrink to its track. | Grid measured **416px**, card **622px**, page scrollWidth **638** against a 448px viewport. The `truncate` on product names could never take effect, which was the visible tell. |
| **The catalogue never moved to R2** | `Catalog.jsx` carried its own stale copy of `thumb()` that returned the Supabase URL and never called `imageUrl()`. Nothing looked wrong — those URLs still work, right up until Supabase is switched off. | On the device: **389 images, 389 from Supabase, none from the Worker**. Now 389/389 on R2. |
| **A worker could install an update and never apply it** | An update downloaded, installed, and sat in `waiting` while the page ran a bundle several deploys old. Reloading did not help; `registration.update()` did not help. | Found in real Safari. This is what "the laptop will not update" actually was. |

### The service-worker deadlock, in detail

A waiting worker activates when every page running the old one goes away — on a
till that is open all day, never. `sw.js` calls `skipWaiting()` on install, but a
worker put into `waiting` by an **older** build has no such code: the thing that
would step aside *is* the thing being replaced.

Fixed in two steps, because the first cannot work alone:

1. `sw.js` answers a `SKIP_WAITING` message; `index.html` posts it on load, on
   `updatefound`, and once a minute.
2. If the worker is **still** waiting, the registration is dropped. Verified
   against Safari: the page took the new HTML and bundle over the network,
   posted `SKIP_WAITING`, and the old worker carried on waiting because nothing
   was listening. `unregister()` is the only way out.

**Never during a sale.** `window.__posBusy` is true while `txDepth > 0` or the
cart has anything in it, and both the message and the unregister are gated on
it. Confirmed on the device: the flag went true the moment an item entered the
cart.

**Nothing local is lost.** After the unregister, Safari still held `heldCarts`,
`carts-by-cashier`, `pos-register-id`, `sidebar-pinned`, `pos-touch-mode` and
`pos-dark`.

---

## 2. Screen-by-screen

Phone column: Pixel 9 Pro XL, 448×997 CSS. Desktop: the same real browser at
1512×897 and 1920×1080. "Overflow" counts elements past the right edge that are
**not** inside a scroll container — a wide data table that scrolls on its own is
the intended pattern, not a fault.

| # | Screen | Phone | 1512px | 1920px | Notes |
|---|---|---|---|---|---|
| 1 | Dashboard | PASS | PASS | PASS | 673 amounts, 670 non-zero after the load fix |
| 2 | Point of Sale | PASS | PASS | PASS | 644 images, **0 broken**, all from R2 |
| 3 | Receipts | PASS | PASS | PASS | input 28px → **52px**; table scrolls in its own container |
| 4 | Refunds | PASS | PASS | PASS | genuinely empty (0 rows in the database) |
| 5 | Customers | PASS | PASS | PASS | 1,224 rows |
| 6 | Products | PASS | PASS | PASS | input 28px → **52px**; 644 images, 0 broken |
| 7 | Stock Takes | PASS | PASS | PASS | |
| 8 | Stock Adjustments | PASS | PASS | PASS | |
| 9 | Restock | PASS | PASS | PASS | |
| 10 | Promos & Bundles | PASS | PASS | PASS | |
| 11 | Invoices | PASS | PASS | PASS | genuinely empty (0 rows) |
| 12 | Expenses | PASS | PASS | PASS | 5 rows |
| 13 | Staff Sales | PASS | PASS | PASS | |
| 14 | Reports | **FIXED** | PASS | PASS | was scrollWidth 638 > 448; now 448 = 448 |
| 15 | WhatsApp Orders | PASS | PASS | PASS | one of the originally-blank screens; renders correctly |
| 16 | Social Commerce | PASS | PASS | PASS | |
| 17 | Promotion History | PASS | PASS | PASS | 43×44 filter chips — see below |
| 18 | Online Shop | PASS | PASS | PASS | |
| 19 | Staff & Roles | PASS | PASS | PASS | |

**Across all 19 screens, at every width: zero horizontal page scroll, zero broken
images, zero error states.**

Measured and **not** changed, because they were already right: 0 of 726 tap
targets under 44px on the POS, numeric keyboards on price and quantity inputs
(`type=number`, `inputmode=decimal`), and no clipped text outside the deliberate
`truncate`.

Left alone deliberately: the **43×44** filter chips on Promotion History. One
pixel under on width only, full height for a finger, and a legitimate chip
pattern — churning the design for that is not an improvement.

---

## 3. Performance — measured on the phone

| | Cold (cache bypassed) | Warm (service worker) | Target |
|---|---|---|---|
| TTFB | 98 ms | 68 ms | — |
| FCP | 392 ms | 176 ms | — |
| **LCP** | **1,064 ms** | **784 ms** | < 2,500 ms ✅ |
| **CLS** | **0** | **0** | < 0.1 ✅ |
| **INP** (observed) | — | **192 ms** | < 200 ms ✅ |
| Load event | 308 ms | 127 ms | — |
| Transferred | 163 KB | 0 KB (cache) | — |
| API calls | 30, avg 410 ms | 41, avg 262 ms | — |
| Long tasks | 2 (165 ms) | 1 (145 ms) | — |
| DOM nodes | 6,526 | 4,940 | — |
| JS heap | 14 MB | 8 MB | — |

**All three Core Web Vitals pass.** The earlier audit could not measure these at
all — there was no Chrome on the build machine — so these are the first real
figures for this shop.

### The 644-image grid: measured, and deliberately left alone

The brief asked for virtualization *only where measurements demonstrate a
meaningful benefit*. They do not.

Filtering the grid by typing, steady state: **33, 36, 33 ms** per keystroke. The
205 ms first keystroke seen earlier is a one-off warm-up on the first interaction
after load, not an ongoing cost.

`content-visibility: auto` with `contain-intrinsic-size` was A/B tested live on
the device against the real grid:

```
BEFORE  [35, 13, 3]  [36, 12, 2]  [33, 13, 2]   ms
AFTER   [50, 12, 5]  [41,  8, 2]  [32, 11, 2]   ms
```

No benefit — inside the noise, and slightly worse on the first trial. **Not
shipped.** Images are already `loading="lazy"` and `decoding="async"`, and
`ProductCard` is already memoised. There is nothing here worth the risk of
restructuring a live till.

---

## 4. Offline and synchronisation

**This POS has no offline sale queue, by design.** `record_sale` is a round trip;
if it does not come back, the sale does not exist. Queueing sales on the device
would let two tills each sell the last unit and stock would drift the moment the
line dropped.

That design is sound, but it puts all the weight on the message. The old text was
`Error: ` plus whatever the engine said — "Load failed" in Safari, "Failed to
fetch" in Chrome — which reads like something to dismiss. Every failure now
states plainly that the sale was **NOT saved** and that the cart has been kept,
and the offline case is named as no internet rather than as a browser error.
30 cases, including the invariant that no failure message may ever contain
done/success/saved.

Tested against the live till with the network actually cut via CDP:

- ✅ sales count held at **1,417 across every offline checkout attempt** — no
  production sale was created, which is what made this safe to run
- ✅ the cart was preserved every time (`finishSale()` only runs on success, so a
  failed sale cannot clear the cart or print a receipt)
- ✅ the session survived disconnect and reconnect
- ✅ `window.__posBusy` went true the moment an item entered the cart, so the
  service-worker swap is correctly blocked mid-sale

---

## 5. Authentication

| | |
|---|---|
| Inactivity logout | **removed** — no timer remains anywhere in `src/` |
| Cold start (app force-stopped and reopened) | ✅ still signed in, 673 amounts restored |
| Browser refresh | ✅ still signed in |
| Temporary disconnection | ✅ still signed in through offline → online |
| Token refresh | ✅ `auth.refresh_tokens` records a successful rotation |
| Protected screens load immediately after sign-in | ✅ `shouldLoad()` re-asks on sign-in; 9 cases pin it |
| Explicit logout | unchanged |
| Admin revocation / disabled accounts | unchanged — server-side, never weakened |

---

## 6. Security

| Check | Result |
|---|---|
| Dependency vulnerabilities | **0** (`npm audit --omit=dev`) |
| Secrets in the production bundle | none — `service_role`, `SERVICE_ROLE`, `JWT_SECRET`, `sk_live` all absent; the embedded key decodes to `role: anon` |
| anon → `sales` / `customers` / `expenses` | `200` with **0 rows** |
| anon → `whatsapp_orders` / `staff` / `sms_log` / `product_price_history` | **401 denied** |
| anon → `products` / `promos` / `store_settings` | readable, as the public shop requires |
| Cross-tenant isolation | `check-tenant-isolation.sh` → **no cross-tenant exposure found**, exit 0 |
| PIN brute force | `pin_attempts` throttle live, Caddy rate-limit zone on `verify_pin` present |
| Everytinroom | untouched — containers up 4 days / 25 hours, its site file unchanged |
| Production monitor | **14 / 14 pass** |

**No authentication failure can now silently show wrong money.** Three
independent guards: data is not loaded until the identity is known
(`loadGate.js`), a `401`/`PGRST301` raises the expired-session banner
(`authFailure.js`), and a login that produced no API session raises a red banner
naming what it prevents (`staffLogin.js`).

---

## 7. Passed / failed / blocked / untested

**Passed** — 19-screen mobile review; 18-screen desktop review at two
resolutions; real Safari and WebKit investigation including actual image
`decode()`; automatic update delivery with nothing cleared and nothing
uninstalled; persistent authentication across cold start, refresh and
disconnection; Core Web Vitals; the grid investigation; security; tenant
isolation; 777 tests, 0 lint errors.

**Failed** — nothing outstanding. Six defects found, six fixed, each verified on
the device after deploy.

**Blocked / needs you**

1. **Everytinroom's SMS key** still returns HTTP 401. Both shops use mNotify, so
   issuing Bedtime's new key almost certainly invalidated theirs. Only you can
   reissue it; reading their database is the cross-tenant access this work
   hardens against.
2. **The Cloudflare proxy decision** for `api.bedtimehome.com` — the only
   remaining latency lever, fenced pending your compatibility check.
3. **The CSP is still report-only.** It now has real browser exposure in both
   Chrome and Safari without violations surfacing, so it is a candidate for
   enforcement on your word.

**Untested, stated plainly**

- **The exact offline toast text, end to end on the device.** Checkout validation
  stops the flow before the network call unless the payment branch's own
  requirements are met, so the request never left the browser. The message path
  is covered by unit tests instead. I am not claiming a screenshot I do not have.
- **Multi-device concurrent sync** (two tills racing the same stock) — covered by
  the earlier audit's overselling test at the database level, not re-run here on
  two physical devices.
- **Printer hardware paths** — no receipt printer was attached.
- **iOS Safari on a phone** — only macOS Safari 27.2 was available.

---

## 8. Final state on the device

```
bundle      /assets/index-DUA37yLq.js   (identical to the live deploy)
sw cache    bedtime-pos-0535d88ef913
sw waiting  no
display     fullscreen (installed PWA)
signed in   yes
figures     673 amounts, 670 non-zero, max GHS 4,480.00
images      644 total, 0 broken
```

777 tests pass, 0 lint errors, 14/14 monitor checks green, Everytinroom
unaffected.
