# Existing Tools Deep Dive

Research report for cc-focus blocking backend rebuild. Focused on architecture, persistence mechanisms, and solutions to problems we've hit (browser DNS caching, DoH bypass, re-blocking reliability).

**Date**: 2026-02-12

---

## 1. SelfControl -- Deep Technical Analysis

**Repo**: https://github.com/SelfControlApp/selfcontrol
**Language**: Objective-C
**License**: GPL-3.0

### Architecture Overview

SelfControl uses a **dual-layer blocking strategy**: `/etc/hosts` manipulation + `pf` (Packet Filter) firewall rules. This is essentially identical to what cc-focus currently does, making SelfControl our closest architectural sibling.

The project has 4 main components:
1. **Main App** (`SelfControl.app`) -- GUI, user-facing timer/blocklist management
2. **CLI** (`selfcontrol-cli`) -- Command-line interface
3. **Privileged Daemon** (`selfcontrold`) -- Runs as root via `SMJobBless`, manages block lifecycle
4. **SelfControl Killer** -- Separate app specifically for removing stuck blocks

### The Daemon (`selfcontrold`) -- Key Pattern

**Source**: `/tmp/selfcontrol/Daemon/SCDaemon.m`

The daemon is the core of SelfControl's persistence model. It registers as a Mach service (`org.eyebeam.selfcontrold`) and runs as a LaunchDaemon with `KeepAlive: true`.

```xml
<!-- org.eyebeam.selfcontrold.plist -->
<key>Label</key>       <string>org.eyebeam.selfcontrold</string>
<key>RunAtLoad</key>    <true/>
<key>MachServices</key> <dict><key>org.eyebeam.selfcontrold</key><true/></dict>
<key>KeepAlive</key>    <true/>
```

**Checkup Timer Pattern**: The daemon runs a 1-second repeating timer (`startCheckupTimer`) that calls `checkupBlock` every second. This is aggressive but guarantees near-instant detection of:
- Block expiration (removes block immediately)
- Tampering detection (re-adds rules if missing)
- Settings changes

Every 15 seconds within the checkup, a deeper **integrity check** runs (`checkBlockIntegrity`) that:
1. Checks if the pf anchor still contains SelfControl rules
2. Checks if `/etc/hosts` still contains the SelfControl block section
3. If either is missing: clears everything, re-installs all block rules from settings

**Inactivity Timer**: The daemon self-terminates after 2 minutes of inactivity (no block running, no XPC calls). This avoids leaving unnecessary processes running when not blocking.

### FSEventStream Usage

**Source**: `/tmp/selfcontrol/Common/SCFileWatcher.m`

SelfControl watches `/etc/hosts` using `FSEventStreamCreate` with these flags:
- `kFSEventStreamCreateFlagFileEvents` -- file-level events (not just directory)
- `kFSEventStreamCreateFlagMarkSelf` / `kFSEventStreamCreateFlagIgnoreSelf` -- ignores its own writes
- Throttle: 1.5 seconds

When `/etc/hosts` changes and a block is active, it triggers `checkBlockIntegrity` immediately (rather than waiting for the 15-second interval). This is a reactive guard against manual hosts file tampering.

**Lesson for cc-focus**: We should add FSEventStream monitoring of `/etc/hosts` as a complement to our periodic checks. It provides near-instant re-blocking when someone (or some process) tampers with the hosts file.

### Dual-Layer Blocking: Hosts + PF

**Source**: `/tmp/selfcontrol/Block Management/BlockManager.m`, `HostFileBlocker.m`, `PacketFilter.m`

**Hosts file blocking**:
- Uses `0.0.0.0` and `::` (IPv6) as the sinkhole address (not `127.0.0.1`)
- Wraps rules in markers: `# BEGIN SELFCONTROL BLOCK` / `# END SELFCONTROL BLOCK`
- Creates a backup of `/etc/hosts` before modification (`/etc/hosts.bak`)
- Thread-safe via `NSLock` for concurrent domain additions
- On failure to remove the block section, restores from backup

