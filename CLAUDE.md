# amber-focus

Multi-layer macOS distraction blocker. The **server** (user-space, port 8053) edits the
desired state in `config.json`. The **daemon** (root, Unix socket) owns convergence: it
reads `config.json` itself and reconciles `/etc/hosts` and pf to it every 10 s, on every
file change, and on request. Grants and expiries therefore apply even when the server is
down or crashed. The server asks for a pass after each change and reports OS truth (read
from `/etc/hosts`), never its own store alone. An optional **MITM proxy** (port 8080) adds
path-level blocking and progressive delay friction.

The blocker operates on **three layers** that together close all known DNS-bypass gaps
(browser DoH, internal DNS caches, IP-cache resurfacing):

1. **Network layer** — `/etc/hosts` rewrite + pf firewall + DNS flush. Blocks at the OS resolver.
2. **Tab layer** — periodic browser tab sweep (every 10s). Closes any open tab whose URL matches the blocklist, even when the tab loaded via DoH.
3. **App layer** — retreat mode: Swift `NSWorkspace` launch observer + 5s sweep. Allowlist mode kills any app not allowlisted; blocklist mode (when `retreat.blocklist` is non-empty) kills only the listed bundle IDs. Active during scheduled windows.

## Architecture

```
Claude ──MCP──> Server (:8053) ──"reconcile now"──> Daemon (root)
                  │                                    │ Reconciler loop
                store.ts ──writes──> config.json ──reads─┤ (10s timer, file watch, RPC)
                  │                                    │
                REST API ──reads /etc/hosts──          ├─ /etc/hosts managed section
              (OS truth in /api/check, /status)        ├─ pf firewall (static + dynamic)
                  │                                    ├─ DNS cache flush
              [Proxy :8080]                            ├─ newly blocked: pf enforce, kill, close tabs
             (optional MITM)                           ├─ newly allowed: browser DNS flush, reload tabs
                  │                                    └─ tab sweep (every pass)
                  └─reads─> retreat-enforcer (user LaunchAgent)
                            NSWorkspace observer + 5s app sweep
                            → forceTerminate non-allowlisted apps
```

**Desired state → reconcile.** Every mutation (grant, revoke, block, unblock, shield
on/off, expiry) only edits `config.json`, then asks the daemon for a pass. The pass is
idempotent: it renders the managed hosts section, writes it only when it differs, refreshes
pf on change, and derives side effects from the diff between the base domains recorded in
the previous section (`# Domains:` line) and the new ones. A daemon restart loses nothing:
the previous state is read back from `/etc/hosts` itself. If `config.json` is unreadable,
the pass stops and the OS keeps its blocks (fail closed); `lastError` says why.

**Truth, not intent.** `GET /api/check/:domain` returns `blocked` (what `/etc/hosts`
enforces right now, with `source`: `managed` / `legacy` / `other`) next to
`desiredBlocked` (the store). `/status` exposes `daemonRunning`, `converged`, `healthy`,
`lastError`, and `legacyBlockedAllowed` (allowed domains the orphaned legacy section still
blocks). `focus-grant` verifies against `blocked`, never `desiredBlocked`.

**Daemon down.** The server cannot start the root daemon. It keeps accepting edits, reports
`daemonRunning: false` / `applied: false` on every response, and posts a macOS
notification with the fix command after two failed watchdog checks (10 min cooldown).

## Key Files

