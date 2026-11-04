import { suite } from './harness.mjs'
import { normalisePhone, phoneKey, samePhone, isReachable } from '../src/lib/phone.js'
const t = suite('One spelling for a phone number')

// The defect: customers are keyed on the phone exactly as typed, so the same
// person becomes two customers. Production holds 982 rows for 945 people.
t.eq('a local number is left as it is', normalisePhone('0553071224'), '0553071224')
t.eq('a number typed without the trunk zero gains one', normalisePhone('553071224'), '0553071224')
t.eq('+233 becomes the local form', normalisePhone('+233553071224'), '0553071224')
t.eq('233 without the plus too', normalisePhone('233553071224'), '0553071224')
t.eq('and 00233', normalisePhone('00233553071224'), '0553071224')
t.eq('spaces are not part of a number', normalisePhone('055 307 1224'), '0553071224')
t.eq('nor dashes or brackets', normalisePhone('(055)-307-1224'), '0553071224')
t.eq('surrounding whitespace goes', normalisePhone('  0553071224  '), '0553071224')

// The two that matter most in production: these were two customers.
t.ok('the two spellings production holds are one number',
  samePhone('0553071224', '553071224'))
t.eq('and both normalise to the same stored value',
  normalisePhone('0553071224'), normalisePhone('553071224'))

// Not everything is a Ghanaian mobile, and guessing would be worse than
// leaving it alone: a mangled number cannot be rung.
t.eq('a short number is not reshaped', normalisePhone('12345'), '12345')
t.eq('a foreign number is left intact', normalisePhone('+1 415 555 2671'), '+1 415 555 2671')
t.eq('nothing in, nothing out', normalisePhone(''), '')
t.eq('null is not the string "null"', normalisePhone(null), '')
t.eq('nor undefined', normalisePhone(undefined), '')

t.eq('the key is the nine significant digits', phoneKey('+233553071224'), '553071224')
t.eq('an unrecognisable number has no key', phoneKey('12345'), '')
t.ok('a real number is reachable', isReachable('0553071224'))
t.ok('a half-typed one is not', !isReachable('05530'))
t.ok('and an empty one is not', !isReachable(''))

// Different lines must stay different — the whole point is to merge the same
// person, never two people.
t.ok('one digit apart is a different person', !samePhone('0553071224', '0553071225'))
t.ok('a missing number matches nothing', !samePhone('', '0553071224'))
t.ok('two unrecognisable strings still compare literally', samePhone('abc', 'abc'))

// Every format found in production, normalised, must collapse to one value
// per line — this is the assertion that the duplicate rows cannot recur.
{
  const asStored = ['0554909024', '554909024', '0553071224', '553071224',
                    '0548124978', '548124978', '+233542854846', '542854846']
  const distinct = new Set(asStored.map(normalisePhone))
  t.eq('eight stored spellings are four people', distinct.size, 4)
}
