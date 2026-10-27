import { suite } from './harness.mjs'
import { thumb } from '../src/lib/utils.js'
const t = suite('Images: the URL every photo is actually fetched from')

const STORED = 'https://wqkgfvmvuljzexhevlnp.supabase.co/storage/v1/object/public/product-images/products/1785-ab.jpg'

// On 27 October 2026 Supabase's transform endpoint began answering
//   {"statusCode":"403","error":"FeatureNotEnabled"}
// for this project while the original file still served normally. Every image
// in both apps was rewritten to that endpoint, so every photo failed. The shop
// front survived on an <img onError> that re-fetched the original; the admin
// had no fallback and showed blank squares.
t.eq('a stored photo is served from where it actually is', thumb(STORED, 88), STORED)
t.ok('and never through the transform endpoint', !thumb(STORED, 500).includes('/render/image/'))
t.ok('whatever width is asked for', !thumb(STORED, 1400).includes('/render/image/'))
t.ok('including no width at all', !thumb(STORED).includes('/render/image/'))

// The things that were already true must stay true.
t.eq('an empty url stays empty', thumb('', 88), '')
t.eq('a url that is not ours is left alone',
  thumb('https://images.example.com/duvet.jpg', 88), 'https://images.example.com/duvet.jpg')
t.ok('a data: url from the file picker is untouched',
  thumb('data:image/png;base64,iVBORw0KGgo=', 160).startsWith('data:image/png'))
