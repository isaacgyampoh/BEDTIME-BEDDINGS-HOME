# Bedtime pre-VPS acceptance — 20261111T083851Z

Produced by migration-package/after-credential.sh. Every line below is
a check that ran; evidence in /Users/isaacgyampoh/bedtime-preservation/evidence-20261111T083851Z.

## FULLY PRE-VPS READY

Complete privileged backup taken, all 21 tables including the five
RLS-protected ones, restored into an isolated database and reconciled
against the dump's own snapshot. Staff rows and bcrypt PIN hashes
verified by shape, never by value. PIN authentication and the critical
POS operations executed against the restore. All six Edge Functions
executed. Backup and evidence preserved outside git. Git bundle
verified by reconstruction.

Remaining work is VPS-dependent only: server provisioning, final
synchronisation, live-server acceptance and authorised cutover.
