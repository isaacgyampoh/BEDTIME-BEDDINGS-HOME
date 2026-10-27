#!/usr/bin/env bash
# Is the shop actually open?
#
# Written after 26 October 2026, when the Supabase project was deleted and both
# sites went on serving perfectly — an empty catalogue, a till nobody could sign
# in to — for as long as it took someone to notice by hand. Every page returned
# HTTP 200 throughout. A check that only pings the front door would have seen
# nothing wrong, so this one asks the database for a product.
#
# Exits non-zero if anything is wrong, which is what makes the scheduled run
# fail and send mail.
set -uo pipefail
fail=0
note () { printf '%s\n' "$*"; }
bad  () { printf '  FAIL  %s\n' "$*"; fail=1; }
good () { printf '  ok    %s\n' "$*"; }

note "== the two sites =="
for host in bedtimehome.com www.bedtimehome.com admin.bedtimehome.com; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --retry 2 --retry-all-errors --max-time 25 "https://$host/")
  [ "$code" = 200 ] && good "https://$host" || bad "https://$host returned $code"
done

note "== the database behind them =="
# The exact failure of 26 Oct: the hostname stopped resolving. An unauthenticated
# request to a healthy PostgREST answers 401, which is a fine sign of life; a
# dead project gives 000, because nothing was ever reached.
SB=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "https://wqkgfvmvuljzexhevlnp.supabase.co/rest/v1/")
case "$SB" in
  000) bad "the Supabase project did not answer at all — this is what a deleted or unreachable project looks like" ;;
  401|200) good "the project is answering (HTTP $SB)" ;;
  *) bad "the project answered $SB, which is not expected" ;;
esac

note "== is there actually a catalogue to sell from? =="
# The key is read from the deployed bundle rather than kept here: it is public
# either way, and this also proves the shipped JavaScript is intact.
html=$(curl -s --max-time 25 https://bedtimehome.com/)
asset=$(printf '%s' "$html" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
if [ -z "$asset" ]; then
  bad "could not find the shop's JavaScript bundle in the page"
else
  key=$(curl -s --compressed --max-time 40 "https://bedtimehome.com$asset" \
        | grep -oE 'eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+' | head -1)
  if [ -z "$key" ]; then
    bad "no API key in the bundle — the build may be broken"
  else
    range=$(curl -s -D - -o /dev/null --max-time 30 \
      "https://wqkgfvmvuljzexhevlnp.supabase.co/rest/v1/products?select=id" \
      -H "apikey: $key" -H "Authorization: Bearer $key" \
      -H "Prefer: count=exact" -H "Range: 0-0" | tr -d '\r' | grep -i '^content-range:' | awk '{print $2}')
    n=${range#*/}
    if [ -z "$n" ] || [ "$n" = "*" ]; then
      bad "the catalogue could not be counted — the shop may be showing nothing"
    elif [ "$n" -lt 1 ] 2>/dev/null; then
      bad "the catalogue is EMPTY — customers are seeing a shop with no products"
    else
      good "$n products on sale"
    fi
  fi
fi

note "== can a customer actually see a photo? =="
# On 27 October 2026 every photo in both apps 403'd, because Supabase's image
# transform endpoint stopped being enabled for this project and every image URL
# was rewritten to it. The pages still returned 200 throughout. So ask for a
# real product photo the way a browser does, and check an image comes back.
img=$(curl -s --max-time 30 "https://wqkgfvmvuljzexhevlnp.supabase.co/rest/v1/products?select=image&image=like.*product-images*&limit=1" \
      -H "apikey: ${key:-}" -H "Authorization: Bearer ${key:-}" | sed -n 's/.*"image":"\([^"]*\)".*/\1/p')
if [ -z "$img" ]; then
  bad "could not find a product photo to test"
else
  ct=$(curl -s -o /dev/null -w '%{content_type}' --max-time 30 "$img")
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$img")
  case "$ct" in
    image/*) good "product photos load ($ct)" ;;
    *)       bad "a product photo returned $code as $ct, not an image — customers are seeing blank squares" ;;
  esac
fi

note ""
if [ "$fail" -eq 0 ]; then note "The shop is open."; else note "THE SHOP NEEDS ATTENTION — see the failures above."; fi
exit "$fail"
