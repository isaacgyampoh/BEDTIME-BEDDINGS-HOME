# Moving the product photos to Cloudflare R2

**Nothing here has been run.** Creating the bucket, deploying the Worker and
pointing a DNS record at it are yours to do, and the migration script copies
only — it never deletes from Supabase and never writes to the database.

## What is actually there

Measured against production on 5 November 2026 (`node r2/migrate.mjs --dry-run`):

| | files | size |
|---|---|---|
| objects in `product-images` | 1,076 | 300.1 MB |
| referenced by a database row | **879** | **220.3 MB** |
| referenced by nothing | 197 | 79.9 MB |
| referenced but missing (broken images) | **0** | — |

1,058 JPEG, 18 WebP, average 286 KB, only 4 files over 1 MB.

Two things worth knowing before planning around those numbers:

**The 879 are not all product photos.** 602 come from `products.image`. The
other **277 come from the item snapshots kept on past receipts, orders and
bundles** — when a sale is recorded, the items are stored as they were at the
time, image URL included. A migration that moved only `products.image` would
leave every receipt from August onwards pointing at a bucket that is no longer
served. This is why the stored URL is never rewritten (see *Rollback*).

**The 197 unreferenced files are not safe to delete yet.** They are most
likely replaced photos and abandoned uploads, but "no row mentions it" is not
the same as "nothing needs it", and 79.9 MB is not worth the risk while R2's
free allowance is 10 GB. They are not copied unless you pass `--all`.

## Cost

R2 free tier: 10 GB stored, 1 M class-A and 10 M class-B operations a month,
**and no charge for egress**. The 220 MB that needs moving is **2.2%** of the
storage allowance. Reads are served from Cloudflare's cache, so R2 itself sees
very few of them.

The point is not the storage bill, which is nil either way. It is that this
removes the image-transformation charge entirely: no `/render/image/` endpoint,
no Cloudflare Images subscription, and resizing done in the browser before
upload, where it also makes uploads faster on an Accra connection.

## Where the credentials live, and where they do not

The POS and the shop front are static sites with no server, so an R2 access
key placed in either would be shipped to every browser that loads the page.

So there is no access key. `r2/worker.js` runs at the edge with an R2
**binding** — the platform grants the Worker access to the bucket, and no
credential exists in any form that can be copied out. The only secret is
`UPLOAD_SECRET`, which authorises uploads and deletes, is set with
`wrangler secret put`, and never appears in `wrangler.toml` or in git.

Public reads need no secret at all, which is what they already were under
Supabase's public bucket.

## Steps

```sh
# 1. The bucket. Free tier; no card needed beyond the Cloudflare account you have.
npx wrangler r2 bucket create bedtime-images

# 2. The upload secret. Generate it on your machine; do not paste it anywhere.
openssl rand -hex 32 | npx wrangler secret put UPLOAD_SECRET --config r2/wrangler.toml

# 3. The Worker.
npx wrangler deploy --config r2/wrangler.toml

# 4. A hostname for it: images.bedtimehome.com -> the Worker, in the
#    Cloudflare dashboard under Workers Routes (or a custom domain on the
#    Worker). Then:
curl -s https://images.bedtimehome.com/health          # {"ok":true,"bucket":"bound"}

# 5. See what would move. Reads only.
SUPABASE_URL=… SUPABASE_ANON_KEY=… R2_WORKER_URL=https://images.bedtimehome.com \
  node r2/migrate.mjs --dry-run

# 6. Copy. Every file is re-fetched from both sides afterwards and compared by
#    SHA-256 — not by size, because a truncated upload can match a size check.
SUPABASE_URL=… SUPABASE_ANON_KEY=… R2_WORKER_URL=… R2_UPLOAD_SECRET=… \
  node r2/migrate.mjs

# 7. Verify again later, independently, copying nothing.
… node r2/migrate.mjs --verify
```

Then, and only once step 6 reports every file verified:

```sh
# 8. Serve from R2. This is the only change to the apps.
VITE_IMAGE_HOST=https://images.bedtimehome.com npm run deploy
```

## Rollback

```sh
npm run deploy        # with VITE_IMAGE_HOST unset
```

That is the whole of it, and it is why `src/lib/imageHost.js` rewrites the URL
on its way to the `<img>` tag rather than changing what is stored. The database
still holds Supabase URLs for all 879 paths, the files are still in Supabase
Storage, and a receipt from August works under either host. There is no
migration to reverse and no window where some rows point one way and some the
other.

Keep the Supabase bucket until the shop has run on R2 long enough that you
would have noticed a problem — weeks, not hours. Deleting it is a separate
decision, and 300 MB is not worth hurrying.

## What is not covered

- **Private images.** Everything in `product-images` is a product photo shown
  to the public, so nothing here needs signing. If a private bucket is ever
  needed — scanned supplier invoices are the likely one; `invoices.image`
  exists and currently holds nothing — the Worker gains a second route that
  checks the staff session before reading from a separate bucket. I have not
  built it speculatively.
- **Thumbnail sizes.** One file per photo, resized in the browser at upload.
  If distinct sizes are ever wanted, the upload writes `products/<id>.jpg` and
  `products/<id>-sm.webp` and `thumb(url, w)` picks between them — still no
  paid transform service.
