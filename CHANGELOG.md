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

### Added
- `POST /api/reconcile` — run one pass now.
- Daemon watchdog in the server: macOS notification with the fix command when the daemon is unreachable or not converged.
- `redeploy.sh` / `install-legacy.sh` run `launchctl enable` before bootstrapping the daemon (a stale disabled flag survived a reboot on 2026-09-16).
- Unit tests (vitest) for the reconcile core and the daemon pass.

### Fixed
- Server crashed on every grant/block/revoke while the daemon was down (unhandled rejection under Express 4).
- Server never re-sent state after a daemon restart; /etc/hosts stayed stale.
- Vigilant never captured screenshots under launchd (`screencapture` not on PATH).
- MCP `amber_grant` description said 4 off-task strikes; the limit is 3.
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
