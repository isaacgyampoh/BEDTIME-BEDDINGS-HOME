#!/usr/bin/env bash
# ===========================================================================
# Say plainly whether an application's domain can get a certificate yet.
#
#   check-app-dns.sh <domain> [expected-ip]
#
# Read-only. It resolves names and reads one file; it changes nothing.
#
# WHY
#
# provision-app.sh sets the application's SUPABASE_URL to its public domain.
# Until an A record exists, any edge function that queries its own database
# through PostgREST hangs: pg_net records only
#   Timeout of 5000 ms reached ... (DNS time: 0.05ms, handshake: 0.7ms)
# which looks like the function being slow rather than the name not
# resolving. Bedtime lost time to exactly that.
#
# And Caddy, after repeated NXDOMAIN failures, falls back to Let's Encrypt's
# STAGING endpoint to avoid burning production rate limits. A staging
# certificate is untrusted, so even once DNS is fixed the site appears broken
# until Caddy returns to production on its own retry.
#
# THE RECORD, and why DNS-only matters
#
#   type A, name <sub>, content <server ip>, proxy DISABLED (grey cloud)
#
# Proxying through Cloudflare makes it serve its own certificate and breaks
# Caddy's HTTP-01 and TLS-ALPN-01 challenges, so Caddy never gets one.
# api.everytinroom.com resolves straight to the server for that reason.
# ===========================================================================
set -uo pipefail
DOM="${1:-}"
WANT="${2:-}"
[ -n "$DOM" ] || { echo "usage: $(basename "$0") <domain> [expected-ip]" >&2; exit 2; }

ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }

if [ -z "$WANT" ]; then
  WANT="$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -1)"
fi

resolve () { getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u | head -3; }
GOT="$(resolve "$DOM")"

if [ -z "$GOT" ]; then
  no "$DOM does not resolve"
  note "Create this record, then re-run:"
  note "    A   ${DOM%%.*}   ->   ${WANT:-<the server IP>}   (DNS only, not proxied)"
  note "Until it exists:"
  note "  - no certificate can be issued, so HTTPS will fail"
  note "  - every edge function that queries its own database will hang 5s"
  note "  - Caddy falls back to Let's Encrypt STAGING and stays there for a"
  note "    while after you fix it, so expect a delay before HTTPS works"
  exit 1
fi

if [ -n "$WANT" ] && ! printf '%s\n' "$GOT" | grep -qx "$WANT"; then
  no "$DOM resolves to $(printf '%s' "$GOT" | tr '\n' ' '), not $WANT"
  note "If those are Cloudflare addresses the record is PROXIED (orange"
  note "cloud). Turn the proxy off: it serves its own certificate and breaks"
  note "the ACME challenge, so Caddy will never obtain one."
  exit 1
fi
ok "$DOM resolves to $(printf '%s' "$GOT" | tr '\n' ' ')"

# Is a trusted certificate actually being served yet?
if command -v openssl >/dev/null 2>&1; then
  ISS="$(echo | timeout 15 openssl s_client -connect "$DOM:443" -servername "$DOM" 2>/dev/null \
         | openssl x509 -noout -issuer 2>/dev/null)"
  case "$ISS" in
    '')            note "nothing is serving TLS yet; Caddy may still be working" ;;
    *STAGING*|*Fake*|*staging*)
                   no "the certificate is from Let's Encrypt STAGING -- untrusted"
                   note "Caddy fell back after earlier failures. It returns to"
                   note "production on its own retry; the platform's documented"
                   note "reload is 'docker compose restart caddy', which briefly"
                   note "interrupts EVERY tenant, so prefer waiting." ;;
    *)             ok "serving a certificate: ${ISS#issuer=}" ;;
  esac
fi
