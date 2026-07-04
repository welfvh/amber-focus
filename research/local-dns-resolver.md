# Local DNS Resolver for cc-focus: Research Report

Research compiled 2026-02-12. Evaluating dnsmasq/unbound as an alternative to `/etc/hosts` manipulation for domain blocking.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [dnsmasq vs unbound for This Use Case](#2-dnsmasq-vs-unbound-for-this-use-case)
3. [macOS DNS Configuration Stability](#3-macos-dns-configuration-stability)
4. [DoH/DoT Blocking via pf](#4-dohdot-blocking-via-pf)
5. [Browser DNS Cache Interaction](#5-browser-dns-cache-interaction)
6. [Integration Architecture](#6-integration-architecture)
7. [Existing Projects Using This Approach](#7-existing-projects-using-this-approach)
8. [Comparison: Local DNS vs /etc/hosts + pf](#8-comparison-local-dns-vs-etchosts--pf)
9. [Recommendation](#9-recommendation)
10. [Sources](#10-sources)

---

## 1. Problem Statement

cc-focus currently blocks domains by writing `0.0.0.0` entries to `/etc/hosts` and flushing the macOS system DNS cache. The fundamental problem: **browsers maintain their own DNS cache** that ignores system flushes. When we grant/unblock a domain, the browser keeps serving the stale `0.0.0.0` from its internal cache for 60+ seconds. There is no cross-process API to flush a browser's internal DNS cache.

The hypothesis: if we run a local DNS resolver on `127.0.0.1:53` and point the system at it, the resolver IS the authoritative source. When we change what it returns, the browser should re-query on the next lookup. Combined with low TTLs, this could make grant/revoke nearly instant.

---

## 2. dnsmasq vs unbound for This Use Case

### Winner: dnsmasq

For a local forwarding resolver whose primary job is domain blocking with a large blocklist, **dnsmasq is the clear choice**. It is purpose-built as a lightweight DNS forwarder, whereas unbound is a full recursive resolver designed for DNSSEC validation and recursive resolution — capabilities we don't need and that add complexity.

### Comparison

| Factor | dnsmasq | unbound |
|--------|---------|---------|
| **Type** | Forwarding DNS server | Full recursive resolver |
| **Memory (75K domains)** | ~12-15 MB (Pi-hole reports ~12 MB for 200K domains) | ~75-100 MB for 170K local-zone entries; v1.21.0 has memory exhaustion bugs with large blocklists |
| **Startup time** | Fast (seconds) | Slower (must load DNSSEC root keys, build zone trees) |
| **Config reload** | `SIGHUP` reloads hosts files (NOT main config). Instant, no downtime. | `unbound-control reload` — full config reload, brief interruption |
| **Wildcard blocking** | `address=/twitter.com/` blocks domain + all subdomains automatically | `local-zone: "twitter.com" always_nxdomain` — same capability |
| **Blocklist format** | `address=/domain/` or `address=/domain/#` per line; also reads `/etc/hosts` format via `--addn-hosts` | `local-zone: "domain" always_nxdomain` per line |
| **Homebrew install** | `brew install dnsmasq` | `brew install unbound` |
| **Pi-hole uses** | Yes (pihole-FTL is a dnsmasq fork) | No |
| **macOS native support** | Excellent, well-tested on macOS via Homebrew | Works but less common on macOS |

### Critical unbound issue

Unbound v1.21.0 introduced a **memory exhaustion regression** when loading large blocklists via `include` directive. Users with ~245K NXDOMAIN entries report `error: memory exhausted` on startup — a regression from v1.20 where the same list loaded fine at ~75 MB. This is an active bug ([NLnetLabs/unbound#1129](https://github.com/NLnetLabs/unbound/issues/1129)). For a tool that needs to load 75K+ adult content domains reliably, this is a dealbreaker.

### dnsmasq configuration for blocking

```conf
# /opt/homebrew/etc/dnsmasq.conf

# Listen only on localhost
listen-address=127.0.0.1
bind-interfaces

# Port 53 (standard DNS)
port=53

# Upstream DNS servers (forwarding)
server=1.1.1.1
server=8.8.8.8

# Don't read /etc/resolv.conf (we ARE the resolver)
no-resolv

# Don't poll /etc/resolv.conf for changes
no-poll

# Set TTL for local/blocked responses to 0
# This tells clients "don't cache this response"
local-ttl=0

# Cache size for upstream responses (default 150)
cache-size=1000

# Load blocklist files (re-read on SIGHUP)
addn-hosts=/usr/local/etc/cc-focus/blocked-hosts
conf-dir=/usr/local/etc/cc-focus/blocklists/,*.conf

# Log queries (optional, for debugging)
# log-queries
# log-facility=/var/log/dnsmasq.log
```

### Blocking syntax options

```conf
# Option 1: address directive (in .conf files loaded via conf-dir)
# Blocks domain AND all subdomains. Returns 0.0.0.0 / ::
address=/twitter.com/#
address=/x.com/#
address=/facebook.com/#

# Option 2: Return NXDOMAIN (no trailing address)
address=/twitter.com/

# Option 3: hosts-format file (loaded via addn-hosts, re-read on SIGHUP)
# Does NOT support wildcard/subdomain blocking
0.0.0.0 twitter.com
0.0.0.0 www.twitter.com
0.0.0.0 m.twitter.com
```

### Dynamic reload mechanism

**SIGHUP behavior** (critical limitation to understand):
- `SIGHUP` clears the cache and re-reads files specified by `--addn-hosts`, `--dhcp-hostsfile`, `--dhcp-optsfile`
- `SIGHUP` does **NOT** re-read the main config file or files loaded via `conf-dir`
- Changes to `address=` directives in conf files require a **full restart**

**Implication for cc-focus**: For dynamic grant/revoke, we should manage the blocklist as an `addn-hosts` file (hosts format), not as `address=` directives. The `addn-hosts` file is re-read on SIGHUP without downtime. The tradeoff: hosts format doesn't support wildcard/subdomain blocking. We'd need to enumerate subdomains explicitly (www., m., etc.) — which we already do today.

**Alternative**: Use `address=` directives in a conf file for the static blocklist (loaded once on startup), and `addn-hosts` for the dynamic portion. SIGHUP handles the dynamic part; a full restart (rare) handles static list updates.

### Wildcard support

dnsmasq's `address=` directive implicitly matches all subdomains:

```conf
# Blocks twitter.com, www.twitter.com, api.twitter.com, *.twitter.com
address=/twitter.com/#
```

This is a significant advantage over `/etc/hosts`, where each subdomain variant must be listed explicitly. For the ~30 priority distraction domains, this eliminates the need to enumerate `www.`, `m.`, `mobile.`, `old.`, `new.`, `i.` variants.

For the 75K adult blocklist loaded via `addn-hosts` (hosts format), we still need explicit subdomain entries — same as today. But these domains are static and don't need dynamic grant/revoke.

---

## 3. macOS DNS Configuration Stability

This is the **hardest problem** in the local DNS resolver approach.

### Setting system DNS to 127.0.0.1

```bash
# Get the active network service name
ACTIVE_SERVICE=$(networksetup -listallnetworkservices | grep -v '^\*' | while read service; do
  networksetup -getinfo "$service" 2>/dev/null | grep -q "IP address:" && echo "$service" && break
done)

# Set DNS to local resolver
sudo networksetup -setdnsservers "$ACTIVE_SERVICE" 127.0.0.1

# Verify
scutil --dns | head -20
```

### The problem: macOS resets DNS on network changes

macOS's `configd` daemon manages network configuration. When any of these events occur, DNS settings **may revert to DHCP-provided values**:

- Wi-Fi network changes (switch networks, reconnect after sleep)
- VPN connect/disconnect
- Ethernet cable plug/unplug
- macOS updates/restarts
- Network Location changes

This is well-documented and affects all tools that set custom DNS — including DNSFilter, NextDNS CLI, and anyone running a local resolver.

### Solutions for DNS persistence

#### Option A: LaunchDaemon network watcher (recommended)

A LaunchDaemon that monitors network state changes via `scutil` and re-applies DNS settings:

```bash
#!/bin/bash
# /usr/local/bin/cc-focus-dns-watcher.sh
# Re-applies 127.0.0.1 as DNS server whenever network changes are detected.

TARGET_DNS="127.0.0.1"

apply_dns() {
  for service in $(networksetup -listallnetworkservices | grep -v '^\*'); do
    current_dns=$(networksetup -getdnsservers "$service" 2>/dev/null)
    if [ "$current_dns" != "$TARGET_DNS" ]; then
      networksetup -setdnsservers "$service" "$TARGET_DNS"
      logger -t cc-focus-dns "Re-applied DNS $TARGET_DNS to $service"
    fi
  done
}

# Initial application
apply_dns

# Watch for network changes via scutil
scutil <<EOF | while read line; do
  open
  d.init
  d.add DNS : array { $TARGET_DNS }
  get State:/Network/Global/DNS
  n.add State:/Network/Global/DNS
  n.add State:/Network/Interface/.*/IPv4 pattern
  n.watch
EOF
  apply_dns
done
```

A simpler but less elegant approach: poll every 10-15 seconds:

```bash
#!/bin/bash
# /usr/local/bin/cc-focus-dns-poll.sh
# Polls and re-applies DNS every 10 seconds.

while true; do
  for service in $(networksetup -listallnetworkservices | grep -v '^\*'); do
    current=$(networksetup -getdnsservers "$service" 2>/dev/null | head -1)
    if [ "$current" != "127.0.0.1" ]; then
      networksetup -setdnsservers "$service" 127.0.0.1
      logger -t cc-focus-dns "Re-applied DNS to $service (was: $current)"
    fi
  done
  sleep 10
done
```

LaunchDaemon plist:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.welf.ccfocus.dnswatcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/cc-focus-dns-watcher.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>/var/log/cc-focus-dns-watcher.log</string>
</dict>
</plist>
```

#### Option B: SCDynamicStore notifications (programmatic, best)

For a daemon written in Swift or C, use `SCDynamicStoreSetNotificationKeys` to register for network change callbacks:

```swift
import SystemConfiguration

let callback: SCDynamicStoreCallBack = { store, changedKeys, info in
    // Re-apply DNS settings
    let services = SCNetworkServiceCopyAll(SCPreferencesCreate(nil, "cc-focus" as CFString, nil)!)
    // ... iterate and set DNS to 127.0.0.1
}

let store = SCDynamicStoreCreate(nil, "cc-focus" as CFString, callback, nil)!
let keys = ["State:/Network/Global/DNS" as CFString] as CFArray
let patterns = ["State:/Network/Service/.*/IPv4" as CFString] as CFArray
SCDynamicStoreSetNotificationKeys(store, keys, patterns)
let source = SCDynamicStoreCreateRunLoopSource(nil, store, 0)!
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
```

This is the most responsive approach — instant callback on network changes, no polling overhead.

#### Option C: /etc/resolver directory (complementary, not standalone)

macOS has a special `/etc/resolver/` directory for per-domain DNS overrides. Files in this directory tell the system to use a specific DNS server for queries matching that domain:

```bash
# /etc/resolver/com
nameserver 127.0.0.1

# /etc/resolver/org
nameserver 127.0.0.1

# /etc/resolver/net
nameserver 127.0.0.1
```

**Limitation**: This only works for per-TLD routing, not as a global DNS override. You'd need a file for every TLD, which is impractical. And it doesn't affect the global DNS resolver setting — browsers using the system DNS may still use the DHCP-provided server for TLDs not covered.

**Not suitable as a standalone solution**, but useful as an additional signal to macOS.

### macOS Sequoia considerations

Apple has been progressively restricting loopback-based DNS interception since macOS 11 Big Sur. DNSFilter documented that their legacy "loopback method" (setting DNS to 127.0.0.1 and running a local proxy) became "fragile and unreliable" and they migrated to Apple's System Extension framework.

However, running a legitimate DNS server on 127.0.0.1 (like dnsmasq via Homebrew) is fundamentally different from loopback interception tricks. dnsmasq binds to port 53 as a real DNS server — this is standard Unix behavior that macOS still supports. The fragility DNSFilter experienced was from intercepting/redirecting DNS traffic, not from running an actual DNS server.

**Current status**: dnsmasq on 127.0.0.1 port 53 works on macOS Sequoia 15.x. The risk is that future macOS versions could further restrict binding to port 53 or override DNS settings more aggressively. This is a real but speculative concern.

---

## 4. DoH/DoT Blocking via pf

Preventing browsers from bypassing the local resolver via DNS-over-HTTPS (DoH) or DNS-over-TLS (DoT) is essential. Without this, the entire approach falls apart — a browser using DoH ignores system DNS entirely.

### Strategy

1. **Block port 853** (DoT) globally — no legitimate non-DNS use.
2. **Block port 443 to known DoH provider IPs** — surgical, avoids breaking regular HTTPS.
3. **Blackhole the Firefox canary domain** `use-application-dns.net` in dnsmasq.
4. **Optionally**: Disable browser DoH via enterprise policies.

### Known DoH provider IPs to block

Major providers (essential to block):

| Provider | IPv4 | IPv6 |
|----------|------|------|
| Google | 8.8.8.8, 8.8.4.4 | 2001:4860:4860::8888, 2001:4860:4860::8844 |
| Cloudflare | 1.1.1.1, 1.0.0.1 | 2606:4700:4700::1111, 2606:4700:4700::1001 |
| Quad9 | 9.9.9.9, 9.9.9.10, 9.9.9.11 | 2620:fe::fe, 2620:fe::9 |
| OpenDNS | 208.67.222.222, 208.67.220.220 | - |
| NextDNS | 45.90.28.0, 45.90.30.0 | 2a07:a8c0::, 2a07:a8c1:: |
| AdGuard | 94.140.14.14, 94.140.15.15 | - |
| Mullvad | 194.242.2.2 | - |
| CleanBrowsing | 185.228.168.168, 185.228.169.168 | - |

### Maintained DoH IP blocklists

Several GitHub repositories maintain up-to-date lists:

- **[dibdot/DoH-IP-blocklists](https://github.com/dibdot/DoH-IP-blocklists)** — Domain names + resolved IPv4/IPv6 of public DoH servers. Updated automatically via GitHub Actions every hour.
- **[jameshas/Public-DoH-Lists](https://github.com/jameshas/Public-DoH-Lists)** — Automatically generated from the Curl and AdGuard DNS wiki pages.
- **[bambenek/block-doh](https://github.com/bambenek/block-doh)** — RPZ zone files + IP lists.

### pf rules

```
# /etc/pf.anchors/com.welf.focusshield.doh

# Block DNS-over-TLS (port 853) globally — no collateral damage
block return out quick proto tcp to any port 853

# Block DoH to major providers (port 443 to specific IPs only)
table <doh_providers> const { \
  8.8.8.8, 8.8.4.4, \
  1.1.1.1, 1.0.0.1, \
  9.9.9.9, 9.9.9.10, 9.9.9.11, \
  208.67.222.222, 208.67.220.220, \
  45.90.28.0/24, 45.90.30.0/24, \
  94.140.14.14, 94.140.15.15, \
  185.228.168.168, 185.228.169.168 \
}

block return out quick proto tcp to <doh_providers> port 443
block return out quick proto udp to <doh_providers> port 443
```

**Load in /etc/pf.conf:**
```
anchor "com.welf.focusshield.doh"
load anchor "com.welf.focusshield.doh" from "/etc/pf.anchors/com.welf.focusshield.doh"
```

### The CDN-hosted DoH problem

Some DoH providers (especially Cloudflare) share IP addresses between their CDN and their DoH endpoint. Blocking 1.1.1.1 is safe — it's a dedicated DNS IP. But some DoH endpoints use standard CDN IPs (e.g., `dns.google` at 8.8.8.8 is dedicated, but smaller providers might use shared hosting).

**Practical impact**: Minimal. The major DoH providers (Google, Cloudflare, Quad9) all use dedicated IPs for their DNS services. Blocking them won't break regular HTTPS traffic. The long tail of small DoH providers is less concerning — browsers default to the major ones.

### Firefox DoH behavior when blocked

Firefox uses `network.trr.mode` for its Trusted Recursive Resolver (DoH):
- **Mode 0**: Off (default outside US)
- **Mode 2**: DoH first, fall back to system DNS on failure (default in US)
- **Mode 3**: DoH only, no fallback
- **Mode 5**: Off (explicitly disabled)

When mode 2 is active and DoH is blocked (connection to Cloudflare fails):
- Firefox **falls back to system DNS** — which is our local resolver. This is the desired behavior.
- The canary domain `use-application-dns.net` — if this returns NXDOMAIN, Firefox auto-disables DoH for users who haven't explicitly enabled it.

**Action**: Add to dnsmasq config:
```conf
# Blackhole Firefox canary domain to disable auto-DoH
address=/use-application-dns.net/
```

**Caveat**: The canary domain only works for users with DoH auto-enabled (mode 2 default). If a user manually sets mode 3 (DoH only, no fallback), the canary is ignored. In that case, pf blocking of the DoH provider IP is the enforcement mechanism — Firefox's DoH connections fail, and with mode 3, DNS breaks entirely. The user would need to manually disable DoH. For a self-control tool where the user is the same person who set it up, this is acceptable.

### Chrome Secure DNS behavior when blocked

Chrome's Secure DNS (DoH) behavior:
- Chrome **does not redirect DNS away from the system resolver**. It only upgrades to DoH if it detects that the system DNS server supports DoH (e.g., system DNS is 8.8.8.8, Chrome tries DoH to 8.8.8.8).
- Since our system DNS is 127.0.0.1 (dnsmasq), Chrome will NOT attempt DoH — there's no DoH endpoint at 127.0.0.1.
- If a user manually configures Chrome's Secure DNS to a custom provider, the pf rules blocking DoH provider IPs will prevent the connection, and Chrome falls back to system DNS.

**This is excellent news**: Chrome + local resolver at 127.0.0.1 = Chrome won't even try DoH by default.

---

## 5. Browser DNS Cache Interaction

The core question: does a local DNS resolver actually solve the browser DNS cache problem?

### How browsers resolve DNS

1. Browser checks its internal DNS cache
2. If miss (or expired TTL), calls `getaddrinfo()` (system resolver) or its built-in resolver
3. System resolver checks its cache (mDNSResponder on macOS)
4. If miss, queries the configured DNS server (our dnsmasq at 127.0.0.1)

### Chromium (Chrome, Arc, Brave, Edge) behavior

Chromium has **two DNS resolution paths**:

**Path 1: System DNS resolver (getaddrinfo)**
- Chromium does NOT know the TTL of the response — `getaddrinfo()` doesn't return it
- Chromium applies a **hardcoded 60-second cache** for all results
- This means even if dnsmasq sets `local-ttl=0`, Chromium caches for 60s anyway

**Path 2: Built-in resolver (when Secure DNS / DoH is active)**
- Chromium sees the actual TTL from the DNS response
- Respects TTL with a **minimum of 60 seconds**
- Since we're blocking DoH, this path won't be used

**Key insight**: Chromium's 60-second minimum cache applies regardless of what TTL the resolver sends. Setting `local-ttl=0` in dnsmasq helps (it tells the system resolver not to cache), but Chromium's own 60-second cache is the floor.

**Network change events**: Chromium monitors system network changes (Wi-Fi switch, VPN toggle). When detected, it **marks all DNS cache entries as stale** and re-queries. However, simply changing what dnsmasq returns for a domain does NOT trigger a "network change" event. The network interface hasn't changed — only the DNS response content has.

### Firefox behavior

- Default DNS cache expiration: 60 seconds (`network.dnsCacheExpiration`)
- Respects TTL from DNS response, with minimum 60 seconds
- Same limitation: changing dnsmasq's response doesn't trigger a cache flush

### Safari behavior

- Uses the system resolver (mDNSResponder) more faithfully than Chromium
- Has its own internal cache, but generally re-queries faster than Chrome
- No public documentation on exact cache TTL behavior

### Does the local resolver solve the cache problem?

**Partially, but not completely.**

| Scenario | /etc/hosts approach | Local DNS resolver approach |
|----------|--------------------|-----------------------------|
| **Blocking a domain** | Immediate (hosts file checked on every lookup) | Immediate (resolver returns block response) |
| **Unblocking a domain** | Stale `0.0.0.0` in browser cache for 60s+ | Stale NXDOMAIN/0.0.0.0 in browser cache for 60s+ |
| **Flush system cache** | `dscacheutil -flushcache` clears OS cache, browser ignores it | No system cache to flush — resolver is authoritative — but browser still has its own cache |
| **TTL=0 effect** | N/A (hosts entries have no TTL) | dnsmasq sends TTL=0, but Chromium enforces 60s minimum |

**The 60-second Chromium floor is the fundamental constraint.** Neither approach can break below this. The local resolver approach has a theoretical advantage: when the browser DOES re-query (after its cache expires), it gets the updated response immediately from dnsmasq, without waiting for the macOS system cache to also expire. With `/etc/hosts`, there are two cache layers (browser + mDNSResponder). With the local resolver, there's effectively one (browser only, since dnsmasq responses are authoritative and instant).

**Practical improvement**: The local resolver should shave off a few seconds of staleness compared to `/etc/hosts` + system cache flush, but both approaches still have the 60-second browser cache floor. The real fix for instant unblocking remains closing stale browser tabs (which cc-focus already does) or using pf rules (which operate below DNS entirely).

### Where the resolver IS better

- **Blocking is more immediate**: dnsmasq responds authoritatively with no system cache lag
- **No cache flush needed**: No `dscacheutil -flushcache` / `killall -HUP mDNSResponder` ceremony
- **Wildcard blocking**: `address=/twitter.com/#` covers all subdomains automatically
- **Consistent behavior**: The resolver is a single source of truth, not a file that must be parsed by mDNSResponder

---

## 6. Integration Architecture

### How it would fit into cc-focus

```
┌─────────────────────────────────────────────┐
│                  cc-focus server             │
│               (localhost:8053)               │
│                                              │
│  POST /api/grant  →  update blocklist file   │
│                      SIGHUP dnsmasq          │
│                      remove pf rules         │
│                      close browser tabs      │
│                                              │
│  POST /api/block  →  update blocklist file   │
│                      SIGHUP dnsmasq          │
│                      add pf rules            │
│                                              │
│  expiry check     →  update blocklist file   │
│  (every 30s)         SIGHUP dnsmasq          │
│                      add pf rules            │
│                      kill connections         │
│                      close browser tabs       │
└──────────────┬──────────────────────────────┘
               │ IPC (unix socket)
┌──────────────▼──────────────────────────────┐
│              cc-focus daemon                 │
│            (runs as root)                    │
│                                              │
│  Manages:                                    │
│  - dnsmasq blocklist file (addn-hosts)       │
│  - dnsmasq process (SIGHUP for reload)       │
│  - pf rules (static + dynamic anchors)       │
│  - DNS watcher (re-apply 127.0.0.1)         │
│  - Connection killing (pfctl -k)             │
│  - Browser tab closing (AppleScript)         │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│              dnsmasq                         │
│         (127.0.0.1:53)                       │
│                                              │
│  Config:                                     │
│  - Main: /opt/homebrew/etc/dnsmasq.conf      │
│  - Static blocklist (address= directives):   │
│    /usr/local/etc/cc-focus/blocklists/*.conf  │
│  - Dynamic blocklist (addn-hosts):           │
│    /usr/local/etc/cc-focus/blocked-hosts      │
│  - Upstream: 1.1.1.1, 8.8.8.8 (blocked at   │
│    port 443 by pf, accessible on port 53)    │
└─────────────────────────────────────────────┘
```

### Grant/revoke flow

**Grant (unblock) a domain:**
1. Server receives `POST /api/grant {domain: "reddit.com", minutes: 5}`
2. Daemon removes `reddit.com` entries from `/usr/local/etc/cc-focus/blocked-hosts`
3. Daemon sends `SIGHUP` to dnsmasq (clears cache, re-reads hosts file)
4. Daemon removes pf rules for reddit.com IPs
5. Daemon closes stale browser tabs showing reddit.com
6. Next DNS query for reddit.com: dnsmasq forwards to upstream, returns real IP

**Revoke (re-block) a domain:**
1. Expiry timer fires (or manual revoke)
2. Daemon adds `reddit.com` entries back to blocked-hosts file
3. Daemon sends `SIGHUP` to dnsmasq
4. Daemon adds pf rules for reddit.com IPs
5. Daemon kills existing connections (`pfctl -k`)
6. Daemon closes browser tabs

### Do we still need pf?

**Yes, absolutely.** The local resolver handles DNS-level blocking, but pf remains essential for:

1. **Instant enforcement on block**: pf `block return` sends TCP RST immediately. DNS blocking only takes effect on the next lookup (after browser cache expires).
2. **DoH/DoT prevention**: pf blocks port 853 and DoH provider IPs.
3. **IP-level blocking for major sites**: Static IP ranges for Twitter/Meta/TikTok/Netflix bypass all DNS concerns.
4. **Connection killing**: `pfctl -k` tears down existing TCP connections immediately.
5. **QUIC blocking**: Block UDP 443 to prevent HTTP/3 bypass.

The architecture is: **dnsmasq replaces /etc/hosts** (better wildcards, no cache flush needed, authoritative responses). **pf stays as-is** for IP-level enforcement and DoH prevention. Combined, they're more robust than either alone.

### 75K adult domain list — performance implications

dnsmasq handles large blocklists well. Pi-hole (a dnsmasq fork) routinely runs with 100K-500K blocked domains:

- **200K domains**: ~12 MB memory, fast startup
- **75K domains**: Estimated ~8-10 MB memory — negligible on a Mac
- **Lookup performance**: dnsmasq uses hash-table lookup, O(1) per query. 75K domains won't cause measurable latency.
- **SIGHUP reload**: Re-reads hosts file (the dynamic portion). Even 75K entries reload in <1 second. But if the 75K list is in a static conf file (loaded once at startup), SIGHUP doesn't touch it — only the dynamic addn-hosts file is re-read.

**Recommended split:**
- Static blocklist (75K adult domains): `address=` directives in `/usr/local/etc/cc-focus/blocklists/adult.conf`. Loaded on dnsmasq startup. Rarely changes. Full restart only when the list is updated.
- Dynamic blocklist (social media, news, etc.): `/usr/local/etc/cc-focus/blocked-hosts` in hosts format. Updated on every grant/revoke. Reloaded via SIGHUP.

---

## 7. Existing Projects Using This Approach

### Pi-hole

The most widely-deployed DNS-based ad/domain blocker. Runs pihole-FTL, a fork of dnsmasq.

- **Architecture**: dnsmasq on the LAN, all devices point their DNS at Pi-hole
- **Blocklist handling**: Blocklists are downloaded, compiled into dnsmasq config, and loaded. Uses `address=` directives for blocked domains.
- **Cache behavior**: DNS cache is part of dnsmasq. When Pi-hole admin whitelists a domain, it sends SIGHUP to dnsmasq to clear cache and reload. The cleared cache means the next query for the domain gets forwarded upstream.
- **Browser cache problem**: Pi-hole has the same issue — after whitelisting, the browser may still show the blocked response from its internal cache. Pi-hole's answer: "clear your browser cache." There is no better solution at the DNS layer.
- **TTL for blocked domains**: Configurable. Pi-hole sets `local-ttl=2` by default for blocked responses. This gives clients a very short cache window.
- **Relevance**: Validates that dnsmasq can handle large blocklists (millions of domains in some configurations). Does NOT solve the browser cache problem — confirms it's inherent to DNS-level blocking.

### NextDNS CLI

- **Architecture**: A DNS53-to-DoH proxy running locally. Listens on 127.0.0.1:53, forwards queries to NextDNS's cloud service over DoH.
- **macOS behavior**: Sets system DNS to 127.0.0.1 via `networksetup`. Has the same DNS persistence problem — network changes reset DNS. NextDNS CLI includes a built-in network watcher that re-applies DNS settings.
- **Blocking**: Handled server-side (in NextDNS's cloud). The local proxy just forwards. For cc-focus's use case, this is irrelevant — we need local blocking, not cloud-based.
- **DNS reset handling**: NextDNS CLI monitors system DNS changes and re-applies `127.0.0.1`. This is exactly the pattern cc-focus would need.

### dnscrypt-proxy

- **Architecture**: Local DNS proxy that supports DNSCrypt, DoH, and standard DNS. Runs on 127.0.0.1:53.
- **Domain blocking**: Has built-in domain blocking via `blocked_names_file` config. Uses pattern matching (wildcards, regex).
- **macOS install**: `brew install dnscrypt-proxy`. Runs as a LaunchDaemon.
- **Performance**: Go binary, lightweight. Handles large blocklists well.
- **Relevance**: dnscrypt-proxy could potentially replace dnsmasq as the local resolver. It has built-in domain blocking, TOML config, and is actively maintained. However, it's designed primarily as a privacy tool (encrypting DNS), not a blocking tool. dnsmasq is simpler and more predictable for our use case.

### DNSFilter (commercial, enterprise)

- **Original approach**: Set DNS to 127.0.0.1, ran a local proxy (loopback method). Same architecture we're evaluating.
- **What happened**: Apple progressively broke the loopback method from macOS 11 onwards. DNSFilter migrated to Apple's System Extension framework (NEDNSProxyProvider).
- **Key lesson**: The loopback DNS approach works today but Apple is trending away from it. DNSFilter's migration timeline: loopback worked until ~macOS 13 Ventura, became unreliable, forced migration to System Extensions by 2024.
- **Our situation**: cc-focus is a personal tool, not enterprise software. The loopback approach is currently functional on Sequoia. But if Apple further restricts it, we'd need to migrate. This is a long-term risk, not a short-term blocker.

---

## 8. Comparison: Local DNS vs /etc/hosts + pf

### Pros/Cons table

| Factor | /etc/hosts + pf (current) | Local DNS resolver (dnsmasq) + pf |
|--------|--------------------------|-----------------------------------|
| **Blocking instant** | Yes (hosts checked on each lookup) | Yes (resolver returns block response) |
| **Unblocking speed** | 60s+ (browser cache + system cache) | 60s (browser cache only, no system cache layer) |
| **Wildcard blocking** | No (must enumerate subdomains) | Yes (`address=/domain/#`) |
| **System cache flush needed** | Yes (dscacheutil + mDNSResponder kill) | No (resolver IS the cache) |
| **Reload mechanism** | Write file, flush cache | Write file, SIGHUP (cleaner) |
| **Additional process** | None (hosts is kernel-level) | dnsmasq process (must stay running) |
| **DNS persistence** | N/A (hosts is a file, always present) | Must maintain 127.0.0.1 DNS setting across network changes |
| **Failure mode if process dies** | Blocking continues (hosts file persists) | **All DNS breaks** (system points at dead resolver) |
| **75K domain performance** | Instant (kernel reads hosts file) | Instant (hash table lookup) |
| **Config complexity** | Low (write lines to a file) | Medium (dnsmasq config + DNS watcher + LaunchDaemon) |
| **DoH bypass** | Bypassed (browsers ignore hosts) | Bypassed (browsers ignore resolver) — mitigated by pf DoH blocking |
| **macOS update survival** | Hosts file may be reset by major updates | DNS settings reset; dnsmasq config survives |
| **Debugging** | Simple (`grep domain /etc/hosts`) | Moderate (`dig @127.0.0.1 domain`, check dnsmasq logs) |

### Does it solve the browser DNS cache problem?

**No, not fundamentally.** The browser's 60-second minimum internal cache is the bottleneck, and it exists regardless of whether the upstream is `/etc/hosts` or a local resolver. The resolver approach removes one layer of caching (the macOS system DNS cache), which may reduce staleness by a few seconds in practice, but the browser cache floor remains.

**What it DOES solve:**
- Eliminates the "flush system cache" ceremony (no more `dscacheutil -flushcache` + `killall -HUP mDNSResponder`)
- Wildcard subdomain blocking without explicit enumeration
- Cleaner reload mechanism (SIGHUP vs file write + cache flush)
- Single authoritative source for DNS responses

### New failure modes

1. **dnsmasq crashes → all DNS breaks.** With `/etc/hosts`, the hosts file persists even if the daemon dies. With a local resolver, if dnsmasq crashes, the system has no DNS. Must use `KeepAlive` in the LaunchDaemon plist and consider a fallback DNS (but adding a fallback DNS server defeats the blocking purpose — the system would bypass dnsmasq for the fallback).

2. **DNS setting resets → blocking bypassed silently.** Network changes can reset DNS to DHCP-provided servers. This is a silent failure — everything works, but blocking is gone. The DNS watcher daemon must catch and re-apply. Race condition: between the reset and the re-apply, DNS queries go upstream unblocked.

3. **Port 53 conflict.** If another process binds to port 53 (e.g., a VPN's DNS proxy), dnsmasq fails to start. `/etc/hosts` has no port conflict concern.

4. **Additional process to manage.** Another LaunchDaemon (dnsmasq) + another watcher (DNS settings). More moving parts = more things that can break.

---

## 9. Recommendation

### Assessment

The local DNS resolver approach is a **moderate improvement** over `/etc/hosts` for certain aspects (wildcard blocking, no cache flush ceremony, cleaner reload), but it **does not solve the core browser DNS cache problem** that motivated this investigation. The 60-second Chromium cache floor exists regardless of the DNS backend.

### What actually solves the browser cache problem

Looking at the evidence:
- **Closing stale browser tabs** (already implemented) — forces user to open a fresh tab, which triggers a new DNS lookup. Still subject to process-wide DNS cache, but effective in practice.
- **pf rule removal** (already implemented) — IP-level unblocking is instant, no cache involved.
- **NEFilterDataProvider** (the "proper" solution) — operates below DNS entirely, no cache issues. But requires Apple Developer entitlement, system extension, notarization.

### Should we proceed with the local DNS resolver?

**Yes, but as an incremental improvement, not a silver bullet.** The reasons to proceed:

1. **Wildcard blocking** eliminates subdomain enumeration — cleaner, more complete blocking.
2. **No cache flush ceremony** — removing dscacheutil/mDNSResponder kills simplifies the daemon code.
3. **DoH blocking via pf** should be added regardless — it's a standalone improvement that patches a real bypass vulnerability.
4. **Foundation for future work** — having a local resolver gives us programmatic control over DNS responses that could enable future features (e.g., delay-by-DNS — return a slow-responding CNAME for delayed domains).

But we must:
- Keep pf rules as the primary enforcement mechanism (instant, no cache issues)
- Keep browser tab closing for grant/unblock reliability
- Implement a robust DNS watcher for network change resilience
- Handle the dnsmasq-crash-means-no-DNS failure mode (KeepAlive, health checks)
- Accept that unblock latency is still ~60 seconds from the browser cache floor

### Implementation priority

1. **Add pf DoH/DoT blocking rules** (standalone improvement, no resolver needed)
2. **Install dnsmasq via Homebrew, configure for domain blocking**
3. **Migrate /etc/hosts blocking to dnsmasq** (keep hosts file as a fallback or remove it)
4. **Implement DNS settings watcher** (LaunchDaemon that re-applies 127.0.0.1 on network changes)
5. **Update daemon IPC** to write blocklist files + SIGHUP dnsmasq instead of editing /etc/hosts + flushing cache
6. **Add dnsmasq health monitoring** to the daemon (restart if crashed)

---

## 10. Sources

### dnsmasq and unbound
- [dnsmasq man page](https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html)
- [dnsmasq ArchWiki](https://wiki.archlinux.org/title/Dnsmasq)
- [dnsmasq Homebrew formula](https://formulae.brew.sh/formula/dnsmasq)
- [Setup dnsmasq on macOS (GitHub Gist)](https://gist.github.com/ogrrd/5831371)
- [Local wildcard DNS on macOS with dnsmasq (Simon Willison)](https://til.simonwillison.net/macos/wildcard-dns-dnsmasq)
- [Using dnsmasq to block DNS requests (AlBlue)](https://alblue.bandlem.com/2020/05/using-dnsmasq.html)
- [dnsmasq SIGHUP reload discussion (mailing list)](https://lists.thekelleys.org.uk/pipermail/dnsmasq-discuss/2014q1/008038.html)
- [dnsmasq conf-dir reload limitation (mailing list)](https://lists.thekelleys.org.uk/pipermail/dnsmasq-discuss/2010q3/004231.html)
- [Unbound memory exhaustion with large blocklists (GitHub #1127)](https://github.com/NLnetLabs/unbound/issues/1127)
- [Unbound v1.21.0 memory regression (GitHub #1129)](https://github.com/NLnetLabs/unbound/issues/1129)
- [Unbound memory reduction wishlist (GitHub #55)](https://github.com/NLnetLabs/unbound/issues/55)
- [Hagezi DNS blocklists integration guide](https://deepwiki.com/hagezi/dns-blocklists/5.8-integration-guides)

### Browser DNS caching
- [Chromium's DNS Cache (textslashplain)](https://textslashplain.com/2022/03/31/chromiums-dns-cache/)
- [A survey of DNS caching and TTL in end-user client software (Ctrl blog)](https://www.ctrl.blog/entry/dns-client-ttl.html)
- [Chromium 60-second minimum TTL discussion](https://groups.google.com/a/chromium.org/g/chromium-discuss/c/655ZTdxTftA)
- [DNS caching past TTL — Chrome Community](https://support.google.com/chrome/thread/215797774/dns-caching-past-ttl)
- [Firefox DNS TTL support (Bugzilla #151929)](https://bugzilla.mozilla.org/show_bug.cgi?id=151929)

### macOS DNS configuration
- [macOS: Using Custom DNS Resolvers (vNinja.net)](https://vninja.net/2020/02/06/macos-custom-dns-resolvers/)
- [Per-domain resolvers in macOS (invisiblethreat.ca)](https://invisiblethreat.ca/technology/2025/04/12/macos-resolvers/)
- [Per-Domain DNS Configuration in macOS (oriolrius.cat)](https://oriolrius.cat/2023/07/06/implementing-per-domain-dns-configuration-in-macos-using-resolver-configuration-files/)
- [macOS scutil man page (SS64)](https://ss64.com/mac/scutil.html)
- [SCDynamicStoreSetNotificationKeys (Apple Developer)](https://developer.apple.com/documentation/systemconfiguration/scdynamicstoresetnotificationkeys(_:_:_:))
- [How to Change DNS from Command Line on macOS (osxdaily)](https://osxdaily.com/2015/06/02/change-dns-command-line-mac-os-x/)
- [DNS resets to 127.0.0.1 fix (Chris Coyier)](https://chriscoyier.net/2025/06/28/one-fix-for-dns-setting-itself-on-restart-to-127-0-0-1/)

### DoH/DoT blocking
- [dibdot/DoH-IP-blocklists (GitHub)](https://github.com/dibdot/DoH-IP-blocklists)
- [jameshas/Public-DoH-Lists (GitHub)](https://github.com/jameshas/Public-DoH-Lists)
- [bambenek/block-doh (GitHub)](https://github.com/bambenek/block-doh)
- [Blocking DNS-over-HTTPS (Pi-hole discourse)](https://discourse.pi-hole.net/t/blocking-dns-over-https-doh/69404)
- [Block DoH with pfSense (jpgpi250)](https://jpgpi250.github.io/piholemanual/doc/Block%20DOH%20with%20pfsense.pdf)
- [How to block DoH traffic (Broadcom)](https://knowledge.broadcom.com/external/article/369322/how-to-block-dns-over-https-doh-traffic)
- [Why Some Apps Bypass DNS Filtering (CleanBrowsing)](https://cleanbrowsing.org/help/docs/why-some-apps-bypass-dns-filtering-and-how-to-handle-it/)

### Firefox DoH / canary domain
- [Firefox DNS over HTTPS (Mozilla)](https://support.mozilla.org/en-US/kb/firefox-dns-over-https)
- [DNS-over-HTTPS TRR documentation (Firefox Source Docs)](https://firefox-source-docs.mozilla.org/networking/dns/dns-over-https-trr.html)
- [How To Disable Firefox DoH on your network (Technitium)](https://blog.technitium.com/2020/07/how-to-disable-firefox-dns-over-https.html)
- [DoH canary domain not honored (Bugzilla #1614751)](https://bugzilla.mozilla.org/show_bug.cgi?id=1614751)

### Chrome Secure DNS
- [How to Secure Google Chrome: Disable Secure DNS (CleanBrowsing)](https://cleanbrowsing.org/help/docs/how-to-secure-google-chrome-disable-secure-dns-and-harden-browser-policies/)
- [Disable DoH on enterprise browsers (Akamai)](https://techdocs.akamai.com/etp/docs/disable-doh-browsers)

### Pi-hole and related projects
- [Pi-hole DNS cache documentation](https://docs.pi-hole.net/ftldns/dns-cache/)
- [Pi-hole DNS resolver documentation](https://docs.pi-hole.net/ftldns/dns-resolver/)
- [Pi-hole dnsmasq DNS Resolution and Caching (DeepWiki)](https://deepwiki.com/pi-hole/dnsmasq/3.1-dns-resolution-and-caching)
- [NextDNS CLI (GitHub)](https://github.com/nextdns/nextdns)
- [dnscrypt-proxy installation macOS (GitHub wiki)](https://github.com/DNSCrypt/dnscrypt-proxy/wiki/Installation-macOS)
- [dnscrypt-proxy example config](https://github.com/DNSCrypt/dnscrypt-proxy/blob/master/dnscrypt-proxy/example-dnscrypt-proxy.toml)

### DNSFilter macOS evolution
- [How DNSFilter adapted to macOS Network Security (DNSFilter)](https://help.dnsfilter.com/hc/en-us/articles/43021602300563-How-DNSFilter-adapted-to-macOS-Network-Security-Loopback-Method-vs-System-Extension)
- [macOS Security Features, Connectivity Impact (DNSFilter)](https://help.dnsfilter.com/hc/en-us/articles/44394179239699-macOS-Security-Features-Connectivity-Impact-Troubleshooting)

### pf firewall on macOS
- [Quick and easy pf rules on macOS (Neil Sabol)](https://blog.neilsabol.site/post/quickly-easily-adding-pf-packet-filter-firewall-rules-macos-osx/)
- [Setting up pf firewall on macOS (Medium)](https://iyanmv.medium.com/setting-up-correctly-packet-filter-pf-firewall-on-any-macos-from-sierra-to-big-sur-47e70e062a0e)
- [Blocking Outgoing IP on Mac Using PF (Medium)](https://medium.com/justmyfreak/blocking-outgoing-ip-on-mac-using-pf-ac12262248d2)
