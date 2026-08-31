# BEDTIME BEDDINGS & HOME — POS

Staff point-of-sale for BEDTIME BEDDINGS & HOME.
React + Supabase (PostgreSQL) + Vercel, with mobile-money payments and SMS reports.

## Tech Stack
- **Frontend**: React 18 + Vite 7 + Tailwind CSS + Zustand
- **Database**: Supabase (PostgreSQL, Row Level Security)
- **Backend**: Supabase Edge Functions (Deno) + PL/pgSQL RPCs
- **Hosting**: Vercel
- **Payments**: NaloPay (MoMo prompt + USSD), Paystack, Moolre
- **SMS**: mNotify / Arkesel via Edge Functions + pg_cron

---

## Setup

### 1. Database
Run the migrations in `supabase/migrations/` in order via the Supabase SQL Editor.

> **Run 015 → 016 → 017 → 018 BEFORE deploying the current frontend.**
> The app expects the functions they create; deploying the frontend first
> breaks staff management, deletes and checkout.
>
> | Migration | What it does | Frontend depends on it |
> |---|---|---|
> | `015_security_hardening` | Revokes anon access to `staff`, hashes PINs, throttles login, replaces the unauthenticated staff RPCs | `staff_safe`, `admin_save_staff`, `admin_delete_staff` |
> | `016_integrity_hardening` | Server-side pricing + stock checks in `record_sale`, atomic stock moves, admin-PIN deletes, append-only `sales` | `adjust_product_stock`, `admin_delete_row`, `record_sale` split params |
> | `017_sms_rate_limit` | Rate-limits the unauthenticated SMS endpoints | — (Edge Function only) |
> | `018_cron_config` | Moves the scheduled-job key out of SQL and fixes jobs that carried **the wrong project's token** | — (needs a one-off config insert, see the file header) |
>
> 015 is login-safe: existing plaintext PINs keep working and upgrade to a
> hash on first successful login. 016 rejects a sale whose prices no longer
> match the database rather than silently charging a different figure, so a
> cashier may occasionally be told to re-add a cart after a price change.
>
> `002_cron_jobs.sql` and `014_payment_reminders.sql` are **superseded by 018**
> and must not be run as-is.

### 2. Environment
Copy `.env.example` to `.env` and fill in the two `VITE_` values. If they are
absent the app falls back to the live project, so existing deploys keep working.

### 3. Edge function secrets
Never commit these — set them on the platform:

```bash
supabase secrets set \
  PAYSTACK_SECRET_KEY=...        `# REQUIRED: verifies the webhook HMAC` \
  PAYMENT_CALLBACK_SECRET=...    `# REQUIRED: shared secret on payment callbacks` \
  NALOPAY_MERCHANT_ID=... NALOPAY_API_KEY=... NALOPAY_AUTH_HEADER=... \
  MNOTIFY_KEY=...
```

Both required secrets are fail-safe in different directions, by design:
- Without `PAYSTACK_SECRET_KEY` the webhook **rejects everything** (safe).
- Without `PAYMENT_CALLBACK_SECRET` the provider callbacks stay **open** and log
  a warning on every request, so existing payment flows are not interrupted —
  set it and update the callback URLs in each provider's dashboard to include
  `&s=<secret>`.

### 4. Deploy edge functions
```bash
supabase functions deploy charge-momo
supabase functions deploy paystack-webhook --no-verify-jwt
supabase functions deploy sms-reports --no-verify-jwt
```
Point the Paystack webhook at `https://<ref>.supabase.co/functions/v1/paystack-webhook`.

### 5. Deploy the app
```bash
npm install
npm run build
vercel
```

### 6. First login
Open the deployed URL and enter a staff PIN. PINs are managed in **Staff &
Roles** by an admin; changing staff requires re-entering an admin PIN.

---

