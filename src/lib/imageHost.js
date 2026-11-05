/**
 * Where a product photo is served from.
 *
 * The photo's address is stored in the database as a full Supabase URL, on
 * 879 paths across products, bundles, promos and the item snapshots kept on
 * every past receipt and order. Rewriting those rows to move hosts would mean
 * a migration over historical records that are otherwise never touched, and
 * going back would mean another one.
 *
 * So nothing in the database changes. The stored URL stays as it is and is
 * rewritten on its way to an <img> tag. Moving to R2 is one environment
 * variable and a deploy; moving back is unsetting it and a deploy. That is
 * the whole rollback, and it works for the receipts from August as well as
 * for a product added this morning.
 *
 *   VITE_IMAGE_HOST unset        serve from Supabase, exactly as now
 *   VITE_IMAGE_HOST=https://…    serve the same file from the R2 Worker
 */

const HOST = String(import.meta.env?.VITE_IMAGE_HOST || '').replace(/\/+$/, '')

/** The storage path inside the bucket, or null if this is not a bucket URL. */
export function storagePath(url, bucket = 'product-images') {
  const s = String(url || '')
  const marker = `/storage/v1/object/public/${bucket}/`
  const at = s.indexOf(marker)
  if (at === -1) return null
  const path = s.slice(at + marker.length).replace(/\?.*$/, '')
  return path || null
}

/**
 * The address to actually request.
 *
 * Anything that is not a Supabase bucket URL — a Cloudinary image, a data
 * URI, an empty value — is handed back untouched. A photo that loads from
 * the wrong host beats one that does not load at all.
 */
export function imageUrl(url) {
  if (!url) return ''
  if (!HOST) return url
  const path = storagePath(url)
  if (!path) return url
  return `${HOST}/img/${path.split('/').map(encodeURIComponent).join('/')}`
}

/** Is the R2 host configured? Shown on the health screen. */
export const imageHostName = () => HOST || 'supabase'
