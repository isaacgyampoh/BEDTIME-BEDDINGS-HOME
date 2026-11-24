/**
 * Where a new product photo is written.
 *
 * R2 first, Supabase Storage as the fallback. The point is to stop adding to
 * the Supabase Storage dependency we are migrating away from, without making
 * a staff member's upload fail if anything about the new path misbehaves.
 *
 * WHAT IS STORED IN THE DATABASE DOES NOT CHANGE
 *
 * The row still gets the Supabase-shaped public URL, whichever host actually
 * received the bytes. That is deliberate:
 *
 *   * `imageHost.js` rewrites the URL on its way to the <img> tag, so the
 *     stored value is already the thing it rewrites. Storing an R2 URL instead
 *     would make the row depend on the host and undo that.
 *   * every past receipt, order and bundle snapshot holds a Supabase-shaped
 *     URL. One shape everywhere means one code path, and a receipt from August
 *     keeps working.
 *   * rollback stays a redeploy rather than a data migration.
 *
 * HOW THE BROWSER IS ALLOWED TO WRITE TO R2
 *
 * It presents the GoTrue session the staff member already has. The Worker
 * verifies that signature against the project's PUBLISHED ES256 key, so no
 * secret exists in the browser -- which is the reason uploads went through
 * Supabase Storage in the first place.
 *
 * ONE THING TO KNOW ABOUT ROLLBACK
 *
 * A photo uploaded while R2 is the primary target exists in R2 and not in
 * Supabase. Unsetting VITE_IMAGE_HOST would therefore not find it. Everything
 * uploaded before the switch, and anything that fell back, is in both. Clear
 * VITE_IMAGE_HOST and new uploads return to Supabase immediately.
 */

const HOST = String(import.meta.env?.VITE_IMAGE_HOST || '').replace(/\/+$/, '')

/** Is the R2 path configured at all? */
export function r2Enabled() {
  return !!HOST
}

/**
 * Upload one product photo.
 *
 * Returns { ok, via, error }. `via` is 'r2' or 'supabase', so the caller can
 * say where it went and a problem is visible rather than silent.
 */
export async function uploadProductImage({ sb, path, blob, contentType, storageUrl }) {
  const publicUrl = `${storageUrl}/product-images/${path}`

  if (HOST) {
    try {
      // The staff session. If there is none we are not signed in, and the
      // Worker would refuse anyway -- fall through to Supabase rather than
      // send a request we know will fail.
      const { data } = await sb.auth.getSession()
      const accessToken = data?.session?.access_token
      if (accessToken) {
        const r = await fetch(`${HOST}/img/products/${path.replace(/^products\//, '')}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': contentType,
          },
          body: blob,
        })
        if (r.ok) return { ok: true, via: 'r2', url: publicUrl }
        // A 401 here means the session is not accepted -- worth knowing in the
        // console, because it is the one failure that would otherwise look
        // like "R2 is just slow".
        console.warn('R2 upload refused:', r.status, (await r.text()).slice(0, 200))
      } else {
        console.warn('R2 upload skipped: no staff session')
      }
    } catch (e) {
      console.warn('R2 upload threw, falling back to Supabase:', e?.message || e)
    }
  }

  const { error } = await sb.storage.from('product-images')
    .upload(path, blob, { cacheControl: '31536000', upsert: true, contentType })
  if (error) {
    return {
      ok: false,
      via: 'supabase',
      error: error.message || 'create a public "product-images" bucket in Supabase',
    }
  }
  return { ok: true, via: 'supabase', url: publicUrl }
}
