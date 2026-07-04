# Codex Investigation: cc-focus Blocking Reliability

## Prompt for Codex 5.3

```
Investigate and fix the blocking/unblocking reliability issues in this macOS focus shield app.

## Context

cc-focus is a self-control tool that blocks distracting websites via /etc/hosts + pf firewall on macOS. The core problem: when a user "grants" temporary access to a blocked domain, the site often stays inaccessible because browsers cache DNS internally and ignore system DNS cache flushes.

A fix was partially deployed (dynamic pf rules for priority domains, block return instead of block drop), but needs verification and hardening.

## Key files

- `daemon/daemon.cjs` — privileged daemon (runs as root), manages /etc/hosts and pf rules. THIS IS THE FILE THAT CHANGED.
- `src/server.ts` — unprivileged server (port 8053), API layer that talks to daemon via Unix socket
- `src/store.ts` — config/state management, BLOCK_CATEGORIES definition
- `research/dns-cache-bug.md` — full writeup of the bug and fix

## Specific tasks

1. **Verify the fix is correct**: Read `daemon.cjs` and confirm that:
   - `refreshDynamicPfRules()` only resolves PRIORITY_DOMAINS (not all 75K+ domains)
   - Granted domains are correctly excluded from dynamic pf rules
   - `unblockDomainIPs()` runs BEFORE `refreshDynamicPfRules()` in the grant flow (so the domain doesn't get re-added)
   - The `block return` rules are syntactically correct pf syntax
   - Dynamic anchor is properly referenced in pf.conf setup

2. **Find edge cases**:
   - What happens if `dig` fails for a domain? (timeout, DNS unreachable)
   - What if a priority domain resolves to a Cloudflare/CDN IP shared by non-blocked services? (collateral blocking)
   - What if the daemon restarts while an allowance is active? Does the allowance survive? Are pf rules correctly restored?
   - Race condition: can `checkAllowanceExpiry()` (30s interval) and a `/grant` request race on the dynamic pf file?

3. **Recommend improvements** (but DO NOT implement without approval):
   - Should `refreshDynamicPfRules()` be async? How to avoid blocking the HTTP handler for 5s?
   - Should there be periodic re-resolution of IPs (CDN rotation)?
   - Is there a way to force-flush browser DNS from the OS level? (Chrome DevTools Protocol? Sending SIGUSR1?)
   - Would a local DNS resolver (dnsmasq/unbound on 127.0.0.53) be a more reliable approach than /etc/hosts?

4. **Write tests** if feasible — at minimum, unit tests for:
   - `getDomainsToBlock()` with active allowances
   - `collectAllDomainsWithVariants()` expansion logic
   - `PRIORITY_DOMAINS` filtering in `refreshDynamicPfRules()`

## Important constraints

- The daemon runs as root on macOS via launchd
- There are 75,796 blocked domains total (bulk adult blocklists) — NEVER try to resolve all of them
- pf rules use macOS pf syntax (BSD, not Linux iptables)
- Hard lockouts exist for twitter.com, x.com, youtube.com, youtu.be until March 1, 2026 — these must NEVER be grantable
```

## Open this folder in Codex

Point Codex at the repo root:

```
~/dev/amber-focus
```

The key files are `daemon/daemon.cjs` and the `research/` folder for context.
