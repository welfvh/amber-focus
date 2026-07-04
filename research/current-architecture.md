# cc-focus Current Architecture

## Overview

cc-focus uses a defense-in-depth approach with 4 layers:

1. **DNS blocking** via `/etc/hosts` (maps to `0.0.0.0` / `::`)
2. **IP-level blocking** via `pf` (packet filter) firewall rules
3. **Connection killing** via `pfctl -k` to tear down existing TCP connections
4. **Browser tab closing** via AppleScript (Safari, Arc, Chrome only)

Plus an optional **MITM proxy** on port 8080 for path-level blocking and delay friction.

## Components

### Daemon (`daemon.cjs`) — runs as root

The privileged component. Handles all operations that need root:

- **`/etc/hosts` management**: Writes blocked domains with variants (www., m., mobile., old., new., i.) mapping to `0.0.0.0` and `::` (IPv6)
- **`pf` firewall rules**: Hard-coded IP ranges for major platforms:
  - Twitter/X: AS13414 (104.244.42.0/24 - 104.244.46.0/24, etc.)
  - Meta: AS32934 (157.240.0.0/16, 31.13.0.0/16, etc.)
  - TikTok: 161.117.0.0/16, 162.62.0.0/16
  - Netflix: 23.246.0.0/18, 37.77.184.0/21, etc.
- **Dynamic IP blocking**: `dig +short domain` → creates pf rules for resolved IPs
- **Connection killing**: `pfctl -k 0.0.0.0/0 -k <IP>` to kill existing TCP connections
- **Browser tab closing**: AppleScript substring match on tab URLs
- **Allowance expiry**: Checks every 30s, re-blocks expired domains

State persisted to `/Library/Application Support/FocusShield/state.json`.

### Server (`server.ts`) — REST API on localhost:8053

User-facing API + MCP endpoint:

- `POST /api/grant` — grant timed access (syncs to daemon)
- `DELETE /api/grant/:domain` — revoke (calls daemon to kill connections)
- `POST /api/block` / `DELETE /api/block/:domain` — manage blocklist
- Hard lockout enforcement (refuses grants for locked domains)
- Own allowance expiry checker (every 30s, calls `enforceBlockViaDaemon`)

### Blocker (`blocker.ts`) — daemon IPC

Functions to communicate with daemon:
- `enableBlocking()` — sync blocklist + update hosts
- `enforceBlockViaDaemon()` — aggressive block (IPs + kill connections + close tabs)
- `grantAllowanceViaDaemon()` — register allowance with daemon
- `revokeAllowanceViaDaemon()` — revoke + enforce

### Proxy (`proxy.ts`) — optional MITM on port 8080

HTTPS interception via CONNECT tunneling:
- Generates on-the-fly certs signed by self-signed CA
- Serves 403 block pages for DNS-blocked or path-blocked domains
- Delay friction: progressive wait times (10s → 20s → 40s → 80s → 160s)
- Requires system proxy configuration + CA cert trust in System Keychain

## Grant Flow (what happens when a domain is unblocked)

```
POST /api/grant {domain: "reddit.com", minutes: 5}
  ↓
Server: grantAllowance() — adds to store
  ↓
Server: enableBlocking(effectivelyBlocked) — removes domain from hosts file
  ↓
Server: grantAllowanceViaDaemon() — POST to daemon /grant
  ↓
Daemon: unblockDomainIPs() — removes dynamic pf rules
Daemon: refreshBlocking() — updates hosts, flushes DNS (dscacheutil + mDNSResponder)
```

**Result**: Domain resolves normally at the OS level.

## Re-blocking Flow (what happens when a grant expires)

```
Server checkAllowanceExpiry (every 30s):
  ↓ detects expired allowance
  ↓
enableBlocking() — re-adds domain to hosts
enforceBlockViaDaemon() — POST to daemon /enforce-block
  ↓
Daemon:
  blockDomainIPs() — dig domain → pf rules
  killConnectionsToDomain() — pfctl -k
  closeBrowserTabs() — AppleScript
  flushDnsCache()
```

## THE PROBLEM: Why sites stay blocked after granting

### Root cause: Browser DNS cache

Even though cc-focus:
1. Updates `/etc/hosts` (removes the domain)
2. Flushes system DNS cache (`dscacheutil -flushcache` + `killall -HUP mDNSResponder`)
3. Removes pf rules

**Browsers maintain their own internal DNS cache** that ignores system DNS flushes:
- **Safari**: Caches DNS internally, no public API to flush
- **Chrome**: `chrome://net-internals/#dns` → manual flush
- **Firefox**: `about:networking#dns` → manual flush

The browser saw `0.0.0.0` for `reddit.com` and cached it. The system cache was flushed, but the browser doesn't re-query until its internal TTL expires (can be minutes).

### Secondary issue: SSL certificate cache

If the MITM proxy was active when the domain was blocked, the browser may have cached a bad certificate. Even after unblocking, the browser shows `ERR_SSL_PROTOCOL_ERROR` because it's trying to use the cached MITM cert for the now-direct connection.

### Third issue: pf rules not always cleaned up

Dynamic pf rules added via `blockDomainIPs()` may not be fully removed during unblocking. The `unblockDomainIPs()` function may miss IPs if the domain resolves to different addresses than when it was blocked.

## What needs to change

The current approach of "modify DNS resolution and hope the browser notices" is fundamentally fragile. A more reliable approach would operate at a layer the browser cannot cache around.