| Path | Responsibility |
|------|----------------|
| `src/server.ts` | Express HTTP on 127.0.0.1:8053. REST API, MCP mount, allowance expiry loop (30s), daemon watchdog (30s). Never dies on daemon errors (global handlers + async route wrapper) |
| `src/actions.ts` | `applyDesiredState` (ask the daemon to converge, never throws), `describeDomain` / `osBlockState` (truth from `/etc/hosts`), vigilant start/resume |
| `app/retreat-enforcer.swift` | User-space Swift binary. NSWorkspace launch observer + 5s sweep. Reads `retreat` config from `config.json` directly; kills non-allowlisted apps when current time falls inside a configured window and `endDate` hasn't passed |
| `src/store.ts` | All persistent state: `shieldActive`, blocked domains, allowances (with optional `vigilantIntent`), delays, hard lockouts, categories. Atomic writes to `~/.config/amber-focus/config.json` |
| `src/mcp.ts` | MCP server (Streamable HTTP transport, session management). 8 tools for Claude. Bearer token auth |
| `src/daemon-client.ts` | Typed JSON-RPC 2.0 client over Unix socket: `reconcile`, `status`, `flush_dns`, `restart`. Returns null when the daemon is unreachable |
| `src/vigilant.ts` | Vigilant mode: screenshot capture, Anthropic API evaluation, auto-revoke on drift |
| `src/proxy.ts` | Optional MITM HTTPS proxy for path-level blocking and delay friction |
| `src/daemon/index.ts` | Daemon entry: config path discovery (`--config`, env, persisted announcement), reconcile loop (10s + file watch), RPC handlers, graceful shutdown |
| `src/daemon/reconciler.ts` | The convergence pass: config.json → desired state → hosts section, pf, diff side effects, verification. Serialized; every caller gets a fresh pass |
| `src/shared/reconcile.ts` | Pure core shared by daemon and server: effective blocklist, hosts section render/parse/diff, `hostsBlocks` truth lookup. Unit-tested |
| `src/daemon/pf.ts` | pf firewall: static anchor (hardcoded IP ranges) + dynamic anchor (resolved IPs) |
| `src/daemon/browser.ts` | Close or reload browser tabs by hostname match via AppleScript (Safari, Arc, Chrome); Chromium DNS cache flush |
| `src/daemon/dns.ts` | DNS resolution via `dns.Resolver` (8.8.8.8) + system DNS cache flush |
| `src/daemon/queue.ts` | Serial async queue to prevent concurrent pfctl calls |
| `src/daemon/rpc.ts` | JSON-RPC 2.0 dispatcher; validates params against `DAEMON_METHODS` in ipc-types.ts |
| `src/daemon/system.ts` | Shell exec wrappers (`SystemOperations` interface) for privileged ops |
| `src/shared/ipc-types.ts` | JSON-RPC type definitions and Zod schemas for all daemon methods |
| `src/shared/domains.ts` | Domain normalization, matching, www/subdomain variant expansion |
| `install.sh` | Interactive installer: npm build, category selection, LaunchDaemon + LaunchAgent |
| `uninstall.sh` | Remove services, hosts entries, pf rules. Preserves config by default |
| `enable-pf.sh` | Enable IP-level blocking via pf for Twitter/X, Meta, TikTok, Netflix |

## MCP Tools

Defined in `src/mcp.ts`. Endpoint: `/mcp` on port 8053. Auth: Bearer token from `~/.config/amber-focus/mcp-token` (header or `?token=` query param).

| Tool | Description |
|------|-------------|
| `amber_status` | Shield active state, daemon health, blocked count, active allowances, hard lockouts |
| `amber_blocked_list` | List all domains on the blocklist |
| `amber_check_domain` | Check if a domain is blocked, has an allowance, or is hard-locked |
| `amber_allowances` | List all active time-limited access grants with expiry times |
| `amber_delayed_list` | List domains with delay friction (progressive wait times) |
| `amber_grant` | Grant time-limited access (1-30 min, auto-expires). Optional vigilant mode. Refuses hard-locked domains |
| `amber_block` | Add domain to blocklist. Immediately enforces via DNS + pf + connection kill + tab close |
| `amber_unblock` | Permanently remove domain from blocklist. Refuses hard-locked domains |
| `amber_vigilant_status` | Check current vigilant monitoring session, evaluation counts, and recent log |

The `amber_grant` tool description includes behavioral instructions for Claude (challenge the user, ask for specific intent before granting). See `mcp.ts` for full prompt text.

## API Endpoints

