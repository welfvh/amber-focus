# Changelog

## [Unreleased]

### Changed
- Daemon owns convergence: a reconcile loop (10 s timer + config.json watch + `reconcile` RPC) converges /etc/hosts and pf to the desired state read from config.json. Grants and expiries apply even when the server is down. Previous state is read back from the hosts section (`# Domains:` line), so daemon restarts lose nothing.
- Server only edits desired state and reports OS truth: `/api/check` returns `blocked` from /etc/hosts (+ `source`) next to `desiredBlocked`; `/status` reports `converged`, `healthy`, `lastError`, `legacyBlockedAllowed`.
- Grants reload the domain's tabs instead of closing them; tab matching is by hostname everywhere.
- `shieldActive` is persisted in config.json (was in-memory and latched false when the daemon was down at boot).
- Vigilant sessions resume after a server restart (intent stored on the allowance); status exposes capture errors and `degraded`.
- `focus-grant` verifies against OS truth, nudges the daemon with `POST /api/reconcile`, and names the blocking layer on failure.
- Daemon RPCs `apply`, `enforce`, `unblock_domain`, `sweep_blocked_tabs` removed.
- The daemon finds `config.json` itself (`--config`, `AMBER_FOCUS_CONFIG`, or the console user's home). The `reconcile` RPC no longer takes a path.
- Tabs are handled by the server as the user (`src/browser.ts`, JXA with data passed as a JSON argument). The daemon no longer drives browsers as root; it only flushes the Chromium DNS cache.
- The server closes open tabs on blocked domains every 10 s (tab sweep); `/status` reports `tabSweep.lastError`.
- One grant path (`grant` in `actions.ts`): grants are 1–60 min, refuse public suffixes and IPs (`tldts`), and refuse anything a hard lock touches: the locked domain, its parents, and its subdomains.
- Shield disable is refused while any hard lock is active. Unblocking a hard-locked domain is refused.
- A corrupt `config.json` is copied aside (`config.json.corrupt-<ts>`) before defaults load; unknown keys survive saves.
- `install-legacy.sh` renamed to `install-services.sh`; `install.sh` runs it after cloning.

### Added
- `POST /api/reconcile` — run one pass now.
- Daemon watchdog in the server: macOS notification with the fix command when the daemon is unreachable or not converged.
- `redeploy.sh` / `install-services.sh` run `launchctl enable` before bootstrapping the daemon (a stale disabled flag survived a reboot on 2026-09-16).
- Unit tests (vitest) for the reconcile core, the daemon pass, hostname validation, input policy, the request guard, the store, and the JXA script.
- Timestamps on every server log line.

### Security
- The daemon validates every hostname it reads from `config.json` before it writes /etc/hosts or pf. Invalid entries are logged and skipped.
- The REST API accepts loopback `Host` headers only and refuses any request with an `Origin` header (no CORS). Web pages and DNS rebinding cannot reach it.
- The MCP endpoint and its public tunnel route are gone.

### Removed
- MCP server (`src/mcp.ts`), HTTP proxy (`src/proxy.ts`), delayed domains, path blocks, cooldowns, onboarding/profile routes, the version counter.
- Native setup app (`app/amber-focus.swift`), Safari extension (`safari/`), `bin/amber-focus` CLI, `SETUP.md`. `focus-grant` is the one client.

### Fixed
- Server crashed on every grant/block/revoke while the daemon was down (unhandled rejection under Express 4).
- Server never re-sent state after a daemon restart; /etc/hosts stayed stale.
- Vigilant never captured screenshots under launchd (`screencapture` not on PATH).
- Retreat app blocking: blocklist mode kills only listed bundle IDs (alongside existing allowlist mode), set via `blocklist` in `POST /api/retreat`
- Native macOS setup app with menu bar dashboard
- Installer that builds, installs services, enables pf, wires MCP
- Copyable code blocks in onboarding
- /api/setup/* routes and profile storage for native app onboarding
- Vigilant mode — AI screenshot monitoring during active grants
- cc-amber-focus skill file
- Consolidation research: potential-mac + monastic-agent + amber-focus
- SETUP.md quickstart with cc-keys integration
- Expanded blocklist: 91 → 308 domains across 11 categories

### Changed
- Rebranded cc-focus → amber-focus
- Menu bar: SF Symbol shield icon, labeled activity stats + timeframe
- Welcome copy: "Amber blocks" not "I block"
- Always show menu bar from launch, onboarding opens on top

### Fixed
- Onboarding UX: bigger window, cooldown clicks, better instructions
- Wireframe screen 5 polish
- proxy.ts import extension
- Contrast improvements across onboarding
