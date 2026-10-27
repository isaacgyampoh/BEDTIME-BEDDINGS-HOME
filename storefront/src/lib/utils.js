export const money = v => 'GHS ' + Number(v || 0).toFixed(2)

// No online payment yet for this brand. When false, checkout places the order
// and the shop contacts the customer to arrange payment (pay on delivery /
// pickup). Flip to true + point EDGE_URL at the new project to enable MoMo.
export const PAYMENTS_ENABLED = true
// Same env override as the client, so one setting repoints the whole shop.
export const EDGE_URL = `${import.meta.env?.VITE_SUPABASE_URL || 'https://wqkgfvmvuljzexhevlnp.supabase.co'}/functions/v1/super-service`
const TRANSFORMS_ON = String(import.meta.env?.VITE_IMAGE_TRANSFORMS || '') === 'on'

export const thumb = (url, w = 600) => {
  if (!url) return ''
  // Supabase storage: serve a resized/compressed version via the image transform
  // endpoint instead of the full-size upload (big load-speed win).
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
  if (url.includes('cloudinary')) return url.replace('/upload/', `/upload/w_${w},c_fill,f_auto,q_auto/`)
  return url
}
export const SHOP = {
  name: 'BEDTIME BEDDINGS & HOME',
  phone: '059 908 4552',

  address: '',
  mapsUrl: '',
  whatsapp: '233599084552',
  domain: '',
}
