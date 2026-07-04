# macOS Website Blocking: Comprehensive Approach Comparison

Research compiled 2026-02-12 for cc-focus.

---

## Table of Contents

1. [/etc/hosts File Modification](#1-etchosts-file-modification) (cc-focus current primary)
2. [pf (Packet Filter) Firewall Rules](#2-pf-packet-filter-firewall-rules) (cc-focus current secondary)
3. [Network Extension: Content Filter (NEFilterDataProvider)](#3-network-extension-content-filter-nefilterdataprovider)
4. [Network Extension: DNS Proxy (NEDNSProxyProvider)](#4-network-extension-dns-proxy-nednsproxyprovider)
5. [Network Extension: Transparent Proxy (NETransparentProxyProvider)](#5-network-extension-transparent-proxy-netransparentproxyprovider)
6. [Browser Extensions](#6-browser-extensions)
7. [macOS Screen Time / FamilyControls API](#7-macos-screen-time--familycontrols-api)
8. [Custom Local DNS Resolver (dnsmasq / unbound)](#8-custom-local-dns-resolver-dnsmasq--unbound)
9. [Local HTTP/HTTPS Proxy (MITM)](#9-local-httphttps-proxy-mitm)
10. [Comparison Matrix](#10-comparison-matrix)
11. [Existing Open-Source / Commercial Blockers](#11-existing-open-source--commercial-blockers)
12. [Recommendations for cc-focus](#12-recommendations-for-cc-focus)

---

## 1. /etc/hosts File Modification

**What cc-focus currently uses as its primary blocking layer.**

### Mechanism

The system resolves hostnames by checking `/etc/hosts` before querying DNS servers. By mapping blocked domains to `0.0.0.0` (or `::` for IPv6), the OS-level resolver returns a null route for those hostnames. All applications using the system resolver — including browsers — will fail to connect.

```
0.0.0.0 twitter.com
:: twitter.com
0.0.0.0 www.twitter.com
:: www.twitter.com
```

After editing, the DNS cache must be flushed:
```bash
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder
```

### Reliability

**Medium.** The hosts file is respected by macOS's `mDNSResponder`, and by default all major browsers use the system resolver, so they will honor it. However:

- **DNS caching**: Browsers maintain their own DNS caches. Chrome has an internal cache at `chrome://net-internals/#dns`. After updating hosts, the browser may keep using the old (working) IP for minutes unless the cache is flushed or the browser is restarted.
- **DNS over HTTPS (DoH)**: If a browser enables DoH/Secure DNS, all DNS queries go directly to a remote resolver (e.g., Cloudflare 1.1.1.1, Google 8.8.8.8) over HTTPS, completely bypassing `/etc/hosts`. Chrome does NOT enable DoH by default, but Firefox does (via `network.trr.mode=2` in the US). A user who knows this can turn it on to bypass hosts-based blocking.
- **QUIC/HTTP3**: Not directly relevant — QUIC still requires DNS resolution, so hosts blocking works. But once a connection is established via QUIC (UDP), killing it is harder than TCP.
- **Existing connections**: Changing hosts does NOT kill already-established TCP/TLS connections. A browser tab with an open connection to twitter.com will keep working until the connection drops.

### Granularity

**Domain-level, immediate toggle.** Adding or removing a line in `/etc/hosts` is instant. cc-focus's daemon already supports per-domain grant/revoke through the unix socket API. Subpath blocking (e.g., block youtube.com/shorts but allow youtube.com/watch) is impossible — it's all-or-nothing per hostname.

### Requirements

- **Root access**: `/etc/hosts` is owned by root. Editing requires sudo or a privileged daemon (cc-focus uses a LaunchDaemon running as root).
- **No entitlements**: No Apple Developer entitlements needed.
- **No user approval**: No System Extension approval dialogs.

### Browser Compatibility

| Browser | Honors hosts? | DoH default? | Notes |
|---------|--------------|-------------|-------|
| Safari | Yes | No | Most reliable; no independent DNS cache |
| Chrome | Yes | No (but setting exists) | Has internal DNS cache; `chrome://net-internals/#dns` |
| Firefox | Yes, but... | Yes (US users) | `network.trr.mode` can bypass hosts entirely |
| Arc | Yes | No | Chromium-based, same behavior as Chrome |
| Brave | Yes | No | Chromium-based |

### Downsides

- **Easily bypassed** by enabling DoH in browser settings, using a VPN, or manually editing the hosts file back.
- **No subpath/URL blocking** — domain-level only.
- **DNS cache lag** — changes don't take effect immediately without explicit cache flushing and browser restart.
- **File corruption risk** — careless edits (or Rich Text editors) can corrupt `/etc/hosts`, breaking all DNS resolution on the system.
- **CDN/shared hosting** — blocking a domain blocks ALL content served from that hostname, including legitimate CDN resources shared across sites.

---

## 2. pf (Packet Filter) Firewall Rules

**What cc-focus uses as a secondary "hardened" layer for high-risk sites.**

### Mechanism

`pf` is the BSD Packet Filter firewall built into the macOS (Darwin) kernel, inherited from OpenBSD. It operates at Layer 3/4 (IP/TCP/UDP), inspecting and filtering individual packets based on source/destination IP, port, and protocol.

cc-focus uses pf anchors to block outgoing TCP connections to known IP ranges:

```
# /etc/pf.anchors/com.welf.focusshield
block drop out quick proto tcp to 104.244.42.0/24  # Twitter/X
block drop out quick proto tcp to 157.240.0.0/16   # Meta
```

Anchors are loaded into the main `/etc/pf.conf`:
```
anchor "com.welf.focusshield"
load anchor "com.welf.focusshield" from "/etc/pf.anchors/com.welf.focusshield"
```

Activated with: `pfctl -e && pfctl -f /etc/pf.conf`

### Reliability

**High for static IP ranges, poor for dynamic/CDN-hosted sites.**

- Works regardless of DNS settings, DoH, VPN (unless the VPN routes traffic before pf processes it), or browser configuration.
- Cannot be bypassed by browser-level tricks (DoH, caches, etc.) since it operates below the application layer.
- **But**: pf only understands IP addresses, not domain names. Domain names in pf rules are resolved once at rule-load time and converted to static IPs. Sites behind CDNs (Cloudflare, Fastly, AWS CloudFront) rotate IPs frequently and share IPs with thousands of other sites — blocking the IP would block unrelated sites too.
- Twitter/X, Meta, Netflix, and TikTok own dedicated IP ranges (AS numbers), so static IP blocking works well for them. But most websites (Hacker News, Reddit, Substack) are behind CDNs where IP blocking is impractical.

### Granularity

- **IP-range level only.** No domain names, no URLs, no subpaths.
- Can be toggled by loading/unloading anchors: `pfctl -a com.welf.focusshield -F all` to clear.
- cc-focus's daemon also does dynamic pf rules — resolving a domain's current IPs via `dig` and adding per-IP block rules on the fly. This helps with sites that don't have stable IP ranges but is fragile (IPs change, CDN rotation).

### Requirements

- **Root access**: `pfctl` requires root.
- **pf must be enabled**: `pfctl -e` (disabled by default on macOS).
- **No entitlements**: No Apple Developer entitlements or System Extension approval.

### Browser Compatibility

**Universal.** pf operates at the kernel level, below all applications. All browsers, all apps, all protocols are affected equally. There is no browser-specific behavior.

### Downsides

- **IP-only**: Cannot block by domain name dynamically. CDN-hosted sites are nearly impossible to block reliably.
- **Collateral damage**: Blocking an IP range (e.g., all of Cloudflare) would break thousands of unrelated sites.
- **Static rules go stale**: IP ranges change. Twitter could move IPs, and the block would stop working (or block wrong targets).
- **QUIC/UDP gap**: cc-focus's current pf rules only block `proto tcp`. Sites increasingly use QUIC (UDP port 443). Must also block `proto udp` for the same IP ranges, or the browser falls through to QUIC. (The daemon's dynamic rules do block both TCP and UDP.)
- **Connection killing**: pf can kill existing connections with `pfctl -k`, which is useful for immediate enforcement. cc-focus already uses this.
- **macOS updates**: Apple occasionally resets `/etc/pf.conf` during macOS upgrades, potentially removing custom anchors.

---

## 3. Network Extension: Content Filter (NEFilterDataProvider)

### Mechanism

Apple's Network Extension framework provides `NEFilterDataProvider` — a system extension that receives all TCP and UDP flows on the device. The provider can inspect flow metadata (hostname, port, protocol, originating app) and make allow/drop decisions per-flow.

On macOS, the filter data provider receives flows at the socket layer. It can see:
- Destination hostname (from SNI in TLS ClientHello, or from the socket's connect address)
- Source application
- Protocol and port

The provider makes a `NEFilterNewFlowVerdict` for each flow: `.allow()`, `.drop()`, or `.filterDataVerdict(withFilterInbound:peekInboundBytes:filterOutbound:peekOutboundBytes:)` to inspect actual data.

### Reliability

**Very high.** This is how enterprise content filters (Cisco Umbrella, Zscaler, etc.) and parental control apps work on modern macOS.

- Intercepts all network flows at the system level — no browser can bypass it.
- Works with DoH, QUIC, VPNs (the filter sees flows before they enter a VPN tunnel unless the VPN is a Network Extension with higher priority).
- Domain-level blocking via SNI inspection is reliable for HTTPS traffic.
- Cannot be disabled by the user without admin approval (the system extension requires explicit user consent to install, and removal also requires consent).

**Caveats:**
- On macOS (unlike iOS), NE filter providers don't have WebKit integration. They see raw network flows, not HTTP URLs. Subpath blocking would require deep packet inspection of TLS traffic, which isn't feasible without MITM.
- Encrypted ClientHello (ECH) — an emerging standard — will encrypt the SNI field, making hostname detection impossible at the flow level. Not yet widely deployed (as of early 2026), but it's coming.

### Granularity

- **Per-flow**: Can allow/block based on hostname (SNI), IP, port, protocol, and originating application.
- **Per-app**: Can allow Safari to access a domain but block Chrome, or vice versa.
- **No subpath**: Cannot distinguish youtube.com/shorts from youtube.com/watch — it sees the flow to youtube.com, not the HTTP path.
- **Dynamic**: Rules can be changed at runtime by the containing app communicating with the extension.

### Requirements

**This is the biggest barrier.**

1. **Apple Developer Program membership** ($99/year).
2. **Network Extension entitlement**: Must be added to your provisioning profile. For Developer ID (non-App Store) distribution, you need the `content-filter-provider-systemextension` entitlement value.
3. **System Extension**: On macOS, the NE provider must be packaged as a System Extension (not a legacy kext or app extension). This requires:
   - The host app to call `OSSystemExtensionRequest.activationRequest()`.
   - The user to approve the extension in System Settings > Privacy & Security.
   - On macOS Sequoia+, the user may need to restart after approval.
4. **Notarization**: The app must be notarized by Apple for Gatekeeper to allow it.
5. **Code signing**: Must be signed with a Developer ID certificate.
6. **MDM can pre-approve**: In managed environments, MDM can silently approve system extensions.

For a personal tool like cc-focus, the main friction is: you must have an Apple Developer account, build a proper macOS app with a system extension, go through notarization, and the user must explicitly approve the extension in System Settings. This is a significant step up from "edit /etc/hosts."

### Browser Compatibility

**Universal.** All browsers, all apps. The filter operates at the system level. There is no way for a browser to bypass it (short of disabling the system extension, which requires admin permission).

### Downsides

- **High implementation complexity**: Requires a full macOS app with a system extension target, proper entitlements, code signing, notarization.
- **User approval required**: The user must click through System Settings to approve the extension. This is by design (security), but it's friction.
- **Apple's gatekeeping**: The entitlement must be approved. While this is generally granted, Apple could theoretically reject it.
- **Encrypted ClientHello (ECH)**: Future-proofing concern — once ECH is deployed, SNI-based hostname detection will break.
- **Performance**: Minimal in practice. LuLu (open-source firewall using NEFilterDataProvider) reports negligible CPU/memory impact. But poorly written filters could add latency to every network connection.
- **Debugging is painful**: System extensions run in a sandboxed environment. Logging, crash reports, and debugging are more complex than regular apps.

---

## 4. Network Extension: DNS Proxy (NEDNSProxyProvider)

### Mechanism

`NEDNSProxyProvider` intercepts all DNS queries on the device and routes them through your custom code. You can inspect each DNS query (domain name, record type) and either forward it to an upstream resolver or return a spoofed response (e.g., NXDOMAIN or 0.0.0.0) to block the domain.

This is essentially a programmable system-level DNS proxy running inside a Network Extension.

### Reliability

**High, with a critical caveat.**

- All DNS queries from all apps go through the proxy — no browser can bypass it by using its own resolver, because the proxy intercepts at the system level.
- DoH within browsers is NOT automatically intercepted — **unless** the DNS proxy is configured to also handle DoH traffic. However, since the proxy intercepts at the socket level, it can potentially intercept the browser's DoH connection itself (the TLS connection to the DoH server goes through the NE filter chain).

**Critical caveat for macOS Ventura+:** If the upstream DNS server supports DoH or DoT, macOS's `mDNSResponder` may automatically use encrypted DNS (port 443 DoH or port 853 DoT) in preference to traditional port 53 DNS. This traffic **bypasses the NEDNSProxyProvider entirely**. This is a documented Apple bug/design limitation. Workaround: configure the system DNS to a server that doesn't advertise DoH/DoT support, or block DoH/DoT traffic via pf rules.

### Granularity

- **Per-domain**: Full control over which domains resolve and which return NXDOMAIN.
- **Per-query-type**: Can block A records but allow MX, etc.
- **No subpath**: DNS is domain-level only.
- **Dynamic**: Can update block rules at runtime.

### Requirements

Same as NEFilterDataProvider:
1. Apple Developer Program membership.
2. `dns-proxy-systemextension` entitlement for Developer ID distribution.
3. System Extension packaging, notarization, code signing.
4. User approval in System Settings.

### Browser Compatibility

**Universal** — all apps use the system DNS proxy. However, the macOS Ventura+ DoH bypass means some traffic may escape.

### Downsides

- **Same implementation complexity** as NEFilterDataProvider.
- **macOS Ventura+ DoH bypass** is a serious reliability concern — the OS itself routes around your proxy.
- **DNS-only**: Cannot inspect or block based on HTTP content, only domain names.
- **Latency**: Every DNS query goes through your extension. If the extension is slow, all network activity slows down.
- **Incomplete for QUIC/HTTP3**: DNS blocking prevents initial connection, but cached DNS results or pre-established connections can persist.

---

## 5. Network Extension: Transparent Proxy (NETransparentProxyProvider)

### Mechanism

`NETransparentProxyProvider` (macOS 11+) creates a transparent proxy that intercepts TCP and UDP flows without requiring apps to be configured to use a proxy. The provider sees individual flows and can inspect/modify/drop them.

Unlike NEFilterDataProvider (which only allows/drops), the transparent proxy can actually read and modify the data in transit. This enables:
- Full HTTP request inspection (URL path, headers) for unencrypted traffic.
- SNI-based hostname detection for HTTPS.
- Potential MITM for HTTPS if you control the CA certificate.

mitmproxy's macOS local capture uses this approach — a Swift Network Extension that inspects flows and forwards selected ones to mitmproxy for interception.

### Reliability

**Very high**, similar to NEFilterDataProvider, with additional capabilities.

- Cannot be bypassed by browser settings.
- Can inspect more data than a pure filter.
- ECH will eventually limit SNI-based detection (same as NEFilterDataProvider).

### Granularity

- **Per-flow, per-hostname, per-app** (same as NEFilterDataProvider).
- **Potentially per-URL** if combined with MITM certificate for HTTPS decryption — but this requires trusting a custom CA certificate system-wide.
- For HTTP (non-TLS), full URL and content inspection is possible.

### Requirements

Same system extension requirements as other NE providers, plus:
- If doing HTTPS inspection, a custom CA certificate must be installed and trusted in the system keychain (requires user approval).

### Browser Compatibility

**Universal.** Same as other NE providers.

### Downsides

- **Highest implementation complexity** of all NE approaches.
- **HTTPS inspection requires MITM** — installing a custom CA cert is invasive, breaks certificate pinning for some apps, and has security implications.
- **Performance overhead**: Proxying all traffic adds latency. Must be carefully optimized.
- **Certificate pinning**: Apps that pin certificates (banking apps, some Google services) will break if MITM is used.

---

## 6. Browser Extensions

### Mechanism

Browser extensions can intercept and block web requests using the `webRequest` API (Manifest V2) or `declarativeNetRequest` API (Manifest V3). The extension runs inside the browser and can block requests at the URL level — including full URLs with paths.

### Reliability

**Low for self-control purposes.** The user can:
- Disable the extension in browser settings.
- Use a different browser without the extension.
- Use private/incognito mode (unless the extension is explicitly allowed).
- Uninstall the extension entirely.

Enterprise-managed Chrome (force-installed extensions via policy) is more robust, but requires Chrome Enterprise management.

### Granularity

**Excellent.** Browser extensions can block:
- Specific URLs (including paths, query parameters).
- URL patterns with wildcards.
- Specific content types (images, scripts, etc.).
- Based on request headers, referrer, etc.

This is the ONLY approach that can do subpath blocking (e.g., block youtube.com/shorts but allow youtube.com/watch) without MITM.

### Requirements

- **No root access needed.**
- **No Apple entitlements needed.**
- Must be installed per-browser.
- Manifest V3 (Chrome): `declarativeNetRequest` replaces `webRequest` for blocking. Blocking webRequest is restricted to force-installed (enterprise) extensions only.
- Firefox: Still supports full `webRequest` blocking in MV3.
- Safari: Web Extensions with `declarativeNetRequest`. Safari has stricter permissions and review requirements.

### Browser Compatibility

| Browser | MV2 blocking? | MV3 blocking? | Notes |
|---------|--------------|--------------|-------|
| Chrome | Deprecated (removed) | declarativeNetRequest only | Force-install via enterprise policy for webRequest |
| Firefox | Yes | Yes (webRequest preserved) | Most permissive |
| Safari | No MV2 | declarativeNetRequest | Must go through App Store review |
| Arc/Brave/Edge | Same as Chrome | Same as Chrome | Chromium-based |

### Downsides

- **Trivially bypassable** by the user (disable extension, switch browser, incognito).
- **Per-browser installation** — must maintain extensions for each browser.
- **Chrome MV3 restrictions**: `declarativeNetRequest` has a rule limit (was 5000 static rules per extension, now higher but still capped). Complex blocking rules may not fit.
- **Not self-control grade**: Designed for ad blocking, not for preventing the user from accessing sites. No persistence if the user wants to circumvent.
- **Safari extension distribution requires App Store review** or developer mode.

---

## 7. macOS Screen Time / FamilyControls API

### Mechanism

Apple's Screen Time API consists of three frameworks:
- **FamilyControls**: Authorization and privacy (requires iCloud Family Sharing or individual authorization).
- **ManagedSettings**: Sets restrictions — can shield apps and filter web domains.
- **DeviceActivity**: Schedules when restrictions are active/inactive.

`ManagedSettings` can set a `WebContentSettings` shield that blocks specified domains in Safari. It uses the same underlying mechanism as the built-in Screen Time parental controls.

### Reliability

**Medium-low for our use case.**

- **Safari only on macOS**: Web content restrictions from Screen Time / ManagedSettings only affect Safari. Chrome, Firefox, Arc, and all other third-party browsers are NOT affected.
- App blocking (shielding apps) works across all apps, so you could block Chrome/Firefox entirely during a focus session — but you can't selectively block websites within those browsers.
- The restrictions can be bypassed: a documented workaround allows accessing blocked websites even in Safari by using certain app-switching tricks. Apple's implementation has known bugs.
- The user can disable Screen Time restrictions if they know their passcode (unless managed by a parent/guardian via Family Sharing).

### Granularity

- **Domain-level in Safari only.**
- **App-level across all apps** (block/unblock entire applications).
- **Schedule-based** via DeviceActivity — can set time-of-day or usage-duration-based blocks.
- **No subpath blocking.**

### Requirements

- **Apple Developer Program membership** ($99/year).
- **`com.apple.developer.family-controls` entitlement** — must be approved by Apple.
- **iCloud account** on the device.
- For self-use (not parental): requires `AuthorizationCenter.shared.requestAuthorization(for: .individual)`.
- App must be distributed via App Store or Developer ID with the entitlement.
- **Privacy tokens**: Apps and websites are represented by opaque tokens for privacy — you cannot enumerate what the user has, you can only present a picker.

### Browser Compatibility

| Browser | Website blocking? | App blocking? |
|---------|------------------|--------------|
| Safari | Yes | Yes |
| Chrome | No | Yes (whole app) |
| Firefox | No | Yes (whole app) |
| Arc | No | Yes (whole app) |

### Downsides

- **Safari-only web filtering** is the dealbreaker. Most users use Chrome or Arc.
- **Apple's approval** required for the entitlement — adds friction and uncertainty.
- **iCloud dependency** — requires an active iCloud account.
- **Opaque tokens** — the privacy model makes programmatic domain management awkward (can't just pass a domain string, must use the picker UI).
- **Known bypass exploits** — Apple's enforcement has documented bugs.
- **Designed for parental controls**, not self-control. The UX and API assume a parent-child relationship.

---

## 8. Custom Local DNS Resolver (dnsmasq / unbound)

### Mechanism

Run a local DNS resolver (dnsmasq or unbound) on 127.0.0.1 and configure the system to use it as the primary DNS server. The resolver can be configured to return NXDOMAIN or 0.0.0.0 for blocked domains while forwarding all other queries to upstream DNS servers.

**dnsmasq**: Lightweight DNS forwarder. Configure with `address=/twitter.com/0.0.0.0` to block.

**unbound**: Full recursive resolver. Can use `local-zone: "twitter.com" always_nxdomain` or import a blocklist file (e.g., StevenBlack hosts list converted to unbound format).

Both install via Homebrew and run as LaunchDaemons.

### Reliability

**Medium-high.** Better than `/etc/hosts` in some ways, worse in others.

- All applications using the system DNS resolver will be affected.
- **DoH bypass**: Same vulnerability as `/etc/hosts` — if a browser uses DoH, it bypasses the local resolver entirely. This is the fundamental weakness of any DNS-based approach.
- **More robust than hosts**: A DNS resolver can handle wildcard domains (`*.twitter.com`), which `/etc/hosts` cannot.
- **Faster updates**: No need to flush the system DNS cache when changing the block list — the resolver itself is the cache.
- **System DNS configuration is fragile on macOS**: macOS uses `configd` and `scutil` to manage DNS, not `/etc/resolv.conf` directly. Changing networks (Wi-Fi to Ethernet, VPN connect/disconnect) can reset DNS settings. Must use a Network Location or a LaunchDaemon that monitors and re-applies DNS settings.

### Granularity

- **Domain-level with wildcards**: `*.youtube.com` — something `/etc/hosts` can't do.
- **No subpath blocking.**
- **Toggle on/off** by sending a reload signal to the resolver or editing the config.

### Requirements

- **Homebrew** to install dnsmasq/unbound.
- **Root access** to bind to port 53 on 127.0.0.1 and to configure system DNS.
- **LaunchDaemon** to run the resolver at boot.
- **No Apple entitlements.**
- Must handle macOS DNS configuration fragility (network changes reset DNS).

### Browser Compatibility

Same as `/etc/hosts` — all browsers that use the system resolver are affected. DoH-enabled browsers bypass it.

### Downsides

- **DoH bypass** — same fundamental weakness as `/etc/hosts`.
- **macOS DNS configuration fragility** — network changes can reset DNS to DHCP-provided servers, bypassing the local resolver.
- **Additional service to maintain** — another LaunchDaemon, another process that can crash.
- **DNS resolution chain complexity** — debugging DNS issues becomes harder with a local resolver in the mix.
- **No connection killing** — like `/etc/hosts`, changing DNS doesn't kill existing connections.
- **Marginal improvement over /etc/hosts** for the added complexity.

---

## 9. Local HTTP/HTTPS Proxy (MITM)

### Mechanism

Run a local proxy server (e.g., mitmproxy, squid, privoxy) that intercepts all HTTP and HTTPS traffic. The system is configured to route all web traffic through the proxy (via system proxy settings or pf redirection). For HTTPS, the proxy performs a man-in-the-middle attack by generating fake certificates signed by a custom CA that is trusted by the system.

cc-focus has a proxy module (`src/proxy.ts`) that already implements this for delay/friction features and path-level blocking.

### Reliability

**Very high for HTTP. High for HTTPS with caveats.**

- **HTTP**: Full URL inspection and blocking. 100% reliable.
- **HTTPS with trusted CA**: Full URL inspection after TLS termination. Reliable for browsers that trust the system keychain.
- **QUIC/HTTP3**: Must be blocked (via pf) to force browsers to fall back to HTTPS over TCP, which the proxy can intercept. Browsers will fall back gracefully.
- **Certificate pinning**: Apps that pin certificates (banking, some Google services) will fail. Must be whitelisted/bypassed.

### Granularity

**Excellent — the best of any approach.**

- **Full URL blocking**: Can block `youtube.com/shorts` while allowing `youtube.com/watch`.
- **Header/content inspection**: Can block based on request headers, response content, etc.
- **Per-app** (if using NE transparent proxy to route only specific apps through the proxy).
- **Dynamic**: Rules can be changed at runtime.
- **Delay/friction**: Can introduce artificial latency (cc-focus's progressive delay feature).

### Requirements

- **Custom CA certificate** must be trusted system-wide: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.crt`
- **System proxy configuration**: Set in System Settings > Network > Wi-Fi > Proxies, or via `networksetup` CLI.
- **Root access** for CA trust and proxy configuration.
- **No Apple entitlements** (unless using NE transparent proxy for traffic redirection).
- Alternatively, pf can redirect traffic to the proxy transparently (no system proxy config needed), but this is complex on macOS.

### Browser Compatibility

| Browser | System proxy? | CA trust? | Notes |
|---------|-------------|----------|-------|
| Safari | Yes | Yes (system keychain) | Works perfectly |
| Chrome | Yes | Yes (system keychain) | Works; may show certificate warnings for pinned domains |
| Firefox | **No by default** | **No** (uses own cert store) | Must enable `security.enterprise_roots.enabled` in about:config and configure proxy manually or use `network.proxy.system_wpad` |
| Arc | Yes | Yes | Chromium-based |

Firefox is the outlier — it has its own certificate store and proxy settings independent of the system.

### Downsides

- **Security implications**: Installing a custom CA cert means any compromise of the CA private key allows MITM of ALL your HTTPS traffic. The CA key must be protected.
- **Certificate pinning breakage**: Banking apps, some Google services, Apple services may fail.
- **Performance overhead**: All HTTPS traffic is decrypted, inspected, and re-encrypted. CPU-intensive for high-throughput traffic (video streaming, large downloads).
- **Firefox requires extra configuration** — not a drop-in solution for all browsers.
- **Proxy bypass**: A knowledgeable user can change system proxy settings to bypass the proxy. Combining with pf transparent redirect makes this harder but adds complexity.
- **macOS proxy settings are per-network**: Changing Wi-Fi networks may lose proxy configuration.
- **TLS 1.3 and ECH**: Future TLS features may complicate MITM. Currently not a practical issue.

---

## 10. Comparison Matrix

| Approach | Reliability | Granularity | Complexity | Root? | Entitlements? | All Browsers? | DoH Resistant? | Subpath? |
|----------|-----------|------------|-----------|-------|--------------|--------------|---------------|---------|
| /etc/hosts | Medium | Domain | Low | Yes | No | Yes* | **No** | No |
| pf firewall | High (for known IPs) | IP range | Low-Medium | Yes | No | Yes | Yes | No |
| NE Content Filter | Very High | Domain + App | **High** | No** | **Yes** | Yes | Yes | No |
| NE DNS Proxy | High | Domain | **High** | No** | **Yes** | Yes | Partial*** | No |
| NE Transparent Proxy | Very High | Domain + App | **Very High** | No** | **Yes** | Yes | Yes | Possible**** |
| Browser Extension | Low | Full URL | Medium | No | No | Per-browser | N/A | **Yes** |
| Screen Time API | Medium-Low | Domain (Safari) / App | Medium | No | **Yes** | **Safari only** | N/A | No |
| Local DNS (dnsmasq) | Medium-High | Domain + wildcard | Medium | Yes | No | Yes* | **No** | No |
| MITM Proxy | Very High | **Full URL** | High | Yes | No | Yes***** | Yes | **Yes** |

\* Except browsers with DoH enabled.
\** System Extension requires user approval in System Settings, but not root.
\*** macOS Ventura+ may bypass NEDNSProxyProvider when upstream supports DoH/DoT.
\**** Only with MITM certificate for HTTPS content.
\***** Firefox requires extra configuration.

---

## 11. Existing Open-Source / Commercial Blockers

### SelfControl (Open Source, Free)
- **Repo**: https://github.com/SelfControlApp/selfcontrol
- **Language**: Objective-C (96.3%)
- **Mechanism**: Dual-layer — `/etc/hosts` modification + `pf` firewall rules (anchor `org.eyebeam`). Resolves blocked domains to IPs and adds both hosts entries and pf IP blocks.
- **Persistence**: A LaunchDaemon checks every 60 seconds and re-applies blocks if they've been tampered with. The block survives app deletion, reboot, and hosts file editing.
- **Limitations**: Timer-based only (cannot be toggled on/off freely). No VPN support. Domain-level only. No API for programmatic control.
- **Relevance to cc-focus**: Validates the hosts + pf dual-layer approach. cc-focus already does this, plus adds timed allowances, dynamic IP blocking, browser tab closing, and an API layer.

### Cold Turkey Blocker (Proprietary, Freemium)
- **URL**: https://getcoldturkey.com/
- **Mechanism**: Dual-layer — **browser extensions + background service**. The desktop app installs browser extensions that intercept web requests. The background service monitors browser processes and will force-close browsers if the extension is disabled or tampered with.
- **Lock mechanism**: A "locked" block prevents uninstallation, disables the browser's task manager (to prevent killing the extension), and blocks the Settings app to prevent time changes.
- **Limitations**: Relies on browser extensions as the primary mechanism, which is inherently less robust than system-level blocking. The force-close behavior is the enforcement mechanism.
- **Relevance to cc-focus**: The browser-force-close-on-extension-disable pattern is clever but aggressive. Could be adapted as an additional enforcement layer.

### Focus (by meaningful-things, heyfocus.com) (Proprietary, $35)
- **URL**: https://heyfocus.com/
- **Mechanism**: Works at the application level. When a blocked URL is detected, Focus closes the browser tab and shows a motivational quote. For apps, it closes the app entirely.
- **Features**: Scheduling, Pomodoro timer, scripting support, per-app rules.
- **Limitations**: Tab-level enforcement (detects the URL after the page starts loading, then closes the tab). Not truly system-level blocking.

### Focus Firewall (Proprietary, subscription)
- **URL**: https://focusfirewall.com/
- **Mechanism**: System-level blocking. No browser extensions required. Works with all browsers. When a blocked site is accessed, it appears as if the internet is down for that domain.
- **Technical approach**: Likely uses Network Extension (content filter) based on the described behavior (system-level, no extensions, blocks apps from internet access per-domain). App Store distributed, ~16MB, <100MB RAM, negligible CPU.
- **Relevance to cc-focus**: This is the commercial version of what a NEFilterDataProvider-based cc-focus would look like. Validates the NE approach as viable for a focus/blocking tool.

### 1Focus (Proprietary, subscription)
- **URL**: https://onefocusapp.com/
- **Mechanism**: Uses browser accessibility permissions to detect URLs and block access. Does not modify system settings. Shows a blocking page with a motivational quote when a blocked site is detected.
- **Limitation**: Browser-level, not system-level. Requires per-browser permission grants.

### LuLu (Open Source, Free)
- **Repo**: https://github.com/objective-see/LuLu
- **Mechanism**: Uses `NEFilterDataProvider` (Network Extension content filter) to monitor all outgoing connections. Prompts the user to allow/block unknown connections.
- **Relevance to cc-focus**: Best open-source reference implementation for NEFilterDataProvider on macOS. Shows the full system extension setup, entitlements, and flow inspection code. If cc-focus were to adopt NE, LuLu's codebase is the template.

### Little Snitch (Proprietary, ~$50)
- **URL**: https://www.obdev.at/products/littlesnitch/
- **Mechanism**: Uses a Network Extension to intercept all outgoing connections. Provides per-app, per-domain, per-port rules.
- **Relevance**: Most polished commercial implementation of NE-based connection filtering. Proves the approach works at scale, with excellent UX.

### Freedom (Proprietary, subscription)
- **URL**: https://freedom.to/
- **Mechanism**: Cross-platform. On macOS, uses a combination of system proxy settings and DNS manipulation. Syncs block lists across devices.
- **Limitations**: Subscription-based, cloud-dependent for sync.

### LeechBlock NG (Open Source, Free, Browser Extension)
- **Mechanism**: Pure browser extension. Highly configurable time-based blocking with URL pattern matching.
- **Limitation**: Browser extension only — all the bypass limitations of extensions apply.

---

## 12. Recommendations for cc-focus

### Current Architecture Assessment

cc-focus currently uses a strong dual-layer approach:
1. **Primary**: `/etc/hosts` modification via privileged daemon
2. **Secondary**: `pf` firewall rules for IP-level blocking of major sites
3. **Tertiary**: MITM proxy for delay/friction features and subpath blocking

This is essentially the same approach as SelfControl, but with better ergonomics (API, timed allowances, dynamic rules, browser tab closing).

### Key Vulnerabilities in Current Approach

1. **DoH bypass**: Any browser with Secure DNS enabled bypasses the hosts file entirely.
2. **CDN-hosted sites**: pf IP blocking doesn't work for sites behind Cloudflare/AWS (most of the internet).
3. **QUIC gap**: Current static pf rules only block TCP; QUIC (UDP 443) can bypass.
4. **Proxy is optional**: The MITM proxy requires manual system configuration and CA trust, so most users only get hosts+pf.

### Upgrade Path Options

**Option A: Fix current approach (low effort, medium improvement)**
- Add QUIC/UDP blocking to pf rules (block `proto udp` to port 443 for blocked IP ranges).
- Add DoH server blocking: block known DoH providers (1.1.1.1, 8.8.8.8, 9.9.9.9) at the pf level when blocking is active, forcing browsers to fall back to system DNS.
- Monitor and re-apply DNS settings on network changes (launchd watchdog).
- This keeps the simple architecture but patches the known holes.

**Option B: Add NEFilterDataProvider (high effort, high improvement)**
- Build a proper macOS app with a system extension.
- Use NEFilterDataProvider for domain-level blocking — this makes DoH, QUIC, and all browser-specific tricks irrelevant.
- Keep `/etc/hosts` + pf as fallback layers.
- Reference implementation: LuLu's source code on GitHub.
- Main barrier: Apple Developer entitlements, system extension packaging, notarization, user approval flow.
- This is the "proper" solution and what Focus Firewall / Little Snitch do.

**Option C: Local DNS resolver + pf DoH blocking (medium effort, medium-high improvement)**
- Run unbound/dnsmasq as system DNS.
- Block DoH/DoT at the pf level (block TCP/UDP to port 443 for known DoH provider IPs: 1.1.1.1, 8.8.8.8, etc., and port 853 for DoT).
- This forces all DNS through the local resolver while maintaining the simple architecture.
- Fragility: macOS DNS configuration resets on network changes; DoH provider IPs change.

**Recommended path: Option A now, Option B later.**
- Option A gives immediate reliability improvements with minimal changes to the existing architecture.
- Option B is the long-term correct answer but requires a significant investment in macOS app development.

---

## Sources

- [SelfControl GitHub Repository](https://github.com/SelfControlApp/selfcontrol)
- [SelfControl FAQ](https://github.com/SelfControlApp/selfcontrol/wiki/FAQ)
- [Cold Turkey Blocker](https://getcoldturkey.com/)
- [Cold Turkey Configuration Guide (Tech Lockdown)](https://www.techlockdown.com/blog/cold-turkey-blocker)
- [Focus App (heyfocus.com)](https://heyfocus.com/)
- [Focus Firewall](https://focusfirewall.com/)
- [1Focus](https://onefocusapp.com/)
- [LuLu (Objective-See)](https://github.com/objective-see/LuLu)
- [Apple: NEFilterDataProvider Documentation](https://developer.apple.com/documentation/networkextension/nefilterdataprovider)
- [Apple: NEDNSProxyProvider Documentation](https://developer.apple.com/documentation/networkextension/nednsproxyprovider)
- [Apple: NETransparentProxyProvider Documentation](https://developer.apple.com/documentation/networkextension/netransparentproxymanager)
- [Apple: TN3134 Network Extension Provider Deployment](https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment)
- [Apple: Network Extension Entitlements](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.networkextension)
- [Apple: Network Extensions for the Modern Mac (WWDC 2019)](https://developer.apple.com/videos/play/wwdc2019/714/)
- [Apple: Filter and Tunnel Network Traffic (WWDC 2025)](https://developer.apple.com/videos/play/wwdc2025/234/)
- [Apple: Screen Time API (WWDC 2021)](https://developer.apple.com/videos/play/wwdc2021/10123/)
- [Apple: Screen Time Technology Frameworks](https://developer.apple.com/documentation/screentimeapidocumentation)
- [Developer's Guide to Apple's Screen Time APIs (Medium)](https://medium.com/@juliusbrussee/a-developers-guide-to-apple-s-screen-time-apis-familycontrols-managedsettings-deviceactivity-e660147367d7)
- [Network Extension Entitlement Woes (nubco.xyz)](https://www.nubco.xyz/blog/networkextension-entitlements/index.html)
- [macOS pf Firewall Guide (Neil Sabol)](https://blog.neilsabol.site/post/quickly-easily-adding-pf-packet-filter-firewall-rules-macos-osx/)
- [pf Firewall Setup on macOS (Medium)](https://iyanmv.medium.com/setting-up-correctly-packet-filter-pf-firewall-on-any-macos-from-sierra-to-big-sur-47e70e062a0e)
- [DoH Bypassing Hosts File (StevenBlack/hosts #968)](https://github.com/StevenBlack/hosts/issues/968)
- [Chrome DoH/Secure DNS Settings](https://www.theairtips.com/post/how-to-setup-dns-over-https-doh-in-macos-google-chrome)
- [QUIC Firewall Bypass Research (arXiv:2107.05939)](https://ar5iv.labs.arxiv.org/html/2107.05939)
- [macOS-Fortress (Firewall + Proxy)](https://github.com/essandess/macOS-Fortress)
- [Running Local Unbound DNS on macOS](https://alemann.dev/local-unbound-dns-resolver-macos/)
- [Local dnsmasq on macOS (Simon Willison)](https://til.simonwillison.net/macos/wildcard-dns-dnsmasq)
- [mitmproxy Transparent Proxying](https://docs.mitmproxy.org/stable/howto/transparent/)
- [mitmproxy Local Capture on macOS](https://www.mitmproxy.org/posts/local-capture/macos/)
- [Chrome Manifest V3 webRequest Changes](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests)
