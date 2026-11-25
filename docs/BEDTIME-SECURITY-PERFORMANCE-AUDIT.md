# Bedtime — production security, performance and reliability audit

25 November 2026. Every finding below was tested against the live systems, not
inferred. Where something could not be measured, it says so.

---

## Verdict: **GO**, with three things on your desk

Bedtime is safe to run. Two real vulnerabilities were found and closed, one
production regression was found and fixed, and the infrastructure is sound.
Three items need you rather than me, and one of them affects Everytinroom.

---

## 1. Vulnerabilities found and fixed

### CRITICAL — every customer order readable with the public key

With nothing but the anon key, which ships in every browser bundle, anyone
could read **all 663 orders on Contabo and 662 on Supabase**: customer name,
phone, address, items, total, payment references and **USSD codes**. Also all
170 rows of cost and margin history.

The policy was named `anon_read_own_orders`; its predicate was `USING (true)`.
The name describes an intent the SQL does not implement, which is why it
survived migration 043 — that pass tightened sales, customers and expenses and
took this one at its word. It only surfaced because I enumerated every table
against the live API instead of reading policy names.

**Fixed** (`pending/055`, both backends). Verified from outside with the real
public keys: orders and price history denied; order tracking still returns one
row for a real order number and zero for a one-character query; the shop front
still reads products, promos, bundles and settings; a signed-in Admin still
reads everything.

### HIGH — the old backend could still create orders and move stock

On Supabase the anon role could still `public_order_create`, INSERT into
`whatsapp_orders` and **UPDATE products**. A customer on a cached bundle would
have written orders into a database nothing reads, and moved stock there,
diverging silently from Contabo.

**Fixed** (`pending/054`). Reads left open so a stale tab degrades rather than
errors; `service_role` untouched so in-flight callbacks still settle.

### HIGH — a lost session looked like a quiet day

The store's loaders return `[]` on **every** error. For a flaky network that is
right; for an expired session it renders an empty till, an empty receipts list
and zeroed reports, with nothing said. This is what your three screenshots
showed — order counts rendering from one query while the list beneath came back
empty from another.

It was invisible until now *because* the anon key used to be able to read that
data, so an unauthenticated till still showed something. Closing the leak
exposed it.

**Fixed.** Auth failures (`PGRST301`, `42501`, `401`, JWT/permission-denied) now
raise a banner with a "Sign in again" action. Network errors, missing columns
and 5xx are deliberately **not** treated as auth failures — telling a cashier to
sign in again when the server is down sends them round a loop. 11 tests cover
both sides of that line.

### MEDIUM — payment references were not unique

Code refused double settlement; the schema did not. Now a partial unique index
(`pending/056`), verified to reject a reused reference and rolled back cleanly.
The 37 orders sharing an empty-string reference — walk-ins and cancellations —
are untouched.

### MEDIUM — missing security headers

The shop front had **no `X-Frame-Options` at all** (framable), neither app sent
HSTS or a Permissions-Policy, and what existed applied only to `/index.html`.
Both now carry a `/*` block with HSTS, `frame-ancestors 'none'`,
`X-Frame-Options`, nosniff, Referrer-Policy and a Permissions-Policy denying
geolocation, microphone, camera, payment and usb.

### LOW — two infrastructure gaps

`/srv/central/logs` had **no rotation** — monitors append every 15 minutes per
app, backups nightly, on a disk two shops share. Now weekly, 8 kept, compressed.
`X11Forwarding` was on; disabled via a reversible drop-in, `sshd -t` validated
before reload, new connection verified after.

---

## 2. Tested and found sound

| Area | Evidence |
|---|---|
| SQL injection | **No public RPC uses `EXECUTE` or concatenates input.** Every probe returned 0 rows. Structurally impossible, not merely filtered. |
| Enumeration | `public_order_track` needs 6+ chars and matches exactly; `'`, `%`, `______`, `0` all return nothing |
| PIN brute force | Locked after 10 failures in 5 min, **plus** Caddy at 30 req/min per IP on `verify_pin` |
| Privilege separation | anon → products/promos/settings only; staff → full till; `service_role` → settlement |
| Cross-tenant | Neither app's role can CONNECT to the other's database; containers mutually unreachable **with a positive control**; secret files 0600; `call_edge` revoked from PUBLIC |
| Database exposure | PostgreSQL bound to **127.0.0.1 only**; no Docker TCP socket |
| Webhook forgery/replay | 23-case regression: unsigned, forged, wrong-key refused; duplicates no-op; cancelled never settled; underpayment refused; +1.3% fee accepted |
| Overselling | Two cashiers racing the last units — exactly one wins; stock never negative |
| Server hardening | 0 pending security updates, unattended-upgrades on, SSH key-only, ufw default-deny, fail2ban on sshd, TLS 1.3 |
| Backups | age-**encrypted** offsite, 33 files; restore rehearsed and matched exactly including sequences |

---

## 3. Performance — measured