All on `http://127.0.0.1:8053`. No auth for local access.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/status` | Desired shield state plus daemon truth: `daemonRunning`, `converged`, `healthy`, `lastReconcileAt`, `lastError`, `legacyBlockedAllowed`, allowances, vigilant health |
| GET | `/api/filter-state` | Full blocked domain list + version counter (for NE extension polling) |
| GET | `/api/blocked` | List all blocked domains |
| POST | `/api/block` | Add domain. Body: `{"domain": "..."}` |
| DELETE | `/api/block/:domain` | Remove domain. Refuses hard-locked |
| GET | `/api/check/:domain` | `blocked` = OS truth from /etc/hosts (+ `source`), `desiredBlocked` = store, `onBlocklist`, `allowanceMinutes`, `locked`, `daemonRunning`, `converged` |
| POST | `/api/grant` | Grant timed access. Body: `{"domain","minutes","reason","vigilant?","intent?"}`. Response carries `applied`, `daemonRunning`, `effective` (OS truth), `vigilant` |
| DELETE | `/api/grant/:domain` | Revoke allowance immediately (aggressive re-block) |
| GET | `/api/allowances` | List active allowances |
| POST | `/api/shield/enable` | Enable shield (apply all blocking) |
| POST | `/api/shield/disable` | Disable shield (remove all blocking) |
| POST | `/api/reconcile` | Run one reconcile pass now. Idempotent. 503 when the daemon is unreachable |
| GET | `/api/delayed` | List delayed domains |
| POST | `/api/delay` | Add to delay list. Body: `{"domain": "..."}` |
| DELETE | `/api/delay/:domain` | Remove from delay list |
| GET | `/api/check-delay/:domain` | Delay status and current wait time |
| POST | `/api/delay-complete` | Record delay wait completed. Body: `{"domain": "..."}` |
| GET | `/api/paths` | List blocked paths |
| POST | `/api/path` | Add blocked path. Body: `{"domain","path"}` |
| DELETE | `/api/path` | Remove blocked path. Body: `{"domain","path"}` |
| GET | `/api/locks` | List active hard lockouts |
| POST | `/api/lock` | Add hard lockout. Body: `{"domain","until"}` (ISO date) |
| DELETE | `/api/lock/:domain` | Remove hard lockout |
| GET | `/api/retreat` | Get retreat config (windows, allowlist, endDate, enabled) |
| POST | `/api/retreat` | Enable retreat. Body: `{"endDate":"YYYY-MM-DD","windows":[{"start":960,"end":1080}],"allowlist":["bundle.id"]}`. `start`/`end` are minutes from midnight; if `end < start`, window wraps midnight |
| DELETE | `/api/retreat` | Disable retreat (allowlist preserved) |
| POST | `/api/flush-dns` | Flush system DNS cache via daemon |
| GET | `/api/proxy/ca` | CA cert path for proxy setup |
| GET | `/api/vigilant/status` | Current vigilant monitoring session status |
| GET | `/api/vigilant/log` | Recent vigilant evaluations (query: `?count=N`) |

## How Blocking Works

**Block:** domain added to `config.json` -> server sends `reconcile` -> the daemon's pass renders the managed hosts section (0.0.0.0 + :: for domain, www, and known variants), writes it if it differs, refreshes pf (static IP ranges + dynamic resolved IPs), flushes DNS. The diff against the previous section marks the domain as newly blocked: resolve IPs to pf, kill TCP connections (`pfctl -k`), close its tabs.

**Grant (timed access):** server checks hard lockouts (refuses if locked) -> stores the allowance -> `reconcile`. The pass computes effective = blocklist minus active allowances (subdomains included), drops the domain from hosts and pf, flushes the Chromium DNS cache, and **reloads** the domain's tabs (never closes them). **Expiry** needs no server: the daemon's own 10 s pass sees `expiresAt` in the past and re-blocks with full enforcement. The server's 30 s loop only prunes expired allowances from the file, stops vigilant sessions, and requests a pass so the change is immediate.

**Hard lockout:** immutable until date. `DELETE /api/block/:domain`, `POST /api/grant`, and `amber_unblock` all refuse. Currently active: Twitter/X + YouTube locked until March 1, 2026.

**Tab sweep (closes the DoH gap):** every pass (10 s) the daemon runs one AppleScript per browser (Safari, Arc, Chrome) that walks every window/tab and closes any whose **hostname** equals or is a subdomain of an effectively blocked domain. This catches tabs that loaded via DNS-over-HTTPS or otherwise bypassed `/etc/hosts` — when a Chromium browser cached a real IP for instagram.com, the tab still gets closed by URL match.

**Retreat mode (Mac app allowlist):** an opt-in mode for periods of strict focus (retreats, deep work blocks). Configured via `POST /api/retreat` with windows (minutes from midnight), an `endDate`, and an allowlist of bundle IDs. The Swift `retreat-enforcer` LaunchAgent reads `retreat` from `config.json` directly and, while the current time falls inside any window AND `now < endDate`:
1. **Launch observer** — `NSWorkspace.didLaunchApplicationNotification` triggers an instant kill on app launch.
2. **5s sweep** — catches apps already running when a window opens.
3. **System allowlist** — Finder, Dock, ControlCenter, NotificationCenter, SystemUIServer, WindowManager, SystemPreferences are hardcoded as always-allowed so the OS stays usable.
4. **Scoped to `.regular`** — only kills dock-able UI apps; menu bar utilities and background services are unaffected.

The `endDate` is a hard expiry — once passed, the enforcer stops killing even if the LaunchAgent is still running.

## Daemon IPC Protocol

JSON-RPC 2.0 over Unix socket at `/tmp/amberfocus.sock`. Newline-delimited. 15s timeout (45s for `reconcile`).

| Method | Params | Effect |
|--------|--------|--------|
| `reconcile` | `{configPath?, reason?}` | Announce where `config.json` lives (persisted in `/var/db/amber-focus/config-path`), run one pass, return the daemon status |
| `status` | (none) | Daemon health without a pass: pid, uptime, `converged`, `lastReconcileAt`, `lastError`, `configPath`, `legacyBlockedAllowed` |
| `flush_dns` | (none) | Flush macOS DNS cache |
| `restart` | (none) | Self-exit; launchd KeepAlive respawns from the latest bundle (sudo-free redeploy) |

When adding a new RPC method, add its Zod params schema to `DAEMON_METHODS` in `src/shared/ipc-types.ts` (the dispatcher validates against that registry) and register the handler in `src/daemon/index.ts`.

## How to Debug

```bash
# -- Server health --
curl localhost:8053/status
curl localhost:8053/api/check/twitter.com
curl localhost:8053/api/allowances
curl localhost:8053/api/locks

