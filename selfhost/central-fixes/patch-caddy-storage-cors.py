#!/usr/bin/env python3
"""
Make the gateway answer CORS preflights for /storage/v1/* too.

    python3 -I patch-caddy-storage-cors.py       # patches the site template
    # then re-render each app's site file and restart Caddy, as for the
    # /auth/v1 fix in patch-caddy-auth-cors.py

THE SAME GAP, A DIFFERENT PREFIX

Hosted Supabase puts Kong in front of every service, and Kong answers CORS
preflights. A platform that replaces Kong with Caddy inherits that job for
EVERY prefix, not just the one that broke first. `/auth/v1` was fixed when
sign-in failed; `/storage/v1` was missed because nothing had uploaded a file
yet, and storage-api does not answer a preflight either.

It surfaced weeks later, when a staff member changed a product photo:

    Upload failed: Failed to fetch

which names neither the preflight nor the endpoint. The upload helper tries
the R2 Worker first and falls back to Supabase Storage; both were broken at
once, for unrelated reasons, so the fallback hid nothing.

sb.storage.from(...).upload() sends apikey, authorization, x-client-info,
cache-control and x-upsert. Every one of them must appear in
Access-Control-Allow-Headers or the browser refuses to send the request at
all -- a preflight naming no headers is answered correctly, which is what
makes this easy to miss from the outside.

WORTH CHECKING THE OTHER PREFIXES AFTER ANY MIGRATION

    for p in /auth/v1/user /rest/v1/ /storage/v1/object/x /functions/v1/x; do
      printf '%-28s ' "$p"
      curl -sD- -o/dev/null -X OPTIONS "$API$p" \
        -H 'Origin: https://admin.example.com' \
        -H 'Access-Control-Request-Method: POST' \
        -H 'Access-Control-Request-Headers: authorization,apikey' \
        | grep -ci access-control-allow-origin
    done

A zero on any line is a prefix the browser cannot use.

Idempotent: it looks for the marker inside the storage block specifically,
because `@cors_preflight` already exists elsewhere in the file once the auth
fix is applied -- checking the whole file reports "already patched" when it
is not.
"""
import datetime
import pathlib
import shutil
import sys

TEMPLATE = pathlib.Path("/srv/central/compose/caddy-site.template")

OLD = """\thandle_path /storage/v1/* {
\t\treverse_proxy __APP_DNS__-storage:5000 {
\t\t\t# storage-api builds public URLs from the forwarded path.
\t\t\theader_up X-Forwarded-Path /storage/v1
\t\t}
\t}
"""

NEW = """\thandle_path /storage/v1/* {
\t\t# Same CORS preflight gap as /auth/v1 above: storage-api does not answer
\t\t# one, so an upload from the browser dies before it is ever sent. Hosted
\t\t# Supabase has Kong in front; this platform does not.
\t\t#
\t\t# It surfaced as "Upload failed: Failed to fetch" when a staff member
\t\t# changed a product photo -- a message naming neither the preflight nor
\t\t# the endpoint. sb.storage.upload() sends apikey, authorization,
\t\t# x-client-info, cache-control and x-upsert, so every one has to be
\t\t# allowed or the browser refuses to make the request at all.
\t\t@cors_preflight method OPTIONS
\t\theader @cors_preflight {
\t\t\tAccess-Control-Allow-Origin "*"
\t\t\tAccess-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS"
\t\t\tAccess-Control-Allow-Headers "Authorization, authorization, apikey, x-client-info, x-upsert, cache-control, Cache-Control, Content-Type, content-type, Accept, x-supabase-api-version"
\t\t\tAccess-Control-Max-Age "86400"
\t\t}
\t\trespond @cors_preflight 204
\t\treverse_proxy __APP_DNS__-storage:5000 {
\t\t\t# storage-api builds public URLs from the forwarded path.
\t\t\theader_up X-Forwarded-Path /storage/v1
\t\t}
\t}
"""


def main() -> int:
    if not TEMPLATE.exists():
        print(f"  {TEMPLATE} is not here. Run this on the platform host.")
        return 2

    src = TEMPLATE.read_text()

    idx = src.find("handle_path /storage/v1/*")
    if idx == -1:
        print("  REFUSING: no /storage/v1 block in the template.")
        return 1

    # Only inside the storage block -- the auth fix put the same marker above.
    if "@cors_preflight" in src[idx:idx + 1400]:
        print("  already patched; nothing to do")
        return 0

    if OLD not in src:
        print("  REFUSING: the /storage/v1 block is not in the exact expected")
        print("  shape. Nothing was written -- a partial edit here takes every")
        print("  tenant's uploads down.")
        return 1

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = f"{TEMPLATE}.bak-storagecors-{stamp}"
    shutil.copy2(TEMPLATE, backup)
    TEMPLATE.write_text(src.replace(OLD, NEW, 1))

    print(f"  patched {TEMPLATE}")
    print(f"  backup  {backup}")
    print()
    print("  Nothing is live yet: re-render each app's site file from this")
    print("  template, `caddy validate`, then restart Caddy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