**PF firewall blocking**:
- Creates an anchor file at `/etc/pf.anchors/org.eyebeam`
- Adds anchor reference to `/etc/pf.conf`: `anchor "org.eyebeam"` + `load anchor "org.eyebeam" from "/etc/pf.anchors/org.eyebeam"`
- Uses `block return out proto tcp/udp from any to <IP>` rules
- Stores the PF token at `/etc/SelfControlPFToken` for clean disable later
- Supports "append mode" -- adding rules to an already-active block without restart
- Flushes states with `-F states` when activating rules

**Critical difference from cc-focus**: SelfControl uses `block return` (sends RST/ICMP unreachable), not `block drop` (silent timeout). `block return` gives faster feedback to the user that the site is blocked.

### DNS Resolution Approach

**Source**: `BlockManager.m`, `+ipAddressesForDomainName:`

SelfControl resolves every domain to its IP addresses at block-start time using `CFHostStartInfoResolution`. These IPs become pf rules. This means:
- IP-level blocking persists even if the browser uses DoH (the resolved IPs at block-start are blocked at the firewall level)
- However, if a domain changes IPs after the block starts, the new IPs are NOT blocked
- Google gets special handling: instead of resolving, it adds Google's entire published IP range (50+ CIDR blocks including IPv6) because Google properties share IPs and resolving one domain would miss others

This is a 35-thread concurrent operation queue for DNS lookups. Slow lookups (>2.5s) are logged.

**Lesson for cc-focus**: We should resolve domains to IPs at block time and add pf rules for the resolved IPs. This provides a second layer that works even when browser DNS caching or DoH bypass the hosts file. We should also consider pre-computing IP ranges for major platforms (Google, Meta, etc.).

### Anti-Circumvention Measures

1. **Checkup timer (1s)**: Catches removed rules almost immediately
2. **FSEventStream on /etc/hosts**: Catches hosts file tampering within 1.5s
3. **Settings file protection**: Settings are stored at `/usr/local/etc/.<sha1>.plist` (root-owned, permission 0755, hidden dot-file with hashed name)
4. **XPC code signing validation**: The daemon rejects XPC connections from anything not signed by the SelfControl developer certificate, with a minimum version requirement (v4.07+)
5. **Dual-layer blocking**: Even if hosts are cleared, pf rules remain
6. **Backup hosts file**: Can restore if the block section gets corrupted
7. **Tampering detection**: If settings show no block but rules exist on system, it clears everything and flags tampering

**What does NOT survive**: Rebooting after uninstalling the app (the LaunchDaemon plist is inside the app bundle, so removing the app removes the daemon). This is a known limitation acknowledged in the FAQ.

### DNS Cache Clearing

**Source**: `/tmp/selfcontrol/Common/Utility/SCHelperToolUtilities.m`

SelfControl clears DNS caches when starting a block (if "ClearCaches" preference is set):
1. `dscacheutil -flushcache` -- flushes the system DNS cache
2. `killall -HUP mDNSResponder` -- restarts macOS DNS resolver
3. `killall mDNSResponderHelper` -- kills the helper process
4. Deletes browser cache directories for Chrome, Firefox, and Safari

**Known issues from SelfControl FAQ**:
- Firefox DoH (enabled by default since 2020) bypasses hosts-file blocking. Users must restart Firefox after each block start.
- VPNs completely bypass SelfControl's blocking. "This is not technically feasible, unfortunately."
- Browser DNS caches can cause blocks to not take effect immediately or to persist after expiration.

### Key Takeaways for cc-focus

| What they do well | What we can improve on |
|---|---|
| 1-second checkup timer catches tampering fast | Their 1s timer is aggressive; our 30s interval is too slow though |
| FSEventStream provides reactive hosts file monitoring | We should add this -- complements our interval-based checks |
| Dual-layer hosts + pf is battle-tested | We already do this; should adopt their `block return` instead of `block drop` |
| DNS resolution to IPs at block-start | We should add IP-based pf rules for blocked domains |
| Browser cache clearing at block start | We do `killall -HUP mDNSResponder` but should also clear browser caches |
| Root-owned hashed settings file | Our settings file security could be hardened similarly |

