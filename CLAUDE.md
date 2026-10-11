# amber-focus

Multi-layer macOS distraction blocker. The **server** (user-space, `127.0.0.1:8053`) edits
the desired state in `config.json`. The **daemon** (root, Unix socket) owns convergence: it
reads `config.json` itself and reconciles `/etc/hosts` and pf to it every 10 s, on every
file change, and on request. Grants and expiries therefore apply even when the server is
down. The server asks for a pass after each change and reports OS truth (read from
`/etc/hosts`), never its own store alone.

Three layers:

1. **Network** — `/etc/hosts` managed section + pf firewall + DNS flush (daemon, root).
2. **Tabs** — every 10 s the server closes any open tab on an effectively blocked domain,
   even one that loaded via DoH or a cached IP. It reloads a granted domain's tabs, and
   closes them again on revoke or expiry (server, as the user, via JXA).
3. **Apps** — retreat mode: the Swift `retreat-enforcer` quits apps outside an allowlist
   during scheduled windows.

## Architecture

```
focus-grant / curl ──> Server (:8053, user) ──"reconcile now"──> Daemon (root)
                         │                                         │ 10 s timer, file watch, RPC
                       store.ts ──writes──> config.json ──reads──────┤
                         │                      │                  ├─ /etc/hosts managed section
                       browser.ts (JXA)         │                  ├─ pf (static + dynamic anchors)
                       tab sweep, reload,       │                  ├─ DNS flush, Chromium DNS flush
                       vigilant tab reads       │                  └─ newly blocked: pf enforce + kill
                                                └─reads─> retreat-enforcer (user LaunchAgent)
```

