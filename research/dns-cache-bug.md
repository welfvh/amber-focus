# DNS Cache Bug: Grant/Unblock Reliability Failure

## Status: Fix deployed, pending daemon restart

## Problem

When a user grants access to a blocked domain (e.g., `reddit.com` for 5 minutes), the site remains inaccessible. The grant flow correctly updates `/etc/hosts` and flushes system DNS, but **browsers cache DNS internally** and ignore the system flush.

### Timeline of a failed grant

1. Domain is blocked: `/etc/hosts` maps `reddit.com → 0.0.0.0`
2. Browser resolves `reddit.com` → gets `0.0.0.0`, caches it internally
3. User grants `reddit.com` for 5 minutes
4. Daemon removes `reddit.com` from `/etc/hosts`
5. Daemon runs `dscacheutil -flushcache` + `killall -HUP mDNSResponder`
6. **Browser still has `0.0.0.0` in its own DNS cache** → site stays broken
7. User has to wait 60-120s for browser cache TTL, or manually restart browser

### Root cause

For most domains (reddit, HN, substack, etc.), blocking was **only via `/etc/hosts`**. The pf firewall rules only existed for hardcoded IP ranges (Twitter/Meta/TikTok/Netflix subnets). So the entire unblock mechanism relied on browser DNS cache expiry — which is unreliable and varies by browser:

- **Chrome/Arc (Chromium)**: ~60s positive cache TTL, but `/etc/hosts` entries may cache differently
- **Safari**: Uses system DNS cache more faithfully, but still has internal caching
- **Firefox**: 60s default (`network.dnsCacheExpiration`)

### Why flushing system DNS doesn't help

`dscacheutil -flushcache` and `killall -HUP mDNSResponder` only clear the **macOS system resolver cache**. Browsers maintain their own DNS cache layer on top of this. There is no cross-process API to flush a browser's internal DNS cache.

Chrome's cache can be manually cleared at `chrome://net-internals/#dns` but this can't be automated programmatically.

## Fix Applied (2026-02-12)

### 1. Dynamic pf rules for priority domains

New function `refreshDynamicPfRules()` in `daemon.cjs`:
- Resolves ~30 "priority" distraction domains (social, video, news, shopping, gambling) to IPs via `dig +short domain @8.8.8.8`
- Writes `block return` pf rules for each resolved IP
- Called from `refreshBlocking()` whenever blocking state changes
- When a domain is granted, it's excluded from `getDomainsToBlock()`, so its IPs don't get pf rules

This means blocking now works at the **IP level** (via pf) AND DNS level (via `/etc/hosts`). When unblocking, removing the pf rule is instant — no cache involved.

### 2. `block return` instead of `block drop`

Changed all pf rules from `block drop` to `block return`:
- `block return` sends TCP RST / ICMP port-unreachable → browser fails **instantly**
- `block drop` silently drops packets → browser hangs for 30-60s timeout
- Also added `proto udp port 443` rules to block QUIC/HTTP3 (forces TCP fallback)

### 3. Dynamic pf anchor

Added separate anchor `com.welf.focusshield.dynamic` in `/etc/pf.conf` for the resolved-IP rules, alongside the existing static anchor `com.welf.focusshield` (hardcoded IP ranges).

### 4. Close stale browser tabs on grant

After granting, `closeBrowserTabs(domain)` closes any existing tabs showing the blocked domain (which would have stale `0.0.0.0` resolution). User opens a fresh tab which resolves correctly.

## Critical Bug Found: 124K Domain Resolution

### The crash

The initial implementation of `refreshDynamicPfRules()` tried to resolve **ALL** blocked domains — 75,796 base domains (mostly bulk adult blocklists) expanding to 124,223 variants. Each `dig` call is a subprocess spawn. The daemon crashed on startup before it could even open its Unix socket.

**Evidence from `/var/log/cc-focus-daemon.log`:**
```
[2026-02-12T13:20:59.646Z] State loaded: 75796 domains, 0 allowances
[2026-02-12T13:20:59.647Z] Restoring blocking state on startup...
[2026-02-12T13:20:59.985Z] pf rules reloaded
                            ← daemon died here, no "Daemon listening" message
```

The server reported `daemonRunning: false` — socket never created.

### The fix

Added `PRIORITY_DOMAINS` list — only the ~28 core distraction domains get pf-level IP resolution. The 75K+ bulk adult blocklist stays `/etc/hosts`-only, which is appropriate because:
- Users don't grant/unblock those domains
- `/etc/hosts` is sufficient for bulk blocking
- Nobody's browser-DNS-caching 75K adult domains

## Remaining Concerns

### 1. DNS resolution is synchronous and blocking

`refreshDynamicPfRules()` runs `dig` synchronously for each priority domain variant (~50 calls). At ~100ms each, that's ~5 seconds blocking the HTTP handler. Should be async or batched, but functional for now.

### 2. IP addresses change

Domain IPs can change (CDN rotation, DNS load balancing). The dynamic rules are only refreshed when `refreshBlocking()` is called (grant, revoke, blocklist change, expiry). A domain's IPs could change between refreshes. A periodic re-resolution (e.g., every 10 min) would help.

### 3. pf must be enabled

`pfctl -e` must have been run at some point. The daemon calls `pfctl -f /etc/pf.conf` (reload) but doesn't explicitly enable pf. If pf is disabled, all rules are ignored. The existing `enable-pf.sh` script handles this during install.

### 4. Browser DNS cache still affects unblock latency

Even with pf rules removed, the browser may still try `0.0.0.0` from its DNS cache for up to 60s. The user would see a brief error page before the cache expires and real DNS kicks in. Closing stale tabs mitigates this — the user opens a fresh tab which does a new DNS lookup. But if the browser's DNS cache is process-wide (not per-tab), even the fresh tab uses the stale cache.

**Potential future fix**: Run a tiny local DNS server (e.g., on 127.0.0.53) that the system points to. This gives full control over DNS responses — can return real IPs instantly when a domain is unblocked, and NXDOMAIN when blocked. But this is a significant architectural change.

## Files Changed

| File | Changes |
|------|---------|
| `daemon/daemon.cjs` | `openInBrowser()`, `refreshDynamicPfRules()`, `PRIORITY_DOMAINS`, `block return` rules, dynamic anchor loading, grant handler updates |

## Verification Steps

```bash
# 1. Restart daemon
sudo launchctl stop com.welf.focusshield.daemon
sudo launchctl start com.welf.focusshield.daemon

# 2. Check daemon started successfully
tail -20 /var/log/cc-focus-daemon.log
# Should see "Dynamic pf rules: N IPs for M domain variants" and "Daemon listening"

# 3. Check dynamic pf rules
sudo pfctl -a com.welf.focusshield.dynamic -sr
# Should show block return rules for priority domain IPs

# 4. Test grant
curl -X POST localhost:8053/api/grant -H "Content-Type: application/json" \
  -d '{"domain":"reddit.com","minutes":2,"reason":"test"}'
# Should succeed, reddit.com accessible immediately

# 5. Check rules removed for granted domain
sudo pfctl -a com.welf.focusshield.dynamic -sr | grep reddit
# Should return nothing

# 6. Wait for expiry, verify re-blocked
sleep 130  # 2 min + margin
sudo pfctl -a com.welf.focusshield.dynamic -sr | grep reddit
# Should show block return rules for reddit IPs
```
