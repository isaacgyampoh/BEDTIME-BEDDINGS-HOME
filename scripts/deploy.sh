#!/usr/bin/env bash
# Publish both sites to Cloudflare Pages from this machine.
#
# Uses whatever wrangler is already logged in as (`npx wrangler login` once, if
# ever needed). The same gates CI would run come first, because the point of a
# deploy script is that a broken build cannot reach the shop.
#
#   ./scripts/deploy.sh          both sites
#   ./scripts/deploy.sh shop     the shop front only
#   ./scripts/deploy.sh admin    the POS only
set -euo pipefail
cd "$(dirname "$0")/.."
what="${1:-both}"
W="npx --yes wrangler@4"

say () { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Checks"
npx eslint src >/dev/null && echo "  admin lint clean"
(cd storefront && npx eslint src >/dev/null) && echo "  shop lint clean"
npm test --silent | tail -1

say "Builds"
npm run build --silent | tail -1
(cd storefront && npm run build --silent | tail -1)

say "No server secrets in what is about to be published"
for pat in SUPABASE_SERVICE_ROLE_KEY NALOPAY_API_KEY MNOTIFY_KEY OPENAI_API_KEY service_role sk-proj- cfut_ sbp_; do
  for b in dist/assets storefront/dist/assets; do
    if grep -rq "$pat" "$b"/*.js 2>/dev/null; then echo "  REFUSING: '$pat' found in $b"; exit 1; fi
  done
done
echo "  clean"

# Without these a deep link 404s and an old service worker pins itself.
for f in dist/_redirects dist/_headers storefront/dist/_redirects storefront/dist/_headers; do
  test -s "$f" || { echo "  REFUSING: $f missing from the build"; exit 1; }
done

if [ "$what" = both ] || [ "$what" = admin ]; then
  say "Publishing the POS"
  $W pages deploy dist --project-name=bedtime-admin --branch=main --commit-dirty=true | tail -2
fi
if [ "$what" = both ] || [ "$what" = shop ]; then
  say "Publishing the shop front"
  (cd storefront && $W pages deploy dist --project-name=bedtime-shop --branch=main --commit-dirty=true | tail -2)
fi

say "Are they answering?"
for url in https://bedtimehome.com/ https://www.bedtimehome.com/ https://admin.bedtimehome.com/; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --retry 4 --retry-all-errors --retry-delay 3 --max-time 30 "$url")
  printf '  %-34s %s\n' "$url" "$code"
  [ "$code" = 200 ] || exit 1
done