**Trust boundary.** The daemon runs as root and trusts nothing it reads: config entries
that are not plain hostnames (`isValidHostname`) never reach `/etc/hosts` or pf, and an
invalid allowance opens nothing. It finds `config.json` itself (`--config`,
`AMBER_FOCUS_CONFIG`, or the console user's `~/.config/amber-focus/config.json`); no RPC
can change that path. Root never drives a browser.

**Local clients only.** The server binds to `127.0.0.1`, refuses any `Host` other than the
loopback address (DNS rebinding), and refuses every request that carries an `Origin`
header — so no web page can call it. There is no CORS, no MCP endpoint and no tunnel.

**Desired state → reconcile.** Every mutation only edits `config.json`, then asks the
daemon for a pass. The pass is idempotent: it renders the managed hosts section, writes it
only when it differs, refreshes pf on change, and derives side effects from the diff
between the base domains recorded in the previous section (`# Domains:` line) and the new
ones. If `config.json` is unreadable, the pass stops and the OS keeps its blocks (fail
closed); `lastError` says why.

**Truth, not intent.** `GET /api/check/:domain` returns `blocked` (what `/etc/hosts`
enforces now, with `source`: `managed` / `legacy` / `other`) next to `desiredBlocked`.
`focus-grant` verifies against `blocked`.

## Key Files

| Path | Responsibility |
|------|----------------|
| `src/server.ts` | REST API, expiry loop (30 s), daemon watchdog (30 s), tab sweep (10 s). Never dies on daemon errors |
| `src/guard.ts` | Request guard: loopback `Host` only, no `Origin` |
| `src/policy.ts` | Input policy: `parseDomain` (hostname at or below a registrable domain, via `tldts`), grant minutes (1–60), text fields |
| `src/actions.ts` | `grant` / `revoke` (the one path for both), `applyDesiredState`, OS truth (`osBlockState`, `describeDomain`), vigilant hooks |
| `src/browser.ts` | List, close, reload tabs in Chrome, Safari, Arc via JXA. Data goes in as a JSON argument, never into script source |
| `src/notify.ts` | macOS notification banner (JXA, arguments only) |
| `src/store.ts` | `config.json`: `shieldActive`, blocklist, allowances, hard lockouts, retreat. Atomic writes; unknown keys kept; a corrupt file is copied aside before defaults load |
| `src/vigilant.ts` | Vigilant mode (see below) |
| `src/daemon-client.ts` | JSON-RPC client: `reconcile`, `status`, `flush_dns`, `restart`. Returns null when the daemon is unreachable |
| `src/daemon/index.ts` | Daemon entry: config path discovery, reconcile loop, RPC handlers |
| `src/daemon/reconciler.ts` | The convergence pass. Serialized; every caller gets a fresh pass |
| `src/shared/reconcile.ts` | Pure core: effective blocklist, hosts section render/parse/diff, hosts truth index |
| `src/shared/domains.ts` | `isValidHostname`, normalization, matching, variant expansion |
| `src/daemon/pf.ts` | pf anchors: static IP ranges + resolved IPs of priority domains |
| `src/daemon/browser.ts` | Chromium DNS cache flush (kills the network service; the browser respawns it) |
| `app/retreat-enforcer.swift` | Retreat mode app enforcer (user LaunchAgent) |
| `bin/focus-grant` | The one command for timed grants: expand brand → TLDs, grant, verify OS truth, open the site |
| `install.sh` | One-line installer: prerequisites, clone, then `install-services.sh` |
| `install-services.sh` | Build, choose categories (first install), install daemon + server services |

## API

All on `http://127.0.0.1:8053`, local non-browser clients only (see above).

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/status` | Shield, daemon truth (`daemonRunning`, `converged`, `healthy`, `lastError`, `legacyBlockedAllowed`), allowances, vigilant and tab-sweep health |
| GET | `/api/blocked` | Blocklist |
| POST | `/api/block` | Add a domain. Body `{"domain"}`. Closes its tabs |
| DELETE | `/api/block/:domain` | Remove a domain. Refused while hard-locked |
| GET | `/api/check/:domain` | `blocked` (OS truth) + `source`, `desiredBlocked`, `onBlocklist`, `allowanceMinutes`, `locked` |
| POST | `/api/grant` | Timed access. Body `{"domain","minutes"(1–60),"reason","vigilant?","intent?"}`. Refuses public suffixes and anything a hard lock touches (the domain, a parent, or a locked subdomain) |
| DELETE | `/api/grant/:domain` | End a grant now; closes its tabs |
| GET | `/api/allowances` | Active grants |
| POST | `/api/shield/enable` | Shield on |
| POST | `/api/shield/disable` | Shield off. Refused while any hard lock is active |
| POST | `/api/reconcile` | One reconcile pass now. 503 when the daemon is unreachable |
| GET/POST/DELETE | `/api/retreat` | Retreat config. POST body `{"endDate":"YYYY-MM-DD","windows":[{"start":960,"end":1080}],"allowlist":["bundle.id"],"blocklist"?:[...]}` (minutes from midnight; `end < start` wraps midnight). POST replaces the whole config |
| POST | `/api/flush-dns` | Flush the system DNS cache via the daemon |
| GET | `/api/vigilant/status`, `/api/vigilant/log?count=N` | Vigilant sessions and evaluations |
| GET | `/api/locks` | Active hard lockouts |
| POST | `/api/lock` | Add a hard lockout. Body `{"domain","until"}` (future ISO date). There is no remove endpoint: a lock holds until it expires |

## Grants

A grant stores an allowance, asks the daemon for a pass (which drops the domain from hosts
and pf and flushes the Chromium DNS cache), then reloads the domain's tabs. **Expiry**
needs no server: the daemon's own pass sees `expiresAt` in the past and re-blocks. The
server's 30 s loop prunes the allowance, stops vigilant monitoring, and closes the tabs.

Policy lives in two places: the code enforces hard limits (1–60 min, valid sites, hard
locks, shield-off refused under a lock). When to grant at all is the agent's judgment, in
the `/amber-focus` skill and the cc-focus rules of the global CLAUDE.md.

## Daemon IPC

JSON-RPC 2.0 over `/tmp/amberfocus.sock` (mode 0666), newline-delimited. 15 s timeout
(45 s for `reconcile`).

| Method | Params | Effect |
|--------|--------|--------|
| `reconcile` | `{reason?}` | Run one pass, return the daemon status |
| `status` | — | pid, uptime, `converged`, `lastReconcileAt`, `lastError`, `configPath`, `legacyBlockedAllowed` |
| `flush_dns` | — | Flush the macOS DNS cache |
| `restart` | — | Self-exit; launchd respawns from the bundle on disk (sudo-free redeploy) |

New RPC methods: add the Zod params schema to `DAEMON_METHODS` in
`src/shared/ipc-types.ts` and register the handler in `src/daemon/index.ts`.

## Debug

```bash
curl -s localhost:8053/status | jq
curl -s localhost:8053/api/check/youtube.com | jq
tail -f ~/.config/amber-focus/server.log          # timestamped
sudo tail -f /var/log/amber-focus-daemon.log
sudo pfctl -a com.welf.amberfocus -sr; sudo pfctl -a com.welf.amberfocus.dynamic -sr
launchctl print gui/$(id -u)/com.amberfocus.retreat-enforcer
npm test                                          # vitest
npm run redeploy                                  # build, restart server + daemon (no sudo)
```

## Known Issues

- **Automation consent.** The tab sweep and vigilant mode need macOS Automation access for
  `node` → Chrome/Safari/Arc. macOS asks once; until allowed, `/status` shows
  `tabSweep.lastError`. A Homebrew node upgrade may ask again.
- **Root runs user-owned files.** The LaunchDaemon runs `/opt/homebrew/bin/node` on
  `~/dev/amber-focus/daemon/daemon.cjs`, both writable by the user. Any process running as
  the user can therefore become root. The fix is a root-owned install, planned together
  with the Network Extension filter that replaces hosts + pf.
- **Enforcement gaps.** `/etc/hosts` and pf miss IPv6 for most sites, rotating CDN IPs, and
  apps with their own resolver. The tab sweep covers browsers only. A Network Extension
  content filter closes these; see `research/ne-filter-deep-dive.md`.
- **Legacy hosts section.** `/etc/hosts` still carries an orphaned
  `# BEGIN FOCUS SHIELD BLOCK` section (2026-02-21, ~124k domains) that no code rewrites.
  It overrides grants for the domains it lists; the daemon reports them in
  `legacyBlockedAllowed`, and `bin/prune-legacy-hosts-entry <domain>` removes one.
- **launchd "disabled" flag.** A reboot with the daemon marked disabled leaves it unloaded.
  Fix: `sudo launchctl enable system/com.amberfocus.daemon`, then kickstart.
- **pf must be enabled once:** `sudo ./enable-pf.sh`. pf rules use `block return` (fast
  RST) and also block UDP 443 (QUIC).

## Vigilant Mode

A grant with `vigilant: true` and an `intent` runs under AI monitoring.
Implementation: `src/vigilant.ts`. API key: Keychain `cc/anthropic` / `api_key`.

## Runtime Files

| Path | Purpose |
|------|---------|
| `~/.config/amber-focus/config.json` | All state |
| `~/.config/amber-focus/server.log` | Server log |
| `~/.config/amber-focus/vigilant-log.json` | Vigilant evaluations |
| `/var/log/amber-focus-daemon.log` | Daemon log |
| `/tmp/amberfocus.sock` | Server ↔ daemon IPC |