| | Result |
|---|---|
| HTML TTFB | **31–48 ms** (Cloudflare edge) |
| Bundles | **124 KB** shop, **42 KB** till, compressed |
| API payloads | products **2.7 KB**, promos **10.3 KB** on the wire (77 KB uncompressed — compression is working) |
| **Server processing** | **3 ms**, measured inside the network |
| Database | slowest statement 44.6 ms; most under 15 ms |
| API TTFB, first call | 468 ms |
| API TTFB, reused connection | **~155 ms** |

The 468 ms first call is **three round trips to Germany**: TCP 152 ms, TLS
+164 ms, request +152 ms. A browser reuses the connection, so real traffic pays
~155 ms. The server contributes 3 of those milliseconds.

**There is nothing to optimise on our side.** The only lever is network
distance, which means proxying the API through Cloudflare — which you fenced
off pending compatibility checks with Caddy and the payment providers. Not done.

**No index work is warranted.** The sequential scans on `whatsapp_orders`,
`products` and `customers` are *correct* at 664–1,408 rows, where the table is
a page or two and an index would only slow writes. Indexes already cover date,
order_no, both payment references, category and phone.

### What I could not measure

**LCP, INP and CLS.** There is no Chrome or Chromium on this machine, so
Lighthouse cannot run. I will not quote Core Web Vitals I have not measured.
The figures above are proxies — payload size, TTFB and server time — and they
are good, but they are not the same thing.

Load testing against an isolated environment was also **not** performed; the
only safe target would be a scratch stack, and standing one up to generate
synthetic load on a box running two live shops was a worse trade than the
measurements above.

---

## 4. Storage

`r2/lifecycle.mjs` reports orphans and, only when told twice, removes them.
First run: **948 of 949 objects referenced** — 644 from `products.image`, 304
from receipt snapshots, exactly the split the R2 README predicted — one recent
unreferenced file held by the 30-day retention, **zero old orphans**.

Its caution is the design: references are gathered from the item snapshots on
sales and orders as well as products, because looking only at `products.image`
would orphan every receipt from August onward; a schema-aware scan skips a
column this schema lacks but **aborts on any other error**, since a failed query
and "no references" look identical and the second one deletes the bucket; it
refuses outright below 50 references; and `--quarantine` copies each object
aside and compares SHA-256 before removing the original.

Nothing in the app deletes an image, so replacements still accumulate — that is
now reported and removable, not invisible.

---

## 5. Monitoring — 14 checks

api, database, containers, jobs, reconciliation, SMS balance, backups, disk,
R2, **suspicious PIN attempts, database connection exhaustion (62 of 150 used,
and two shops share that ceiling), CPU/memory, TLS expiry — which also catches
the Let's Encrypt staging fallback that bit us at cutover — and API traffic as
rate-limited requests at the proxy.**

All 14 pass. Alerts need two consecutive failures (one for api, database,
containers, connections), are deduplicated, remind every 6 hours, and send a
recovery message. Independent of Everytinroom's monitor, offset at `7-59/15`.

---

## 6. Remaining Supabase dependencies

| | |
|---|---|
| Front ends | **none** — neither deployed bundle references the old project |
| Cron jobs | **0 of 16 active** |
| Writes | anon can no longer read orders or write anything |
| `super-service` v19 | **the forwarder** — intentional, until the USSD endpoint moves |
| `sms-reports` v11 | deployed but untriggered; remove at retirement |
| Storage | the Worker reads through for the 205 unreferenced objects |

**The exact USSD provider change**, when you make it:

```
old:  https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/super-service?action=ussd
new:  https://api.bedtimehome.com/functions/v1/super-service?action=ussd
```

Until then the forwarder passes it through and nothing breaks. Earliest
deletion remains **8 December 2026**, and only with your explicit say-so.

---

## 7. Three things on your desk

1. **Everytinroom's SMS is failing.** The shared health check reports
   `3 given up, last error HTTP_401 invalid api key`. Bedtime's new mNotify key
   works (6,441 credits). Both shops use mNotify, so issuing a fresh key for
   Bedtime almost certainly invalidated the one Everytinroom holds. I did not
   read their database to confirm — that is the cross-tenant access this work
   hardens against, and it was refused when I tried. **Only you can update
   their key.**

2. **The Cloudflare proxy decision.** It is the only remaining performance
   lever, and you asked for compatibility verification first.

3. **The CSP is report-only.** The policy is derived from every origin the
   bundles reference, but it has not been exercised in a real browser and one
   missing origin breaks the page. `frame-ancestors` **is** enforced.

## Residual risks, stated plainly

- **`public_order_get` returns address, phone, items and USSD code to anyone
  holding an order id.** Ids are the first 8 hex of a uuid4 (664 distinct of
  664) and REST is capped at 1200/min per IP, putting an expected hit at ~90
  hours of sustained traffic. It is a capability URL — which is what the
  customer-facing `#/pay/` and `#/deliver/` links require. Not "fixed", because
  narrowing it would break the payment page.
- **The PIN lockout is global**, so a determined attacker can lock every
  cashier out for five minutes. The alternative — per-staff lockout — leaks
  which PINs exist. The current trade is the right one; the new
  `auth_attempts` check makes it visible.
- **Image accumulation** continues until `lifecycle.mjs --quarantine` is run.
- **Core Web Vitals unmeasured**, as above.
