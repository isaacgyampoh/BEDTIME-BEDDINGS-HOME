/**
 * Deciding what actually gets uploaded for a product photo.
 *
 * The upload used to name every file `.jpg` and declare it `image/jpeg`, while
 * four separate paths could hand it the ORIGINAL bytes instead of the
 * re-encoded JPEG: when the photo was already small, when the browser could not
 * decode it, when anything threw, and when the re-encode came out larger than
 * the original (which is common — re-encoding an already-compressed JPEG or a
 * flat PNG usually grows it).
 *
 * So a HEIC photo off a phone was stored as `image/jpeg`. The upload returned
 * no error, the product saved, and the picture never appeared anywhere,
 * because nothing can decode HEIC as JPEG. That is the "image doesn't show"
 * report: no error, no clue, no photo.
 *
 * The rule here is that what we claim a file is must be what it is.
 */

/** Types a browser can actually display, so uploading them is safe. */
const DISPLAYABLE = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

/** The file extension that matches a media type. */
export const extensionFor = (type) => DISPLAYABLE[String(type || '').toLowerCase()] || ''

/** Can a browser show this without converting it first? */
export const isDisplayable = (type) => !!DISPLAYABLE[String(type || '').toLowerCase()]

/**
 * What to upload, given the original file and whatever the canvas managed to
 * re-encode (null when the browser could not decode the image at all).
 *
 * Returns either { blob, ext, contentType } or { error } with a sentence that
 * can go straight on screen.
 */
export function chooseUpload(file, encoded) {
  if (!file) return { error: 'No image was chosen' }
  const type = String(file.type || '').toLowerCase()

  // The canvas decoded it, so we hold real JPEG bytes. Use them even when they
  // are slightly larger than the original: a photo that displays and costs a
  // few more kilobytes beats a smaller one that never appears.
  if (encoded && encoded.size > 0) {
    return { blob: encoded, ext: 'jpg', contentType: 'image/jpeg' }
  }

  // No re-encode. That is fine as long as the original is something a browser
  // can draw — then we upload it untouched and, crucially, say what it is.
  if (isDisplayable(type)) {
    return { blob: file, ext: extensionFor(type), contentType: type === 'image/jpg' ? 'image/jpeg' : type }
  }

  // Neither decodable nor displayable. Uploading it would repeat the original
  // fault silently, so refuse and say why in words the person can act on.
  const looksHeic = /heic|heif/i.test(type) || /\.hei[cf]$/i.test(file.name || '')
  return {
    error: looksHeic
      ? 'That photo is in iPhone HEIC format, which websites cannot display. On the iPhone: Settings → Camera → Formats → Most Compatible, then take the photo again. Or open it in Photos and share it as a JPEG.'
      : `That file is ${type || 'an unknown format'}, which cannot be shown on the web. Please use a JPG or PNG.`,
  }
}

/**
 * The storage path for an upload. The extension has to match the bytes, or
 * the image transform serves a file it cannot read.
 */
export function uploadPath(ext, now = Date.now(), rand = Math.random()) {
  const safe = DISPLAYABLE[`image/${ext}`] ? ext : (extensionFor(`image/${ext}`) || 'jpg')
  return `products/${now}-${rand.toString(36).slice(2, 8)}.${safe}`
}

/**
 * Did the photo we just uploaded actually become visible?
 *
 * "Saved!" appearing while no picture ever shows is the failure that wastes
 * the most time, because nothing on screen says which half went wrong. The
 * upload can succeed and the file still be unreadable — a bucket that is no
 * longer public, a policy that did not survive a restore, a transform that
 * refuses the file. So ask for it back before claiming success, and report
 * what came back.
 *
 * `fetchFn` is injectable so this can be tested without a network.
 */
export async function verifyUploaded(publicUrl, fetchFn = fetch) {
  if (!publicUrl) return { ok: false, why: 'No image URL was produced' }
  try {
    const res = await fetchFn(publicUrl, { method: 'GET', headers: { Range: 'bytes=0-0' } })
    const status = res.status
    if (status === 200 || status === 206) {
      const type = (res.headers && res.headers.get && res.headers.get('content-type')) || ''
      if (type && !type.startsWith('image/')) {
        return { ok: false, status, why: `The file came back as ${type}, not an image. It was stored, but nothing can display it.` }
      }
      return { ok: true, status }
    }
    if (status === 400 || status === 404) {
      return { ok: false, status, why: 'The photo uploaded but cannot be read back. The "product-images" bucket may no longer be public — check it in Supabase under Storage.' }
    }
    if (status === 401 || status === 403) {
      return { ok: false, status, why: 'The photo uploaded but access to it is denied. The "product-images" bucket is private, or its read policy is missing.' }
    }
    return { ok: false, status, why: `The photo uploaded but reading it back returned ${status}.` }
  } catch (e) {
    return { ok: false, why: `The photo uploaded but could not be reached: ${e?.message || 'network error'}` }
  }
}
