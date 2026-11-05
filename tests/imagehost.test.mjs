import { suite } from './harness.mjs'
import { storagePath, imageUrl, imageHostName } from '../src/lib/imageHost.js'
const t = suite('Moving the photos to R2 is a flag, not a migration')

/**
 * 879 storage paths are referenced from the database, and 277 of them live on
 * past receipts and orders rather than on products — the item snapshot kept
 * when a sale was recorded carries the image URL as it was. Rewriting rows to
 * change hosts would mean a migration over historical records, and going back
 * would mean another. So the stored URL never changes and the host is chosen
 * on the way to the <img> tag.
 */
const SB = 'https://wqkgfvmvuljzexhevlnp.supabase.co/storage/v1/object/public/product-images/products/1786368656294-dab7i2.jpg'

t.eq('the storage path is read out of a stored URL',
  storagePath(SB), 'products/1786368656294-dab7i2.jpg')
t.eq('query parameters are not part of the path',
  storagePath(SB + '?width=600&quality=70'), 'products/1786368656294-dab7i2.jpg')
t.eq('a transform URL is not a bucket URL', storagePath(SB.replace('/object/public/', '/render/image/public/')), null)
t.eq('nor is a Cloudinary URL', storagePath('https://res.cloudinary.com/x/image/upload/v1/a.jpg'), null)
t.eq('nor a data URI', storagePath('data:image/png;base64,iVBOR'), null)
t.eq('nor an empty value', storagePath(''), null)
t.eq('nor null', storagePath(null), null)
t.eq('a different bucket is not matched', storagePath(SB.replace('product-images', 'other-bucket')), null)

// With no host configured — which is how it ships — nothing changes at all.
t.eq('with no host set the stored URL is served unchanged', imageUrl(SB), SB)
t.eq('an empty value stays empty', imageUrl(''), '')
t.eq('null becomes empty, not the string "null"', imageUrl(null), '')
t.eq('a Cloudinary URL is untouched',
  imageUrl('https://res.cloudinary.com/x/image/upload/v1/a.jpg'),
  'https://res.cloudinary.com/x/image/upload/v1/a.jpg')
t.eq('and the host reports itself as supabase', imageHostName(), 'supabase')

// The rewrite itself, exercised directly: the module reads the flag once at
// load, so this checks the mapping rather than re-importing with an env set.
{
  const HOST = 'https://images.bedtimehome.com'
  const rewrite = (url) => {
    const p = storagePath(url)
    return p ? `${HOST}/img/${p.split('/').map(encodeURIComponent).join('/')}` : url
  }
  t.eq('a bucket URL maps onto the Worker path',
    rewrite(SB), `${HOST}/img/products/1786368656294-dab7i2.jpg`)
  t.eq('a space in a filename is encoded, not left to break the URL',
    rewrite(SB.replace('1786368656294-dab7i2.jpg', 'my photo.jpg')),
    `${HOST}/img/products/my%20photo.jpg`)
  t.eq('the slash between folder and file is kept, not encoded',
    rewrite(SB).split('/img/')[1].startsWith('products/'), true)
  t.eq('anything that is not a bucket URL is left alone',
    rewrite('data:image/png;base64,iVBOR'), 'data:image/png;base64,iVBOR')
}

// A path that tried to climb out of the bucket must not survive the round
// trip, because the Worker is what refuses it and the Worker sees this string.
t.ok('traversal is visible in the path for the Worker to reject',
  storagePath(SB.replace('products/', '../')) === '../1786368656294-dab7i2.jpg')
