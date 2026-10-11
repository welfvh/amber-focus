# Amber Focus

DNS-level distraction blocking on this Mac. Repo: `~/dev/amber-focus/` (its `CLAUDE.md`
has the architecture). Server: `http://127.0.0.1:8053`, local non-browser clients only.

**When to grant** is a judgment call that follows the user's own focus rules (for example a
focus section in `~/.claude/CLAUDE.md`). This skill covers **how**.

Installed by `install-services.sh` as a link to `skill/amber-focus.md` in the repo. Edit it
there.

## Grant: one command

```bash
focus-grant <brand-or-domain> [minutes] [reason...]                 # default 10 min
focus-grant zalando 10 Deutschland Trikot for the WM                # bare brand → .de + .com
focus-grant reddit 10 --vigilant "reading the one rust-async thread"  # AI monitoring
```

`focus-grant` (script `~/dev/amber-focus/bin/focus-grant`; link it onto your PATH):
- expands a bare brand to `.de` + `.com`, grants each, verifies against OS truth
  (`/etc/hosts`), opens the site, and names the blocking layer on failure.
- Exit 2 = server or daemon down. Exit 3 = still blocked (the receipt says why).

Hard limits the server enforces (no need to pre-check):
- 1–60 minutes. For longer access, grant again when it runs out.
- No public suffixes or IPs (`co.uk`, `1.2.3.4`).
- A subdomain of a blocked parent is refused (`m.youtube.com` → grant `youtube.com`).
- Hard locks refuse the locked domain, its parents and its subdomains. No exceptions.

**Every grant is timed.** Never remove a domain from the blocklist (`DELETE /api/block/...`)
to give access. That is a permanent list edit, only when the user explicitly asks to take a
domain off the list.

## Before granting

1. Check the date and time (wind-down after 21:00; retreat hours if a retreat is active).
2. Active hard locks: `curl -s localhost:8053/api/locks`. An expired lock no longer applies.

## Vigilant mode

`--vigilant "<intent>"` runs the grant under AI monitoring of the granted site against the
intent. Use it for high-risk sites (social, video) with a narrow intent. Needs the Anthropic
key in Keychain (`cc/anthropic` / `api_key`). `focus-grant` reports whether monitoring
started; `curl -s localhost:8053/api/vigilant/status`.

## Still blocked after a grant

Read the truth, act on the named cause. Never toggle the shield to "refresh".
```bash
curl -s localhost:8053/api/check/youtube.com   # blocked (OS truth), source, desiredBlocked
curl -s localhost:8053/status                  # healthy, converged, lastError, tabSweep
curl -s -X POST localhost:8053/api/reconcile   # one pass now; 503 = daemon unreachable
```
- `source: "managed"` + `converged: false` → read `lastError`; the daemon retries every 10 s.
- `source: "legacy"` → the orphaned legacy hosts section:
  `sudo ~/dev/amber-focus/bin/prune-legacy-hosts-entry <domain>` (the user runs it, needs sudo).
- Daemon down → the user runs:
  `sudo launchctl enable system/com.amberfocus.daemon && sudo launchctl kickstart -k system/com.amberfocus.daemon`

## Other API calls

```bash
curl -s -X DELETE localhost:8053/api/grant/youtube.com      # end a grant now (closes its tabs)
curl -s localhost:8053/api/allowances                       # active grants
curl -s -X POST localhost:8053/api/block -H 'Content-Type: application/json' -d '{"domain":"example.com"}'
curl -s -X POST localhost:8053/api/lock -H 'Content-Type: application/json' -d '{"domain":"x.com","until":"2026-12-01"}'
```
Full API table: `~/dev/amber-focus/CLAUDE.md`.

## Tabs

Every 10 s the server closes open tabs on blocked domains (Chrome, Safari, Arc). A grant
reloads the domain's tabs; revoke and expiry close them. This needs macOS Automation
consent for `node` → each browser; `/status` → `tabSweep.lastError` shows a denial.

## Logs and deploy

```bash
tail -f ~/.config/amber-focus/server.log
sudo tail -f /var/log/amber-focus-daemon.log
cd ~/dev/amber-focus && npm run redeploy        # build, restart daemon then server (no sudo)
```