## Structure
```
src/
├── App.jsx                    # Shell, routing, realtime, auto-logout
├── components/
│   ├── CartDrawer.jsx         # Cart + checkout (cash / MoMo / split / USSD)
│   ├── Login.jsx              # PIN login
│   ├── Navigation.jsx         # Sidebar + mobile nav
│   ├── Modal.jsx  Loader.jsx  Logo.jsx
│   └── ReceiptPreview.jsx     # Thermal receipt
├── hooks/
│   ├── useStore.js            # Zustand global state
│   └── useCustomerDisplay.js  # Second-screen customer display
├── lib/
│   ├── supabase.js            # Client + FUNCTIONS_URL / STORAGE_URL helpers
│   └── utils.js               # Formatting, feature flags, shop details
└── pages/                     # 23 pages (POS, orders, inventory, finance)

supabase/
├── migrations/                # Schema, RPCs, cron, security hardening
└── functions/                 # charge-momo, paystack-webhook, sms-reports, …

storefront/                    # Separate public e-commerce site (own package)
```

---

## Features
- POS with Retail / Wholesale / Bundle modes, held carts, per-cashier carts
- Payments: cash, MoMo direct prompt, USSD code, split cash+MoMo
- WhatsApp & web orders with delivery tracking
- Second-screen customer display (auto-detects the second monitor)
- Thermal receipt printing, refunds with stock restoration
- Inventory: products, stock takes, stock adjustments, restock, promos, bundles
- Finance: expenses, invoices, staff sales, reports with CSV export
- PIN-based auth, bcrypt-hashed, throttled, with inactivity auto-logout
- Realtime updates over Supabase WebSockets; PWA with app-icon badge

## POS terminals

The app detects a touch terminal (`hover: none` / `pointer: coarse`) and stamps
`data-pos="touch"` on `<html>`. That widens tap targets, lifts the smallest
type, pins the sidebar open and swaps every numeric field for an on-screen
keypad — a POS panel reports a *desktop* viewport, so none of the `md:`
breakpoints catch it on their own.

- **No keyboard is required.** PIN login, amounts, phone numbers and free-text
  prompts all have on-screen input.
- **Barcode scanners keep working.** The POS search box is still a real focused
  `<input>`; the on-screen keyboard is an addition, not a replacement.
- If a terminal misreports its pointer capabilities, an admin can force the
  mode with the **Touch POS** toggle in the sidebar footer.

## Security notes
- The `VITE_SUPABASE_ANON_KEY` is public by design — it ships in the browser
  bundle. Everything protecting the data is Row Level Security, so treat any
  `USING (true)` policy as a hole, not a convenience.
- The `staff` table is not readable by `anon`. Read `staff_safe` instead.
- Payment status is only ever set server-side, from a verified webhook or the
  reconcile job. Never let a client write `status = 'Paid'`.
- Prices and costs used for a sale come from the database, never from the
  browser. `record_sale` rejects a cart whose totals no longer match.
- **Known gap:** the app authenticates by PIN with no session token, so the
  anon role still holds broad INSERT/UPDATE. Destructive and financial paths
  are closed (deletes, `sales`, pricing, PINs), but a full lockdown needs
  per-session tokens checked in RLS. See the note at the end of this file.

## Remaining work

Staff log in with a PIN and the app then talks to Supabase as the public `anon`
role — there is no per-session credential. Anything `anon` may do, anyone
holding the (public) anon key may also do. Migrations 015/016 closed the paths
that lose money or data: PIN theft, price tampering, rewriting `sales`, and
deleting catalogue rows. Still open by design:

- `anon` can INSERT/UPDATE `products`, `expenses`, `whatsapp_orders`, etc.
- `adjust_product_stock` is callable by anyone with the anon key.

The fix is a session token: have `verify_pin` mint one into a `staff_sessions`
table, send it from the client as a header, and check it in RLS via
`current_setting('request.headers', true)`. That touches every policy and every
write path, so it wants doing deliberately, with a staging project to test
against — not blind.