# -- Daemon health --
ls -la /tmp/amberfocus.sock
sudo launchctl list | grep amberfocus
sudo tail -f /var/log/amber-focus-daemon.log

# -- Server process --
launchctl list | grep amberfocus
tail -f ~/.config/amber-focus/server.log

# -- pf rules --
sudo pfctl -a com.welf.amberfocus -sr           # static anchor
sudo pfctl -a com.welf.amberfocus.dynamic -sr   # dynamic anchor

# -- Test a grant --
curl -X POST localhost:8053/api/grant \
  -H "Content-Type: application/json" \
  -d '{"domain":"reddit.com","minutes":5,"reason":"test"}'

# -- Flush DNS --
curl -X POST localhost:8053/api/flush-dns

# -- Tab sweep status --
tail -f /var/log/amber-focus-daemon.log | grep "Tab sweep"
# Force one immediate sweep (also triggered every 10s automatically):
echo '{"jsonrpc":"2.0","id":1,"method":"sweep_blocked_tabs","params":{"domains":["instagram.com"]}}' | nc -U /tmp/amberfocus.sock

# -- Retreat mode --
curl localhost:8053/api/retreat                                    # current config
launchctl print gui/$(id -u)/com.amberfocus.retreat-enforcer       # enforcer status
tail -f ~/.config/amber-focus/retreat-enforcer.log                 # kill log

