#!/usr/bin/env python3
"""
Make the gateway answer CORS preflights for /auth/v1/*.

    python3 -I patch-caddy-auth-cors.py          # patches the site template
    # then re-render each app's site file and restart Caddy:
    #   sed -e 's/__APP_DNS__/<app>/g' -e 's/__DOMAIN__/api.<domain>/g' \
    #     caddy-site.template > caddy-sites/<app>.caddy
    #   docker exec central-caddy caddy validate --config /etc/caddy/Caddyfile
    #   docker restart central-caddy

WHAT THIS FIXES, AND WHY IT IS NOT COSMETIC

Self-hosted GoTrue (seen on v2.197.0) answers a CORS preflight that names ANY
request header -- authorization, apikey, even content-type -- with a bare 204
and no Access-Control-* headers at all. The browser therefore never sends the
request that would have followed. A preflight naming no headers IS answered
correctly, which is what makes this so easy to miss from the outside.

Hosted Supabase never shows the fault because Kong answers preflights before
GoTrue sees them. A platform that replaces Kong with Caddy inherits the job and
nothing does it, so the symptom appears only after cutover.

What it cost Bedtime, for eleven hours after its cutover:

  * supabase-js setSession() must GET /auth/v1/user to finish storing a
    session. Blocked, so setSession() failed and the session was discarded.
  * Login then fell back to a bare verify_pin, which checks the PIN but mints
    no session -- so the till ran on the public anon key.
  * A token refresh POSTs /auth/v1/token. Also blocked, so no session could
    ever be renewed. The database showed it plainly: 11 sessions, 11 refresh
    tokens, none ever used.

The visible result was a shop that looked empty rather than broken: reports at
GHS 0.00, no receipts, 487 denials on whatsapp_orders, and a cashier entering a
PIN 44 times because nothing ever stuck. Nothing was wrong with the data, the
session, GoTrue, or the row policies -- and because PostgREST answers an
RLS-denied SELECT with 200 and zero rows, almost nothing raised an error.

Idempotent: it refuses rather than guess if the block is not in the exact shape
provision-app.sh writes, and it never touches an app's rendered site file.
"""
import datetime
import pathlib
import shutil
import sys

TEMPLATE = pathlib.Path("/srv/central/compose/caddy-site.template")

OLD = "\thandle_path /auth/v1/* {\n\t\treverse_proxy __APP_DNS__-auth:9999\n\t}\n"

NEW = """\thandle_path /auth/v1/* {
\t\t# CORS PREFLIGHT -- load-bearing, not boilerplate.
\t\t#
\t\t# GoTrue (tested on v2.197.0) answers a preflight that names ANY
\t\t# request header -- authorization, apikey, even content-type -- with
\t\t# a bare 204 and no Access-Control-* headers, so the browser blocks
\t\t# the request that would have followed. A preflight naming no headers
\t\t# at all is answered correctly, which is what makes this easy to miss.
\t\t# Hosted Supabase never shows it, because Kong answers preflights
\t\t# before GoTrue sees them. This platform has no Kong, so Caddy must.
\t\t#
\t\t# What it cost Bedtime for eleven hours after cutover: supabase-js
\t\t# setSession() has to GET /auth/v1/user to finish storing a session,
\t\t# and a token refresh POSTs /auth/v1/token. Both were blocked, so the
\t\t# till fell back to the public anon key and read an empty shop --
\t\t# 487 denials on whatsapp_orders, reports showing GHS 0.00, and a
\t\t# cashier entering a PIN 44 times because nothing ever stuck. Nothing
\t\t# was wrong with the data, the session, or the row policies.
\t\t@cors_preflight method OPTIONS
\t\theader @cors_preflight {
\t\t\tAccess-Control-Allow-Origin "*"
\t\t\tAccess-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS"
\t\t\t# supabase-js sends apikey, Authorization and x-client-info. The
\t\t\t# rest match what PostgREST already allows on this same host, so
\t\t\t# the two gateways cannot disagree about one browser.
\t\t\tAccess-Control-Allow-Headers "Authorization, authorization, apikey, x-client-info, x-supabase-api-version, Content-Type, content-type, Accept, Accept-Language, Content-Language, X-Client-IP, X-JWT-AUD"
\t\t\tAccess-Control-Max-Age "86400"
\t\t\t# Deliberately no Allow-Credentials: paired with Allow-Origin "*"
\t\t\t# a browser rejects the response outright, and supabase-js sends no
\t\t\t# cookies -- it carries the token in a header.
\t\t}
\t\trespond @cors_preflight 204
\t\treverse_proxy __APP_DNS__-auth:9999
\t}
"""


def main() -> int:
    if not TEMPLATE.exists():
        print(f"  {TEMPLATE} is not here. Run this on the platform host.")
        return 2

    src = TEMPLATE.read_text()

    if "@cors_preflight" in src:
        print("  already patched; nothing to do")
        return 0

    if OLD not in src:
        print("  REFUSING: the /auth/v1 block is not in the exact expected shape.")
        print("  Nothing was written. Inspect the template by hand -- a partial")
        print("  edit here takes every tenant's sign-in down.")
        return 1

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = f"{TEMPLATE}.bak-cors-{stamp}"
    shutil.copy2(TEMPLATE, backup)
    TEMPLATE.write_text(src.replace(OLD, NEW, 1))

    print(f"  patched {TEMPLATE}")
    print(f"  backup  {backup}")
    print()
    print("  Nothing is live yet: each app's site file is rendered from this")
    print("  template, so re-render it, `caddy validate`, then restart Caddy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
