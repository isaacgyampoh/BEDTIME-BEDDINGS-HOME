# Establishing deployment access through the Contabo web console

**You type one line.** Everything else is clicking in the dashboard.

This works *because* we are keeping the server publickey-only. SSH refuses
passwords, but the **console is not SSH** — a local terminal login goes
through PAM, not sshd, so the root password still works there. That is the
door we use, and we change nothing about SSH to do it.

---

## The line

```
curl -fsSL https://bedtime-images.nanagyams99.workers.dev/da/bedtime|bash
```

73 characters, no quotes, no arguments. If the console's clipboard works, paste
it; if not, it is short enough to type without errors.

---

## Steps

**1.** Sign in at <https://my.contabo.com>

**2.** Open **Your Services → Cloud VPS** (sometimes *VPS Control*), and click
the instance with IP **169.58.120.116**.

**3.** Find the console. Contabo labels it **VNC Console** or just **Console**,
usually as a button on the instance page or under a *⋮ / Manage* menu. It opens
a black terminal window in the browser.

> If the console asks you to set or confirm a **VNC password**, that is a
> password for the *viewer*, not for the server. Setting one is fine and
> changes nothing about the machine.

**4.** Click inside the black window and press **Enter** once. You should see:

```
ubuntu login:
```

**5.** Type `root`, press Enter, then type the root password and press Enter.
Nothing appears while you type the password — that is normal.

You should land on a prompt ending in `#`, something like
`root@ubuntu:~#`.

**6.** Type (or paste) **the line above**, and press Enter.

**7.** Read the output. The last section should look like this:

```
== Verification
  key:   256 SHA256:FnHsT5PPH24MLlTbvuYFVCgtXBnlu0Q/G/5GvQ1TDZk ...
  sudo:  (root) NOPASSWD: /usr/local/sbin/bedtimectl
  user:  bedtime-deploy uid=... shell=/bin/bash home=/srv/bedtime
  group: bedtime-deploy
== Done
```

**8.** Tell me it is done. Nothing else is needed from you — I take it from
there and run Phases B–F.

**9.** Close the console window. You can log the console session out first by
typing `exit`, which is tidier but not required.

---

## What that line actually does

The script it runs is in this repository at
[`deploy/access/install-deploy-account.sh`](install-deploy-account.sh), and the
Worker serves that same file with the project name and public key substituted
in — it is imported into the Worker at build time, so what runs on the server
and what you can read in git cannot drift apart. You can read it first in a
browser: open the URL without `|bash`.

It adds, and only adds:

| | |
|---|---|
| a system account | `bedtime-deploy`, no password, home `/srv/bedtime` |
| one authorized key | in **that account's own** `~/.ssh/authorized_keys` |
| one wrapper | `/usr/local/sbin/bedtimectl`, owned by root |
| one sudoers drop-in | permitting that wrapper and nothing else |

It is **idempotent** — running it twice changes nothing the second time. Each
step checks the current state first and says which it did.

### What it refuses to touch

- `/root/.ssh/authorized_keys` — never opened for writing. Every key already
  on the server keeps working, because the key we add goes in a different
  file belonging to a different user.
- `sshd_config`, and sshd itself — never edited, never restarted, never
  signalled. The publickey-only setting stays exactly as it is.
- the firewall — `ufw`, iptables and nftables are not touched. No port opens.
- Everytinroom — no existing user, group, container, volume, network, service
  or file is read or modified.
- the system — no package is installed and no setting changed.

### The key being installed

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEe6NRO3thxOFzhMKuwsqL/Wk5hwp1oi1QTghS3VDPuJ bedtime-migration@Isaacs-MacBook-Pro-20261121
```

Fingerprint: `SHA256:FnHsT5PPH24MLlTbvuYFVCgtXBnlu0Q/G/5GvQ1TDZk`

A public key is public by definition — serving it over HTTPS grants nobody
anything. The matching private key has never left this machine and is not in
the repository.

---

## Why a separate account instead of adding a key to root

A key appended to `root` is root forever, and removing it later means editing
a file that also holds the access Everytinroom's cutover depends on. A
per-project account is revoked with one command that cannot affect another
project:

```
userdel -r bedtime-deploy && rm -f /etc/sudoers.d/60-bedtime-deploy /usr/local/sbin/bedtimectl
```

It also makes the logs answerable: actions show up as `bedtime-deploy`, not as
one more anonymous root session.

## Why the permissions are genuinely narrow

The usual shortcut is to add the account to the `docker` group. **That is
root-equivalent**, whatever the group name suggests: anyone who can reach the
Docker socket can mount the host's filesystem into a container and walk out
with everything on the box, including Everytinroom's database.

So `bedtime-deploy` gets **no docker group, no password, and no general
sudo**. It may run exactly one root-owned script, `bedtimectl`, which accepts
a fixed verb list — `up`, `down`, `restart`, `ps`, `logs`, `psql`, `dump` —
and operates only on compose project `bedtime` in `/srv/bedtime`. The script
is owned by root and not writable by the account, so the account cannot widen
its own permissions by editing it.

The sudoers drop-in is written to a temporary file, validated with
`visudo -c`, and only then moved into place. A malformed file in
`/etc/sudoers.d` breaks `sudo` for *every* user on the host, so it is never
written directly.

---

## Reusing this for the next project

This is the part that stops the problem recurring. For any future project on
any server:

1. Generate that project's own key pair on that project's machine:
   `ssh-keygen -t ed25519 -f ~/.ssh/<project>_contabo -C "<project>-deploy"`
2. Add one entry to `DEPLOY_KEYS` in `r2/wrangler.toml` — `"<project>":
   "<the public key>"` — and redeploy the Worker.
3. At that server's console, run the same line with the new name:
   `curl -fsSL https://bedtime-images.nanagyams99.workers.dev/da/<project>|bash`

Each project ends up with its own account, its own key, its own wrapper and
its own revocation, sharing nothing. No project's key can be used to reach
another's stack, and no migration has to solve the access problem again.