---

## 2. LuLu -- NEFilterDataProvider Implementation

**Repo**: https://github.com/objective-see/LuLu
**Language**: Objective-C
**License**: GPL-3.0

LuLu is an open-source macOS firewall by Patrick Wardle (Objective-See). It uses NEFilterDataProvider, which is the exact API we'd need for a "system extension" approach to blocking.

### Project Structure

The Xcode workspace contains 2 native targets:
1. **LuLu** (App) -- The container application with UI, preferences, rule management UI
2. **Extension** -- The NEFilterDataProvider system extension that intercepts all network flows

Plus a `Shared/` directory for code shared between the two, and a `Tests/` directory.

### How the NEFilterDataProvider Subclass Works

**Source**: `/tmp/lulu/LuLu/Extension/FilterDataProvider.m`

The `FilterDataProvider` class extends `NEFilterDataProvider` and overrides three key methods:

**`startFilterWithCompletionHandler:`**
Sets up a single catch-all filter rule that intercepts ALL outbound traffic:
```objc
// Match any/all outbound traffic
networkRule = [[NENetworkRule alloc] initWithRemoteNetwork:nil remotePrefix:0
    localNetwork:nil localPrefix:0 protocol:NENetworkRuleProtocolAny
    direction:NETrafficDirectionOutbound];
filterRule = [[NEFilterRule alloc] initWithNetworkRule:networkRule action:NEFilterActionFilterData];
filterSettings = [[NEFilterSettings alloc] initWithRules:@[filterRule] defaultAction:NEFilterActionAllow];
```

This means every outbound flow triggers `handleNewFlow:`, where the actual allow/block decision is made.

**`handleNewFlow:`**
The main decision point. For each `NEFilterSocketFlow`:
1. Skips non-outbound traffic (sometimes inbound leaks through despite the filter config)
2. Calls `processEvent:` which runs through a priority chain of checks

**`processEvent:`** -- The decision chain (in order):
1. Is the filter disabled? -> Allow
2. Is the app in "block all" mode? -> Drop (unless item is on allow list)
3. Is this on the global block list? -> Drop
4. Is this on the global allow list? -> Allow
5. Does an existing rule match this process+endpoint? -> Apply rule's action
6. Is the app in passive mode? -> Apply default action (allow or block) and optionally create rule
7. Is it an Apple-signed process and "Allow Apple" is on? -> Allow (unless graylisted like `curl`)
8. Is it a pre-installed app and "Allow Installed" is on? -> Allow
9. Is this DNS traffic (UDP port 53) and "Allow DNS" is on? -> Allow
10. No rule found -> Pause flow, deliver alert to user via XPC, wait for response

Verdicts:
- `[NEFilterNewFlowVerdict allowVerdict]` -- let it through
- `[NEFilterNewFlowVerdict dropVerdict]` -- silently block
- `[NEFilterNewFlowVerdict pauseVerdict]` -- hold the flow until a decision is made (used for user prompts)

### Flow Metadata Available

The extension inspects several pieces of metadata for each flow:

- **Process**: Extracted from `flow.sourceAppAuditToken` (audit token -> PID -> path -> code signing info)
- **Remote endpoint**: `flow.remoteEndpoint` (NWHostEndpoint with hostname + port)
- **URL**: `flow.URL` (includes host, available for HTTP flows)
- **Remote hostname**: `flow.remoteHostname` (macOS 11+, often contains SNI from TLS)
- **Protocol**: `flow.socketProtocol` (TCP, UDP, etc.)
- **Socket family**: `flow.socketFamily` (AF_INET, AF_INET6)
- **Direction**: `flow.direction` (outbound/inbound)

**Critical insight for cc-focus**: `flow.remoteHostname` (macOS 11+) and `flow.URL.host` give us the **domain name** the browser is connecting to, even for HTTPS connections. This means NEFilterDataProvider can make blocking decisions based on domain names without needing to do DNS resolution or inspect packet contents. This completely bypasses the DoH problem.

### Block/Allow List Matching