# -- Manual start (dev) --
# Terminal 1: sudo node daemon/daemon.cjs
# Terminal 2: npm start  (or: npx tsx src/server.ts)
```

## Known Issues and Gotchas

- **Browser DNS cache lag on unblock**: browsers cache DNS internally, ignore system flushes. Mitigated by pf rule removal (instant) + stale tab closing + DNS flush. User should open a fresh tab. See `research/dns-cache-bug.md`.
- **Hard lockouts**: domains can be locked until a specific date. Server refuses grant/unblock/delete at both REST and MCP layers.
- **pf must be enabled**: run `sudo ./enable-pf.sh` once. Daemon manages rules but does not enable pf itself. Without pf, only DNS blocking (bypassable via DoH).
- **Daemon owns convergence**: desired state lives in `config.json`; the daemon reads it directly and reconciles every 10 s. Daemon and server restart freely and independently. The daemon learns the config path from `--config`, `AMBER_FOCUS_CONFIG`, or the server's first `reconcile` (persisted under `/var/db/amber-focus`).
- **Legacy hosts section**: `/etc/hosts` still carries an orphaned `# BEGIN FOCUS SHIELD BLOCK` section (~248k lines, 2026-02-21) that no code rewrites. It overrides allowances for domains it lists. The daemon reports them in `legacyBlockedAllowed`; `focus-grant` names the fix (`bin/prune-legacy-hosts-entry`). Wiping the whole section is Welf's call.
- **launchd "disabled" flag**: a reboot with `com.amberfocus.daemon` marked disabled leaves it unloaded and `bootstrap` fails with `Input/output error (5)`. Fix: `sudo launchctl enable system/com.amberfocus.daemon` first. `redeploy.sh` and `install-legacy.sh` do this. Happened 2026-09-16.
- **Priority domains vs bulk blocklist**: only ~28 "priority" distraction domains get IP-level pf resolution. Adult blocklist (75K+ domains) stays /etc/hosts-only (resolving all crashed the daemon).
- **`block return` not `block drop`**: pf rules use `block return` for fast TCP RST. `block drop` causes 30-60s browser hangs.
- **QUIC blocking**: pf also blocks `proto udp port 443` to prevent QUIC/HTTP3 fallback.
- **AppleScript tab closing**: only Safari, Arc, Chrome supported.
- **Proxy requires setup**: path blocking and delay friction need CA cert trusted + system proxy at 127.0.0.1:8080.

## Vigilant Mode

Intent-gated access with AI screenshot monitoring. Runs locally — no external dependencies.

When a grant is issued with `vigilant: true` and an `intent` string:
1. Screenshots captured every 10s via `screencapture -x`
2. Each screenshot evaluated by Claude Haiku (claude-haiku-4-5) via Anthropic API
3. Model judges whether user is on-task relative to declared intent
4. 3 consecutive off-task evaluations → automatic grant revocation + aggressive reblock
5. All evaluations logged to `~/.config/amber-focus/vigilant-log.json`

API key retrieved from macOS Keychain: `security find-generic-password -s "cc/anthropic" -a "api_key" -w`

Implementation: `src/vigilant.ts`. Wired into `server.ts` (REST) and `mcp.ts` (MCP tool).

Original spec: `research/vigilant-mode-plan.md`

## Config Files (Runtime)

| Path | Purpose |
|------|---------|
| `~/.config/amber-focus/config.json` | All app state (blocked, delayed, allowances, lockouts, categories) |
| `~/.config/amber-focus/mcp-token` | Bearer token for MCP auth (auto-generated) |
| `~/.config/amber-focus/server.log` | Server logs |
| `~/.config/amber-focus/vigilant-log.json` | Vigilant mode evaluation history |
| `~/.config/amber-focus/certs/` | MITM proxy CA certificate (auto-generated) |
| `/var/log/amber-focus-daemon.log` | Daemon logs |
| `/tmp/amberfocus.sock` | Unix socket for server-daemon IPC (chmod 666) |

## Cloudflare Tunnel (Remote MCP)

MCP endpoint can be exposed via Cloudflare Tunnel for remote access (e.g. Claude Web).
- **LaunchAgent**: `com.cloudflare.tunnel.amberfocus` (auto-starts, KeepAlive)
- Configure tunnel URL and token via your Cloudflare dashboard

## Build and Run

```bash
npm install                 # dependencies
npx tsc                     # build TypeScript
./install.sh                # full install (daemon + server as launchd services)
sudo ./enable-pf.sh         # enable IP-level blocking (once)

# Connect to Claude Code:
claude mcp add --transport http --scope user \
  --header "Authorization: Bearer $(cat ~/.config/amber-focus/mcp-token)" \
  amber-focus http://localhost:8053/mcp
```
