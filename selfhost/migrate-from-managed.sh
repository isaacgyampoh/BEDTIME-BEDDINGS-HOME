#!/usr/bin/env bash
# Move the shop's database from the managed Supabase project to the self-hosted
# one, without touching the source.
#
#   export SOURCE_DB_URL='postgres://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres'
#   export TARGET_DB_URL='postgres://postgres:<pw>@127.0.0.1:5432/postgres'
#   ./selfhost/migrate-from-managed.sh
#
# Get SOURCE_DB_URL from the managed project's dashboard, Settings > Database.
# Reach TARGET_DB_URL over an SSH tunnel, because the self-hosted database is
# not published to the internet:
#   ssh -L 5432:localhost:5432 bedtime@<server>
#
# Nothing is written to the source. The dump is kept, so a failed restore can
# be retried without going back to the source again.
set -euo pipefail

: "${SOURCE_DB_URL:?set SOURCE_DB_URL}"
: "${TARGET_DB_URL:?set TARGET_DB_URL}"
OUT="${OUT_DIR:-./migration-$(date +%Y%m%d-%H%M%S)}"
NEW_BASE="${NEW_SUPABASE_URL:-https://api.bedtimehome.com}"
OLD_BASE="https://wqkgfvmvuljzexhevlnp.supabase.co"

say () { printf '\n\033[1m== %s\033[0m\n' "$*"; }
mkdir -p "$OUT"
# Nothing here prints a connection string; psql reads them from the environment.

say "1. What is in the source, before anything is touched"
psql "$SOURCE_DB_URL" -At -v ON_ERROR_STOP=1 > "$OUT/source-counts.txt" <<'SQL'
SELECT 'products '        || count(*) FROM products;
SELECT 'sales '           || count(*) FROM sales;
SELECT 'customers '       || count(*) FROM customers;
SELECT 'whatsapp_orders ' || count(*) FROM whatsapp_orders;
SELECT 'expenses '        || count(*) FROM expenses;
SELECT 'staff '           || count(*) FROM staff;
SELECT 'promos '          || count(*) FROM promos;
SELECT 'bundles '         || count(*) FROM bundles;
SQL
sed 's/^/   /' "$OUT/source-counts.txt"

say "2. Dump it"
# --no-owner/--no-privileges because the roles differ between a managed project
# and a self-hosted one; the GRANTs come back with the migrations.
pg_dump "$SOURCE_DB_URL" \
  --schema=public --no-owner --no-privileges --clean --if-exists \
  --exclude-schema='supabase_*' --exclude-schema=graphql\* \
  -f "$OUT/public.sql"
echo "   $(wc -l < "$OUT/public.sql") lines, $(du -h "$OUT/public.sql" | cut -f1)"

say "3. Rewrite the URLs that are baked into the data"
# Two of them, both found by auditing the repository:
#
#   * 14 scheduled jobs call the Edge Functions by absolute URL, so after the
#     move they would keep calling the OLD project: the daily SMS report and
#     the mobile-money reconciler would run against a server we no longer use.
#
#   * every product photo is stored as an absolute URL in products.image, so
#     680 rows would still point at the old project's Storage. The files have
#     to be copied separately (step 5) and these rows repointed.
before=$(grep -c "$OLD_BASE" "$OUT/public.sql" || true)
sed -i.bak "s|$OLD_BASE|$NEW_BASE|g" "$OUT/public.sql"
after=$(grep -c "$OLD_BASE" "$OUT/public.sql" || true)
echo "   $before references to the old project rewritten to $NEW_BASE ($after left)"
[ "$after" -eq 0 ] || { echo "   REFUSING: some references did not rewrite"; exit 1; }

say "4. Restore into the self-hosted database"
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -q -f "$OUT/public.sql" 2>&1 | tail -5 || {
  echo "   restore failed — the dump is kept at $OUT/public.sql"; exit 1; }

psql "$TARGET_DB_URL" -At -v ON_ERROR_STOP=1 > "$OUT/target-counts.txt" <<'SQL'
SELECT 'products '        || count(*) FROM products;
SELECT 'sales '           || count(*) FROM sales;
SELECT 'customers '       || count(*) FROM customers;
SELECT 'whatsapp_orders ' || count(*) FROM whatsapp_orders;
SELECT 'expenses '        || count(*) FROM expenses;
SELECT 'staff '           || count(*) FROM staff;
SELECT 'promos '          || count(*) FROM promos;
SELECT 'bundles '         || count(*) FROM bundles;
SQL

say "5. Did every row arrive?"
if diff -u "$OUT/source-counts.txt" "$OUT/target-counts.txt" > "$OUT/count-diff.txt"; then
  sed 's/^/   /' "$OUT/target-counts.txt"
  echo "   every table matches the source"
else
  echo "   COUNTS DIFFER — do not cut over:"
  sed 's/^/   /' "$OUT/count-diff.txt"
  exit 1
fi

say "6. Does it actually work?"
psql "$TARGET_DB_URL" -At -v ON_ERROR_STOP=1 <<'SQL' | sed 's/^/   /'
SELECT 'functions     ' || count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';
SELECT 'RLS policies  ' || count(*) FROM pg_policies WHERE schemaname='public';
SELECT 'scheduled jobs' || ' ' || count(*) FROM cron.job;
SELECT 'jobs still pointing at the old project ' || count(*) FROM cron.job WHERE command LIKE '%wqkgfvmvuljzexhevlnp%';
SELECT 'product photos still pointing at the old project ' || count(*) FROM products WHERE image LIKE '%wqkgfvmvuljzexhevlnp%';
SQL

say "Done"
cat <<NEXT
  The dump and the before/after counts are in $OUT — keep them until the
  cutover is accepted.

  The database is migrated. The PHOTOS ARE NOT: products.image now points at
  $NEW_BASE, but the files themselves are still in the old
  project's Storage. Copy them before cutting over — selfhost/README.md,
  "Moving the photos".
NEXT