**Source**: `/tmp/lulu/LuLu/Extension/BlockOrAllowList.m`

LuLu loads block/allow lists from files (local or remote URLs). The matching logic:
1. Collects all possible names for the flow's remote endpoint: `flow.URL.absoluteString`, `flow.URL.host`, `remoteEndpoint.hostname`, `flow.remoteHostname`
2. Lowercases everything
3. Strips `www.` prefix for additional matching
4. Does a set intersection between collected names and the block/allow list
5. Also supports wildcard matches: `0.0.0.0/0` (block all IPv4) and `::/0` (block all IPv6)

Lists auto-reload when the file modification timestamp changes.

### XPC Communication: App <-> Extension

LuLu uses a bidirectional XPC setup:

**Extension -> App (daemon -> user)**:
- Mach service: `com.objective-see.lulu.daemon` (via `XPCListener`)
- The extension exports `XPCDaemonProtocol` (rules CRUD, preferences, profiles)
- The extension sets `remoteObjectInterface` to `XPCUserProtocol` (alert delivery, rule change notifications)

**App -> Extension (user -> daemon)**:
- The app connects to the Mach service
- Can send: `getPreferences`, `updatePreferences`, `getRules`, `addRule`, `deleteRule`, `toggleRule`, `importRules`, `cleanupRules`

**Code signing validation**: The extension verifies the connecting app's code signature using `SecCodeCopyGuestWithAttributes` + `SecTaskValidateForRequirement`, checking for hardened runtime (`CS_RUNTIME`), the correct bundle identifier, and the correct signing certificate.

### Entitlements

**Extension** (`Extension.entitlements`):
```xml
<key>com.apple.developer.networking.networkextension</key>
<array>
    <string>content-filter-provider-systemextension</string>
</array>
<key>com.apple.security.application-groups</key>
<array>
    <string>$(TeamIdentifierPrefix)com.objective-see.lulu</string>
</array>
```

**App** (`App.entitlements`):
```xml
<key>com.apple.developer.networking.networkextension</key>
<array>
    <string>content-filter-provider-systemextension</string>
</array>
<key>com.apple.developer.system-extension.install</key>
<true/>
<key>com.apple.security.application-groups</key>
<array>
    <string>$(TeamIdentifierPrefix)com.objective-see.lulu</string>
</array>
```

Key requirements:
- Both the app and extension need the `content-filter-provider-systemextension` entitlement
- The app additionally needs `com.apple.developer.system-extension.install` to install the extension
- Both share an application group for data exchange
- For distribution: the entitlement value needs the `-systemextension` suffix (vs. `-systemextension` for development)
- **Requires a paid Apple Developer account** and specific entitlement approval from Apple

### Known Limitation: Apple App Bypass

A significant and well-documented issue: some Apple system apps bypass NEFilterDataProvider entirely. This was a major controversy when Big Sur shipped -- Apple's own apps (App Store, Maps, etc.) had a hardcoded exclusion list that bypassed all content filters and VPNs. While Apple has reduced this list over time, it's worth knowing that NEFilterDataProvider may not catch 100% of traffic.

### Key Takeaways for cc-focus

| Advantage | Challenge |
|---|---|
| Domain-based blocking that works with DoH | Requires Apple Developer Program ($99/year) |
| Can block per-app, per-domain, per-port | Requires user to approve system extension in System Preferences |
| No DNS cache problems -- intercepts at the flow level | Apple apps may bypass the filter |
| Process identification via audit token | More complex build/signing/distribution pipeline |
| Can pause flows and make async decisions | ~1000 lines of filtering logic just for the extension |
| Survives DNS resolver changes | Binary must be signed + notarized for distribution |

---

## 3. Hblock / StevenBlack Hosts

### How Large Hosts-File Blockers Work

