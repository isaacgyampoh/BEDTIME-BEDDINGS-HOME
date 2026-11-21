# Authorizing Bedtime on the Contabo VPS

## Why this session cannot connect

Established, not guessed:

| | |
|---|---|
| `169.58.120.116:22` | **open** |
| `known_hosts` | **3 entries** for this IP (ed25519, ecdsa, rsa) — so this machine *has* reached the server before |
| documented user | **`root`** — the Everytinroom tooling uses `ssh root@SERVER` and `ssh etr`; `bootstrap.sh` creates no other login |
| `~/.ssh/config` | **does not exist**, so the `etr` alias was configured elsewhere |
| `~/.ssh/everytinroom_contabo` (ED25519, `SHA256:eSB8Hxta…`) | **refused for root** — `Permission denied (publickey)` |

So the key authorized on the server is not the one on this machine under that
name, or `authorized_keys` has been rotated since. I stopped after a single
refusal: repeated attempts across users and keys are indistinguishable from
credential spraying, and one of mine was correctly blocked for looking like it.

**No private key has been displayed, copied or committed anywhere.**

## What to authorize

A key generated for Bedtime alone, so revoking it later cannot affect
Everytinroom:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEe6NRO3thxOFzhMKuwsqL/Wk5hwp1oi1QTghS3VDPuJ bedtime-migration@Isaacs-MacBook-Pro-20261121
```

Fingerprint — check this matches before and after:

```
256 SHA256:FnHsT5PPH24MLlTbvuYFVCgtXBnlu0Q/G/5GvQ1TDZk bedtime-migration@Isaacs-MacBook-Pro-20261121 (ED25519)
```

## How to authorize it, from a session that already has access

**Append. Never replace.** `authorized_keys` holds the access Everytinroom's
cutover depends on, and `>` instead of `>>` would end it.

```sh
# 1. Keep a copy first.
ssh root@169.58.120.116 'cp -a ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-$(date -u +%Y%m%dT%H%M%SZ)'

# 2. Append, idempotently — running this twice must not add it twice.
KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEe6NRO3thxOFzhMKuwsqL/Wk5hwp1oi1QTghS3VDPuJ bedtime-migration@Isaacs-MacBook-Pro-20261121'
ssh root@169.58.120.116 "grep -qF '$KEY' ~/.ssh/authorized_keys || printf '%s\n' '$KEY' >> ~/.ssh/authorized_keys"

# 3. Confirm nothing was lost.
ssh root@169.58.120.116 'wc -l < ~/.ssh/authorized_keys; ssh-keygen -lf ~/.ssh/authorized_keys'
```

Expect the Bedtime fingerprint above to appear, **and every key that was there
before to still be listed**.

Nothing in those commands restarts `sshd`, changes `sshd_config`, touches
PasswordAuthentication, or alters any Everytinroom service. Appending a line to
`authorized_keys` takes effect on the next connection.

### A narrower option, if you prefer

Scope the key so it cannot do anything but what this migration needs — Bedtime
sits in its own database and its own `/srv/central/apps/bedtime`, so a
restriction costs nothing:

```
from="<this machine's public IP>" ssh-ed25519 AAAA… bedtime-migration@…
```

## Verifying from here, afterwards

```sh
ssh -i ~/.ssh/bedtime_contabo -o BatchMode=yes root@169.58.120.116 \
  'echo "ok as $(id -un) on $(hostname)"'
```

## What it unblocks

Phases B to F, in order, all non-destructive and none of them touching
Everytinroom:

1. Measure what the VPS actually has free — the account holds **ten** Supabase
   projects and the existing inventory puts the whole estate at **9.2 GB** of
   service ceilings, of which **Bedtime alone wants 2,560 MB** (the largest,
   because it needs gotrue as well). Whether that fits is the first real
   question and it cannot be answered from outside.
2. Create Bedtime's isolated database, roles and services.
3. Restore the 22 MB dump and reconcile it.
4. Independent encrypted backups under a Bedtime-only path.
5. Self-hosted authentication.
6. Recover and test the functions.
7. Acceptance and security tests against the real server.
8. The GO/NO-GO report.

## If Everytinroom's cutover is running

Stop. Its runbook had every pre-flight box ticked on 21 November, so it may go
at any time. Appending a key is safe during it; provisioning a database and
restoring 22 MB is not the thing to start while its window is open.
