import { suite } from './harness.mjs'
import { chooseUpload, extensionFor, isDisplayable, uploadPath, verifyUploaded } from '../src/lib/productImage.js'
const t = suite('Admin: what actually gets uploaded as a product photo')

const f = (type, size = 900_000, name = 'photo') => ({ type, size, name })
const blob = (size) => ({ size })

// ── the report: "when you upload a product and add an image, it doesn't show"
// A photo straight off an iPhone is HEIC. Nothing in a browser can decode it,
// so the canvas re-encode produced nothing and the ORIGINAL HEIC bytes were
// uploaded under a .jpg name with contentType image/jpeg. No error was shown,
// the product saved, and the picture never appeared.
{
  const heic = chooseUpload(f('image/heic', 2_400_000, 'IMG_4312.HEIC'), null)
  t.ok('a HEIC photo is refused rather than silently stored', !!heic.error)
  t.ok('and it is NOT uploaded as jpeg', !heic.blob)
  t.ok('the message says HEIC', /HEIC/i.test(heic.error))
  t.ok('and tells the person what to change', /Most Compatible|JPEG/i.test(heic.error))

  // Some phones report no type at all; the filename is the only clue.
  const byName = chooseUpload(f('', 2_000_000, 'IMG_0099.heif'), null)
  t.ok('a .heif with no media type is caught by its name', /HEIC/i.test(byName.error || ''))
}

// ── when the browser CAN decode it, we hold real jpeg bytes ────────────────
{
  const r = chooseUpload(f('image/heic', 3_000_000), blob(400_000))
  t.eq('a decoded photo is uploaded as the re-encoded jpeg', r.contentType, 'image/jpeg')
  t.eq('with a matching extension', r.ext, 'jpg')
  t.eq('and it is the encoded blob, not the original', r.blob.size, 400_000)
}

// ── the re-encode coming out LARGER used to send the original ─────────────
// Re-encoding an already-compressed JPEG or a flat PNG usually grows it. The
// old code treated that as "keep the original" and still called it jpeg.
{
  const r = chooseUpload(f('image/png', 120_000), blob(180_000))
  t.eq('a larger re-encode is still used, because it is honestly jpeg', r.contentType, 'image/jpeg')
  t.eq('bytes are the encoded ones', r.blob.size, 180_000)
}

// ── a small file that skipped the resize must not be mislabelled ──────────
{
  const png = chooseUpload(f('image/png', 80_000), null)
  t.eq('a small PNG keeps its real type', png.contentType, 'image/png')
  t.eq('and gets a .png name', png.ext, 'png')

  const webp = chooseUpload(f('image/webp', 60_000), null)
  t.eq('so does a webp', webp.contentType, 'image/webp')
  t.eq('with the right extension', webp.ext, 'webp')

  const jpg = chooseUpload(f('image/jpeg', 90_000), null)
  t.eq('a small jpeg is uploaded as jpeg', jpg.contentType, 'image/jpeg')

  // Some browsers report image/jpg, which is not a real media type.
  const odd = chooseUpload(f('image/jpg', 90_000), null)
  t.eq('image/jpg is normalised to image/jpeg', odd.contentType, 'image/jpeg')
  t.eq('and still named .jpg', odd.ext, 'jpg')
}

// ── anything else is refused with a reason, not stored broken ─────────────
{
  const pdf = chooseUpload(f('application/pdf', 50_000, 'invoice.pdf'), null)
  t.ok('a PDF is refused', !!pdf.error)
  t.ok('and named in the message', /application\/pdf/.test(pdf.error))
  const tiff = chooseUpload(f('image/tiff', 50_000), null)
  t.ok('a TIFF is refused too', !!tiff.error)
  t.ok('nothing is chosen', !tiff.blob)
  t.ok('no file at all is refused', !!chooseUpload(null, null).error)
}

// ── the stored path must match the bytes ──────────────────────────────────
{
  t.ok('a png upload is named .png', uploadPath('png', 1700000000000, 0.5).endsWith('.png'))
  t.ok('a jpg upload is named .jpg', uploadPath('jpg', 1700000000000, 0.5).endsWith('.jpg'))
  t.ok('an unknown extension falls back to jpg', uploadPath('bmp', 1700000000000, 0.5).endsWith('.jpg'))
  t.ok('and it lives under products/', uploadPath('jpg').startsWith('products/'))
}

// ── the small helpers ─────────────────────────────────────────────────────
t.eq('jpeg maps to jpg', extensionFor('image/jpeg'), 'jpg')
t.eq('case does not matter', extensionFor('IMAGE/PNG'), 'png')
t.eq('an unknown type has no extension', extensionFor('image/heic'), '')
t.ok('heic is not displayable', !isDisplayable('image/heic'))
t.ok('webp is', isDisplayable('image/webp'))

// ── "Saved!" with no picture is the failure that wastes the most time ──────
// The upload can succeed and the file still be invisible. Asking for it back
// turns that into a sentence naming the cause.
{
  const res = (status, type) => async () => ({ status, headers: { get: () => type } })
  const ok200 = await verifyUploaded('https://x/img.jpg', res(200, 'image/jpeg'))
  t.ok('a readable image passes', ok200.ok)
  const ok206 = await verifyUploaded('https://x/img.jpg', res(206, 'image/webp'))
  t.ok('a ranged response passes too', ok206.ok)

  const gone = await verifyUploaded('https://x/img.jpg', res(400, ''))
  t.ok('400 is reported, not swallowed', !gone.ok)
  t.ok('and names the bucket as the thing to check', /product-images|bucket/i.test(gone.why))

  const denied = await verifyUploaded('https://x/img.jpg', res(403, ''))
  t.ok('403 says access is denied', !denied.ok && /denied|private/i.test(denied.why))

  const wrongType = await verifyUploaded('https://x/img.jpg', res(200, 'application/json'))
  t.ok('a 200 that is not an image still fails', !wrongType.ok)
  t.ok('and says what came back instead', /application\/json/.test(wrongType.why))

  const dead = await verifyUploaded('https://x/img.jpg', async () => { throw new Error('Failed to fetch') })
  t.ok('a network failure is reported', !dead.ok && /could not be reached/i.test(dead.why))
  t.ok('no url at all is reported', !(await verifyUploaded('', res(200, 'image/jpeg'))).ok)
}
