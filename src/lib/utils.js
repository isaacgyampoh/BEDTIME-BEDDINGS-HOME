// Utility functions
export const money = n => 'GHS ' + Number(n || 0).toFixed(2)
export const num = n => Number(n) || 0
export const today = () => new Date().toISOString().slice(0, 10)
export const weekStartDate = () => { const d = new Date(); d.setDate(d.getDate() - d.getDay()); return d.toISOString().slice(0, 10) }
export const monthStart = () => new Date().toISOString().slice(0, 8) + '01'
export const isoDate = d => (d || '').slice(0, 10)
export const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''
export const fmtDateTime = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
// ImageKit free CDN endpoint — set this to your endpoint to route ALL images
// through ImageKit (faster, auto WebP/AVIF, 20GB/mo free). Leave '' to keep
// using the raw image URLs / Cloudinary transforms as before.
// Example: 'https://ik.imagekit.io/bqikvsp59'
export const IMAGEKIT_ENDPOINT = 'https://ik.imagekit.io/bqikvsp59'

const TRANSFORMS_ON = String(import.meta.env?.VITE_IMAGE_TRANSFORMS || '') === 'on'

export const thumb = (url, w) => {
  if (!url) return ''
  // Supabase storage: use the built-in image transform to serve a resized,
  // compressed version instead of the full-size upload. A 3MB photo becomes a
  // ~15-40KB thumbnail — the single biggest load-speed win. Falls back to the
  // original if transforms aren't available.
  // Supabase's image transform endpoint is a paid feature, and on 27 October
  // 2026 it stopped being enabled on this project: every /render/image/ request
  // returns
  //     {"statusCode":"403","error":"FeatureNotEnabled",
  //      "message":"feature not enabled for this tenant"}
  // while the original file still serves fine. Because every image in both
  // apps was rewritten to that endpoint, every photo 403'd. The shop front only
  // looked healthy because its <img onError> quietly re-fetched the original —
  // two requests per photo, one of them always failing. The admin had no such
  // fallback, so product photos were simply blank, which is what "the image
  // doesn't show" was.
  //
  // So the original is served directly. Set VITE_IMAGE_TRANSFORMS=on to turn
  // the resizing back on if the feature is ever enabled again; until then a
  // photo that loads beats a smaller one that does not.
  if (url.includes('/storage/v1/object/public/')) {
    if (!TRANSFORMS_ON) return url
    const width = w || 600
    return url.replace('/object/public/', '/render/image/public/') + `?width=${width}&quality=70&resize=contain`
  }
  // Cloudinary images route through ImageKit for optimization + because
  // Cloudinary's free tier is unreliable. If ImageKit ever fails, these are
  // being migrated to Supabase anyway.
  if (IMAGEKIT_ENDPOINT && url.includes('res.cloudinary.com/')) {
    const ep = IMAGEKIT_ENDPOINT.replace(/\/+$/, '')
    let path = url.split('res.cloudinary.com/')[1]
    path = path.replace(/(\/upload\/)[^/]*[,_][^/]*\//, '$1')
    return `${ep}/${path}?tr=w-${w},q-70,f-auto`
  }
  // Fallback: Cloudinary on-the-fly transform.
  if (url.includes('/upload/')) return url.replace(/\/upload\//, `/upload/w_${w},c_fill,q_auto,f_auto/`)
  return url
}

export const SHOP = {
  name: 'BEDTIME BEDDINGS & HOME',
  tagline: '',
  phone: '059 908 4552',
  address: 'McCarthy Hills Junction, Accra',
  addressFull: '',
  mapsUrl: 'https://maps.app.goo.gl/J6ZzrEGW5kXZmo2N6',
  yango: '',
  website: 'bedtimehome.com',
  promoMsg: '',
}

export const ADMIN_PIN = null

// Cash-only until the NaloPay keys are connected. Flip to true (and set the
// edge-function secrets) to enable MoMo direct-prompt + USSD + Split payments.
export const PAYMENTS_ENABLED = true

// This brand has no e-commerce website yet. Hides the Online Shop toggle,
// the WhatsApp online-order features, and website references. Flip to true
// when the storefront is built.
export const ECOMMERCE_ENABLED = false
