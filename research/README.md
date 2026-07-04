# amber-focus Research

Research documents compiled during architecture exploration and ongoing development.

## Status Key

- **DEPLOYED** — research led to code that is merged and running
- **FIX DEPLOYED** — bug investigation that produced a shipped fix
- **PLANNED** — design spec for features not yet built
- **ROADMAP** — backlog/prioritization document
- **REFERENCE** — background research informing design decisions

## Documents

| File | Status | Summary |
|------|--------|---------|
| [onboarding-ux.md](onboarding-ux.md) | PLANNED | First-time onboarding UX: 5-screen flow, inverse model (block everything, ask what stays), cooldowns, motivation capture. |
| [wireframes/onboarding.html](wireframes/onboarding.html) | PLANNED | Interactive HTML wireframes for the 5 onboarding screens. Serve locally, navigate with `?screen=N`. |
| [full-flow.md](full-flow.md) | PLANNED | Complete user journey: GitHub download → `./setup` → browser onboarding → daily use. Documents what needs building. |
| [consolidation.md](consolidation.md) | REFERENCE | Consolidation analysis: potential-mac + monastic-agent + amber-focus. ASCII diagrams of current and proposed UI. Recommends tabbed menu bar app. |
| [vigilant-mode-plan.md](vigilant-mode-plan.md) | DEPLOYED | Intent-gated monitored sessions. Screenshots every ~10s evaluated by Claude Haiku vision, auto-revoke on drift. |
| [daemon-redesign.md](daemon-redesign.md) | DEPLOYED | Stateless daemon architecture, JSON-RPC IPC, async operations, TypeScript rewrite. |
| [dns-cache-bug.md](dns-cache-bug.md) | FIX DEPLOYED | Browser DNS cache causes unblock failures. Fix: dynamic pf rules, `block return`, QUIC blocking, stale tab closing. |
| [instant-revocation.md](instant-revocation.md) | DEPLOYED | Fast grant revocation: connection killing, tab closing, DNS flush coordination. |
| [backlog-2026-02-12.md](backlog-2026-02-12.md) | ROADMAP | Feature backlog: pushup gate, vigilant mode, re-blocking audit, activity views. |
| [blocking-approaches.md](blocking-approaches.md) | REFERENCE | Comparison of macOS blocking techniques: /etc/hosts, pf, NEFilterDataProvider, DNS Proxy, Transparent Proxy, browser extensions. |
| [current-architecture.md](current-architecture.md) | REFERENCE | Snapshot of the pre-redesign architecture (4-layer defense-in-depth). |
| [selfcontrol-analysis.md](selfcontrol-analysis.md) | REFERENCE | SelfControl's privileged daemon, XPC, integrity monitoring, tamper resistance. |
| [existing-tools-deep-dive.md](existing-tools-deep-dive.md) | REFERENCE | SelfControl, Cold Turkey, Focus, 1Focus, LuLu, Little Snitch analysis. |
| [ne-filter-deep-dive.md](ne-filter-deep-dive.md) | REFERENCE | NEFilterDataProvider evaluation. Handles DoH, QUIC, browser DNS caches. |
| [local-dns-resolver.md](local-dns-resolver.md) | REFERENCE | dnsmasq/unbound as /etc/hosts replacement. Not pursued. |
| [codex-investigation.md](codex-investigation.md) | REFERENCE | Prompt/context for Codex investigation into blocking reliability. |
