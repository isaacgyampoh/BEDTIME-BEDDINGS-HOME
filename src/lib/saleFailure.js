/**
 * What to tell a cashier when a sale could not be recorded.
 *
 * This POS has no offline sale queue: `record_sale` is a round trip, and if it
 * does not come back the sale does not exist. That is a deliberate design --
 * queueing sales locally would mean two tills could each sell the last unit --
 * but it puts all the weight on the message, because the person reading it is
 * standing in front of a customer holding the goods.
 *
 * The old text was `Error: ` + whatever the browser said, which on a dropped
 * connection is "Load failed" or "Failed to fetch". That reads like a glitch
 * worth ignoring rather than "this sale does not exist", and a cashier who
 * ignores it hands over the stock for nothing.
 *
 * The cart is never cleared on failure (finishSale only runs on success), so
 * every message says so: the sale can simply be taken again.
 */
export function saleFailureMessage(error, online = true) {
  const raw = String(error?.message || error || '').trim()

  if (!online) {
    return 'No internet — this sale was NOT saved. The cart is kept, so take it again when the connection is back.'
  }

  // A fetch that never reached the server looks like this in each engine:
  // Chrome "Failed to fetch", Safari "Load failed", Firefox "NetworkError".
  if (/failed to fetch|load failed|networkerror|network request failed/i.test(raw)) {
    return 'Could not reach the server — this sale was NOT saved. The cart is kept, so try again.'
  }

  if (/timeout|timed out|aborted/i.test(raw)) {
    return 'The server did not answer in time — this sale was NOT saved. The cart is kept, so try again.'
  }

  return `This sale was NOT saved: ${raw || 'unknown error'}. The cart is kept, so you can try again.`
}
