export const money = v => 'GHS ' + Number(v || 0).toFixed(2)

// No online payment yet for this brand. When false, checkout places the order
// and the shop contacts the customer to arrange payment (pay on delivery /
// pickup). Flip to true + point EDGE_URL at the new project to enable MoMo.
export const PAYMENTS_ENABLED = false
export const EDGE_URL = 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/charge-momo'
export const thumb = (url, w = 600) => {
  if (!url) return ''
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
