# Changelog

## [Unreleased]

### Added
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
