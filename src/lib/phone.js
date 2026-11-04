/**
 * One spelling for a Ghanaian phone number.
 *
 * WHY THIS EXISTS
 * The customers table keys on the phone number exactly as it was typed:
 *
 *   INSERT INTO customers (phone, ...) VALUES (...)
 *   ON CONFLICT (phone) DO UPDATE SET visit_count = visit_count + 1, ...
 *
 * So '0553071224' and '553071224' are two different customers. Production
 * holds 982 customer rows for 945 real people: 37 of them are stored twice,
 * once with the leading zero and once without, because 537 rows were saved
 * with it and 444 without. Every one of those people has their visit count
 * and their lifetime spend split across two records — 0548124978 is really
 * 11 visits and GHS 4,437, and it reads as 8 visits / GHS 2,905 in one row
 * and 3 visits / GHS 1,532 in another.
 *
 * Normalising before the write means the conflict clause can do its job. It
 * does not merge what is already split; that needs a database change and is
 * staged separately for approval.
 *
 * The local 0-prefixed form is the one chosen because it is how the shop
 * writes numbers and how the majority of existing rows are already stored, so
 * new visits accrue to the row that is most likely to already exist.
 */

/** The nine digits that identify the line, with no trunk code or country code. */
export function phoneKey(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '')
  if (d.startsWith('00233')) d = d.slice(5)
  else if (d.startsWith('233')) d = d.slice(3)
  if (d.startsWith('0')) d = d.slice(1)
  return d.length === 9 ? d : ''
}

/**
 * The number as it should be stored: 0XXXXXXXXX.
 *
 * Anything that is not recognisably a Ghanaian number is returned trimmed but
 * otherwise untouched. Guessing at an unfamiliar format would be worse than
 * leaving it alone — a mangled number cannot be rung.
 */
export function normalisePhone(raw) {
  const key = phoneKey(raw)
  return key ? `0${key}` : String(raw == null ? '' : raw).trim()
}

/** Do these two refer to the same line, however each was written? */
export function samePhone(a, b) {
  const ka = phoneKey(a), kb = phoneKey(b)
  if (ka && kb) return ka === kb
  return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim()
}

/** Is this a number a message or a payment prompt could actually reach? */
export const isReachable = (raw) => !!phoneKey(raw)