**hblock** (https://github.com/hectorm/hblock): A POSIX shell script that aggregates 100,000+ domains from multiple blocklist sources into `/etc/hosts`, redirecting them to `0.0.0.0`.

**StevenBlack/hosts** (https://github.com/StevenBlack/hosts): A Python-based aggregator that merges several well-curated hosts lists. The unified list contains 100,000+ domains.

### Performance at Scale

The `/etc/hosts` file is loaded into memory by the system resolver. Performance characteristics:

- **macOS**: An old Apple Community thread (https://discussions.apple.com/thread/2209460) reports that large hosts files (100K+ entries) can cause noticeable DNS resolution delays on macOS. The system resolver (`mDNSResponder`) must do a linear scan of the hosts file for each lookup.
- **Windows**: StevenBlack's issue tracker (https://github.com/StevenBlack/hosts/issues/2094) documents serious problems with large hosts files on Windows 11 -- the DNS Client service can slow to a crawl or fail entirely.
- **Linux**: Generally handles large hosts files better via `nsswitch.conf` and glibc, but still O(n) per lookup.

**hblock optimizations**:
- Outputs one IP per line (no multi-host lines)
- Strips comments and whitespace
- Deduplicates entries
- No background processes or memory overhead beyond the file itself

**cc-focus relevance**: Our blocklist is small (< 200 domains), so `/etc/hosts` performance is not a concern for us. But this is good to know if we ever support community-contributed blocklists.

### Browser DNS Cache Problem

This is the elephant in the room for all hosts-file-based blockers.

**The problem**: Modern browsers (Chrome, Firefox, Safari) maintain their own DNS caches independent of the OS. When cc-focus adds a domain to `/etc/hosts`, the browser may continue resolving the domain from its internal cache for minutes. This is the exact bug documented in our `dns-cache-bug.md`.

**How the community addresses it**:
- **StevenBlack**: Does not address it. Their README and wiki make no mention of browser DNS caching.
- **hblock**: Does not address it.
- **General advice**: "Restart your browser" is the standard recommendation.

**DoH bypass** is the other critical issue. StevenBlack has a dedicated issue (https://github.com/StevenBlack/hosts/issues/968) documenting how Firefox's DoH completely bypasses hosts-file blocking. Their recommended workaround: set `network.trr.mode` to `5` (disable DoH) in Firefox's `about:config`. Chrome: `chrome://flags/#dns-over-https` set to disabled.

**Key insight**: Hosts-file-only blocking is fundamentally unreliable in 2026. Every major browser now has DoH enabled or is rolling it out. The hosts file approach must be supplemented by either:
1. PF firewall rules with resolved IPs (SelfControl's approach)
2. NEFilterDataProvider (LuLu's approach)
3. A local DNS resolver that the system is configured to use

---

## 4. Focus Firewall

**Website**: https://focusfirewall.com
**Platform**: macOS App Store
**Price**: Paid (subscription or one-time purchase)

### What We Know

Focus Firewall is a macOS-native website blocker that claims "system-level blocking without browser extensions." Based on its App Store listing and reviews:

- Blocks 155+ websites and 8 apps across all browsers and macOS apps
- Pre-loaded with 7 curated categories (social media, news, entertainment, etc.)
- Claims < 100MB RAM usage
- Native macOS design
- No browser extension required

### Technical Implementation (Inferred)

Given that Focus Firewall:
- Is distributed via the Mac App Store
- Requires no browser extensions
- Works across all browsers and apps
- Claims system-level blocking

It almost certainly uses **NEFilterDataProvider** via a system extension. This is the only Mac App Store-compatible mechanism that provides application-level network filtering without kernel extensions or browser extensions. The App Store requirements rule out `/etc/hosts` manipulation (requires root) or pf firewall rules (requires root).

The entitlement `com.apple.developer.networking.networkextension` with value `content-filter-provider-systemextension` is the mechanism. Apps distributed through the App Store can use this with proper entitlements.

### User Reviews and Reliability

From MacSources review (May 2025): "Focus Firewall excels in offering a beautifully simple and unobtrusive tool for cutting out online distractions."

No public technical deep dives, bypass reports, or reliability complaints found in searches. The closed-source nature makes it impossible to study the implementation.

### Relevance for cc-focus

Focus Firewall validates the NEFilterDataProvider approach for a focus/blocking product. If we move to a system extension approach, we'd be in the same technical category. However, the NEFilterDataProvider approach requires:
- Apple Developer Program membership
- Entitlement approval from Apple
- App Store distribution (or Developer ID signing + notarization)
- User must approve the system extension in System Preferences

---

## 5. mitmproxy -- NETransparentProxyProvider

**Repo**: https://github.com/mitmproxy/mitmproxy_rs
**Relevant dir**: `mitmproxy-macos/redirector/`
**Language**: Swift (network extension) + Rust (proxy core)

### Architecture

mitmproxy uses `NETransparentProxyProvider` (not `NEFilterDataProvider`) for its macOS local capture mode. The key difference:

- **NEFilterDataProvider**: Can inspect and make allow/drop decisions on flows. Cannot modify data.
- **NETransparentProxyProvider**: Can intercept flows and redirect them through a proxy. Can read/modify data.

mitmproxy chose NETransparentProxyProvider because `NEPacketTunnelProvider` (the other option) doesn't fill in `sourceAppAuditToken`, meaning you can't identify which process originated the flow.

### How It Works

The `TransparentProxyProvider.swift` implementation:

1. **startProxy()**: Establishes a Unix socket control channel to communicate interception specs with the Python/Rust mitmproxy process. Applies `NETransparentProxyNetworkSettings` that capture outbound traffic.

2. **handleNewFlow()**: For each new flow:
   - Extracts process info from the audit token (PID, path)
   - Checks if the flow matches interception criteria (process, destination, protocol)
   - If intercepting: opens the flow, creates a local Unix socket connection to mitmproxy, and establishes bidirectional data copying between the original flow and the proxy

3. **IPC**: Uses protobuf over Unix sockets for communication between the Swift network extension and the Rust proxy backend.

### Complexity Assessment

The `redirector/` directory contains:
- An Xcode project with the app bundle + network extension
- IPC protobuf definitions
- Swift source for `TransparentProxyProvider`
- Swift extensions for flow data copying (`FlowExtensions.swift`)

This is more complex than NEFilterDataProvider because it needs to handle actual data tunneling, not just allow/drop decisions. For a blocker, NEFilterDataProvider is sufficient and simpler.

### Entitlement Differences

NETransparentProxyProvider requires different entitlements than NEFilterDataProvider:
- `com.apple.developer.networking.networkextension` with value `app-proxy-provider-systemextension`

Additionally, mitmproxy has reported needing `com.apple.developer.endpoint-security.client` in some configurations, which is a more restricted entitlement.

### Relevance for cc-focus

NETransparentProxyProvider is **overkill for our use case**. We don't need to proxy or modify traffic -- we just need to allow or block flows. NEFilterDataProvider is the correct API for a website blocker. However, the mitmproxy implementation demonstrates:

- How to structure a Swift network extension project
- IPC patterns between a host process and a network extension
- The signing/notarization requirements for distributing system extensions

---

## 6. Pi-hole Architecture

**Docs**: https://docs.pi-hole.net
**Engine**: pihole-FTL (fork of dnsmasq)

### How It Handles Blocking

Pi-hole operates as a **DNS sinkhole**: it runs a DNS server (pihole-FTL, based on dnsmasq) that responds to queries for blocked domains with `0.0.0.0` (or `NXDOMAIN`), while forwarding legitimate queries upstream.

The blocklist ("gravity") is compiled from multiple community-maintained lists and loaded into FTL's memory at startup.

### Handling Large Blocklists

**Scale**: Pi-hole can handle hundreds of thousands of domains. Users report challenges with millions:
- Pi-hole v6 requires significantly more RAM for large domain trees vs v5 (https://github.com/pi-hole/pi-hole/issues/5904)
- 5 million domains can consume 85% of available RAM on a Raspberry Pi
- Restart/reload time increases linearly with domain count (up to 2 minutes for large lists)

**Data structure**: FTL uses an in-memory tree structure for fast domain lookups, which is more memory-hungry than a simple hash set but enables wildcard/subdomain matching.

### DNS Caching and TTLs

**Source**: https://docs.pi-hole.net/ftldns/dns-cache/

Pi-hole's cache behavior is critical for understanding real-time block/unblock:

- **Cache size**: Default 10,000 entries. FTL tracks evictions; if evictions > 0, cache should be increased.
- **Blocked domain TTL**: `dns.cache.upstreamBlockedTTL` defaults to 86,400 seconds (1 day). Once a blocked response is cached, re-checking upstream won't happen until this TTL expires.
- **Normal TTL**: Respected from upstream DNS responses.
- **Cache optimizer**: `dns.cache.optimizer` (default 3600s / 1 hour) allows serving slightly-stale cached data while refreshing in the background.

**Real-time unblocking effectiveness**: When you unblock a domain in Pi-hole, the change takes effect almost immediately for NEW queries. However, if a client (browser, OS) has cached the blocked response (`0.0.0.0`), it will continue seeing the block until its local cache expires. Pi-hole recommends using short TTLs (e.g., 2 seconds) for blocked responses to minimize this window.

### Lessons for a Local DNS Resolver Option

If cc-focus ever implements a local DNS resolver for blocking:

1. **Use very short TTLs for blocked responses** (2-5 seconds). This ensures that when a domain is unblocked, the change propagates quickly. Pi-hole's default of 86,400 seconds is terrible for a dynamic block/unblock workflow.

2. **Flush the system DNS cache on block/unblock changes**: `killall -HUP mDNSResponder` on macOS. This clears the OS-level cache but NOT browser-level caches.

3. **The browser DNS cache problem persists**: Even with a local DNS resolver, Chrome and Firefox maintain their own caches. A DNS resolver alone does not solve this.

4. **Memory is manageable for small lists**: Pi-hole's memory issues only appear at 100K+ domains. Our ~200 domain blocklist would consume negligible memory.

5. **Consider `unbound` or `dnscrypt-proxy` over raw dnsmasq**: These support DNSSEC and can enforce that all DNS queries go through the local resolver, making it harder for browsers to bypass via DoH.

---

## Cross-Cutting Analysis

### The DoH Problem -- How Each Tool Handles It

| Tool | DoH Protection | Mechanism |
|---|---|---|
| SelfControl | Partial | IP-based pf rules catch connections even with DoH, but only for IPs resolved at block-start |
| LuLu (NEFilterDataProvider) | Full | Intercepts at the flow level; domain info available from SNI/flow metadata regardless of DNS method |
| Hosts-file blockers | None | DoH completely bypasses `/etc/hosts` |
| Pi-hole | Partial | Only works if the browser uses Pi-hole as its DNS resolver (DoH bypasses this) |
| Focus Firewall | Full (inferred) | Likely NEFilterDataProvider, same as LuLu |
| cc-focus (current) | Partial | PF rules provide some coverage, but not tied to resolved IPs |

### The Browser DNS Cache Problem

| Tool | Solution |
|---|---|
| SelfControl | Clears browser cache directories + flushes OS DNS cache at block start |
| LuLu | Not applicable -- intercepts at flow level, not DNS level |
| Hosts-file blockers | None; recommend "restart browser" |
| Pi-hole | Short TTLs (2s) for blocked responses minimize the window |
| cc-focus (current) | `killall -HUP mDNSResponder` -- but doesn't clear browser caches |

### Persistence and Anti-Tampering

| Tool | Persistence Mechanism | Anti-Tampering |
|---|---|---|
| SelfControl | Root LaunchDaemon with KeepAlive | 1s checkup timer + FSEventStream on hosts file + settings integrity checks |
| LuLu | macOS System Extension (managed by OS) | Extension runs in isolated sandbox; rules stored in protected directory |
| Pi-hole | Runs as a service (systemd/init) | N/A (not anti-tamper by design) |
| cc-focus (current) | Node.js server + launchd | Periodic re-blocking via API, no file watching |

---

## Recommended Architecture Changes for cc-focus

Based on this research, ranked by impact and feasibility:

### Immediate (No API changes needed)

1. **Add FSEventStream monitoring of `/etc/hosts`**: Reactive detection of hosts file tampering, trigger re-block within 1.5s. Pattern directly from SelfControl's `SCFileWatcher.m`.

2. **Resolve domains to IPs at block time and add pf rules**: This is SelfControl's key insight. When blocking `twitter.com`, resolve its IPs and add `block return out proto tcp from any to <IP>` rules. This provides firewall-level blocking that survives DoH.

3. **Switch pf rules from `block drop` to `block return`**: Gives faster user feedback (connection refused vs. timeout).

4. **Clear browser caches at block start**: Delete Chrome/Firefox/Safari cache directories, same paths as SelfControl. Critical for preventing stale DNS cache from bypassing new blocks.

5. **Shorten the checkup interval**: Our 30-second interval is too slow. SelfControl uses 1 second. A 5-second interval would be a good balance for cc-focus.

### Medium-term (Significant effort)

6. **Investigate NEFilterDataProvider**: This is the only approach that fully solves the DoH problem. However, it requires:
   - Apple Developer Program membership ($99/year)
   - Entitlement approval from Apple for `content-filter-provider-systemextension`
   - Building a macOS app bundle with an embedded system extension
   - User approval in System Preferences

7. **Consider a local DNS resolver with enforcement**: Run a local DNS resolver (e.g., `dnscrypt-proxy`) that blocks configured domains, and use pf rules to redirect all DNS traffic (port 53, 443 for DoH) through it. This provides DNS-level blocking that can't be bypassed by browser DoH settings.

### Architecture Pattern Worth Adopting

SelfControl's **"check, detect, re-apply"** pattern is elegant:
1. Daemon runs a frequent timer
2. Each tick: check if block rules exist where they should
3. If rules are missing: re-apply them from saved settings
4. Also watch files reactively for faster detection

This makes the system self-healing. Even if something removes the block rules, they get re-applied within seconds. cc-focus's current model of "apply once and hope" is fragile by comparison.

---

## Source Links

### SelfControl
- Repo: https://github.com/SelfControlApp/selfcontrol
- FAQ / Known Issues: https://github.com/SelfControlApp/selfcontrol/wiki/FAQ
- Issue: Website not blocked despite being on blocklist: https://github.com/SelfControlApp/selfcontrol/issues/680

### LuLu
- Repo: https://github.com/objective-see/LuLu
- FilterDataProvider.m: https://github.com/objective-see/LuLu/blob/master/LuLu/Extension/FilterDataProvider.m
- Extension entitlements: https://github.com/objective-see/LuLu/blob/master/LuLu/Extension/Extension.entitlements
- Apple apps bypassing NEFilterDataProvider: https://news.ycombinator.com/item?id=25113039

### mitmproxy
- mitmproxy_rs repo: https://github.com/mitmproxy/mitmproxy_rs
- macOS local capture docs: https://www.mitmproxy.org/posts/local-capture/macos/
- Network extension README: https://github.com/mitmproxy/mitmproxy_rs/blob/main/mitmproxy-macos/README.md

### StevenBlack / hblock
- StevenBlack hosts: https://github.com/StevenBlack/hosts
- DoH bypass issue: https://github.com/StevenBlack/hosts/issues/968
- hblock: https://github.com/hectorm/hblock

### Pi-hole
- DNS cache docs: https://docs.pi-hole.net/ftldns/dns-cache/
- FTL memory issues with large lists: https://github.com/pi-hole/pi-hole/issues/5904
- Cache optimizer issue: https://github.com/pi-hole/FTL/issues/2608

### Focus Firewall
- Website: https://focusfirewall.com
- MacSources review: https://macsources.com/focus-firewall-mac-app-review/
- MacSparky review: https://www.macsparky.com/blog/2025/05/focus-without-fuss-focus-firewall-for-macos-sponsor/

### Apple Developer Documentation
- NEFilterDataProvider: https://developer.apple.com/documentation/networkextension/nefilterdataprovider
- NETransparentProxyProvider: https://developer.apple.com/documentation/NetworkExtension/NETransparentProxyProvider
- System Extensions: https://developer.apple.com/documentation/systemextensions
