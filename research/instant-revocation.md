# Instant Domain Blocking and Revocation on macOS

Research compiled 2026-02-18 for cc-focus.

The core problem: cc-focus currently blocks domains via `/etc/hosts` + `pf` firewall rules + AppleScript tab closing. Blocking works well. **Revocation** (revoking access after a grant expires, or after a page is already loaded) is unreliable because browsers cache DNS and maintain TCP/TLS connections independently of the system resolver.

This report evaluates five approaches to achieve instant, reliable block/unblock with a focus on the **revocation problem** -- the hardest part.

---

## Table of Contents

1. [The Revocation Problem — Why It's Hard](#1-the-revocation-problem--why-its-hard)
2. [Approach 1: Browser Extension](#2-approach-1-browser-extension)
3. [Approach 2: NEFilterDataProvider (Network Extension)](#3-approach-2-nefilterdataprovider-network-extension)
4. [Approach 3: Local DNS Resolver](#4-approach-3-local-dns-resolver)
5. [Approach 4: What Open-Source Blockers Actually Do](#5-approach-4-what-open-source-blockers-actually-do)
6. [Approach 5: Hybrid — Extension + NE + pf](#6-approach-5-hybrid--extension--ne--pf)
7. [Comparison Matrix](#7-comparison-matrix)
8. [Recommendation](#8-recommendation)

---

## 1. The Revocation Problem -- Why It's Hard

### The scenario

1. User has `twitter.com` blocked
2. User gets a 20-minute grant via `POST /api/grant`
3. User browses Twitter for 20 minutes
4. Grant expires -- cc-focus needs to **instantly** make Twitter inaccessible
5. The browser tab has an open HTTP/2 or WebSocket connection to Twitter
6. The browser has Twitter's IP cached in its internal DNS cache (60s minimum in Chromium)
7. The page is fully rendered in memory -- no new network requests needed to display it

### Why each current layer fails at revocation

| Layer | What it does | Why it fails at revocation |
|-------|-------------|---------------------------|
| `/etc/hosts` -> `0.0.0.0` | Poisons DNS responses | Browser has already resolved the IP and cached it. No new DNS lookup needed for open connections. Takes 60-120s for browser DNS cache to expire even after hosts change. |
| `pf` firewall rules | Blocks IP-level traffic | **This actually works for new connections.** But the page is already loaded -- the content is rendered in the browser's memory. No new packets needed to display it. And `pfctl -k` kills TCP state in the kernel, but HTTP/2 multiplexed streams and keep-alive connections may survive briefly. |
| `dscacheutil -flushcache` | Flushes macOS system DNS cache | Browsers maintain their own DNS cache. Chrome's is 60s minimum, hardcoded. System flush is irrelevant to browser-internal cache. |
| AppleScript tab closing | Closes tabs matching domain | **This is the only mechanism that actually revokes a loaded page.** But it's slow (~500ms per browser), fragile (requires Accessibility permissions, fails silently), and doesn't cover all browsers (Firefox, Brave, etc.). |

### The fundamental insight

**There are two distinct problems:**

1. **Preventing NEW connections** -- DNS, firewall, NE filter all handle this
2. **Killing an ALREADY-LOADED page** -- only two things can do this: (a) close the tab, or (b) navigate the tab away from the page

Problem #2 is the actual hard part. DNS-level solutions cannot solve it. Firewall-level solutions partially solve it (connection dies, but rendered content stays visible). Only something with access to the browser's tab model can fully solve it.

---

## 2. Approach 1: Browser Extension

A Manifest V3 (MV3) browser extension that polls `localhost:8053` for the blocklist and enforces it at the browser level. This is the **only approach that operates inside the browser's process** and therefore the only one that can solve the revocation problem completely.

### How it would work

```
cc-focus server (localhost:8053)
    |
    | GET /api/filter-state (polled every 2-5s)
    |
Browser Extension (service worker)
    |
    |-- declarativeNetRequest: block new requests to blocked domains
    |-- tabs.query() + tabs.remove(): close tabs showing blocked domains
    |-- tabs.onUpdated: intercept navigation to blocked domains
```

### Key APIs

**`declarativeNetRequest` (Manifest V3)**

The replacement for `webRequest.onBeforeRequest`. Allows declarative rule-based blocking.

- `updateDynamicRules()`: Add/remove blocking rules at runtime. Atomic operation.
- `updateSessionRules()`: Same but session-scoped (cleared on browser restart).
- Rules are evaluated by the browser's network stack, not by JavaScript -- very fast.
- Maximum 5,000 dynamic rules (more than enough for cc-focus's ~200 domains).
- Rules persist across browser sessions and extension updates.
- Rules take effect **immediately** -- the very next network request is evaluated against the new rules.

Example rule to block twitter.com:
```json
{
  "id": 1,
  "priority": 1,
  "action": { "type": "block" },
  "condition": {
    "urlFilter": "||twitter.com",
    "resourceTypes": ["main_frame", "sub_frame", "stylesheet", "script", "image",
                       "font", "object", "xmlhttprequest", "ping", "media",
                       "websocket", "webtransport", "other"]
  }
}
```

Alternative action: redirect to a block page instead of hard blocking:
```json
{
  "action": {
    "type": "redirect",
    "redirect": { "url": "http://localhost:8053/blocked.html" }
  }
}
```

**`tabs` API**

- `tabs.query({url: "*://*.twitter.com/*"})`: Find all tabs matching a domain pattern
- `tabs.remove(tabId)`: Close a tab instantly
- `tabs.update(tabId, {url: "http://localhost:8053/blocked.html"})`: Navigate tab to block page (gentler than closing)
- `tabs.onUpdated`: Listen for tab URL changes -- can intercept navigation before the page loads

**`alarms` API (replaces setInterval in MV3)**

Service workers in MV3 are not persistent -- they wake on events and sleep after ~30 seconds of inactivity. Use `chrome.alarms.create()` to schedule periodic blocklist polling:

```javascript
// Poll every 5 seconds
chrome.alarms.create('poll-blocklist', { periodInMinutes: 5/60 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'poll-blocklist') {
    const response = await fetch('http://127.0.0.1:8053/api/filter-state');
    const state = await response.json();
    // Update declarativeNetRequest rules and close blocked tabs
    await syncBlockRules(state);
  }
});
```

Minimum alarm period in Chrome: 30 seconds for unpacked extensions, 1 minute for packed. For faster polling, the service worker must stay alive via other means (e.g., a persistent connection, or `chrome.runtime.onMessage` from a content script keepalive).

**Alternative: Native Messaging**

Instead of HTTP polling, the extension can use Chrome's Native Messaging API to communicate with a host process (the cc-focus server). The host process sends messages through stdin/stdout. This provides:
- Push-based updates (server pushes new blocklist immediately, no polling delay)
- No CORS issues
- Works even if localhost HTTP is blocked

The native messaging host is registered via a JSON manifest file at a known path:
- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (user) or `/Library/Google/Chrome/NativeMessagingHosts/` (system)
- The host process is started by Chrome when the extension connects

### Revocation flow (the critical path)

When a grant expires:

1. cc-focus server updates blocklist, bumps version counter
2. Extension polls `/api/filter-state`, sees version change (or receives native message push)
3. Extension calls `updateDynamicRules()` to add blocking rules for the domain
4. Extension calls `tabs.query({url: "*://*.twitter.com/*"})` to find open tabs
5. Extension calls `tabs.remove()` on each matching tab (or `tabs.update()` to redirect to block page)
6. **Result: tab is closed/redirected within the polling interval (2-5s)**

This is **the only approach that can close a loaded tab**. The tab closure is instant -- not dependent on DNS, firewall, or connection state.

### How fast is it?

| Operation | Latency |
|-----------|---------|
| `declarativeNetRequest.updateDynamicRules()` | ~1ms (browser-internal, synchronous for the network stack) |
| `tabs.query()` | ~1ms |
| `tabs.remove()` | ~1ms |
| Polling interval | 2-5s (configurable, limited by MV3 alarm minimum) |
| Native messaging push | ~10ms (essentially instant) |
| **Total revocation time** | **2-5s with polling, <100ms with native messaging push** |

### Bypassability

This is the major weakness:

- User can **disable the extension** in `chrome://extensions`
- User can **use a different browser** without the extension
- User can use **Incognito mode** (unless extension is explicitly allowed)
- User can **uninstall the extension**

**Mitigation (Cold Turkey pattern):** A background process monitors whether the extension is enabled in each browser. If the extension is disabled or removed, the process **force-closes the browser**. Cold Turkey Blocker does exactly this. Implementation:
1. The extension periodically pings `localhost:8053/api/extension-heartbeat` with a browser identifier
2. If the server stops receiving heartbeats from a browser it knows should have the extension, it tells the daemon to `kill` that browser process
3. This is aggressive but effective for self-control

**Mitigation (Chrome Enterprise Policy):** Force-install the extension via Chrome enterprise policy. Create `/Library/Managed Preferences/com.google.Chrome.plist`:
```xml
<key>ExtensionInstallForcelist</key>
<array>
  <string>EXTENSION_ID;https://your-update-url/updates.xml</string>
</array>
```
This prevents the user from disabling or removing the extension. Works on Chrome, Arc, Brave, Edge (all Chromium-based). But the user can still reset Chrome's managed preferences if they have admin access.

### Cross-browser support

| Browser | Extension Platform | declarativeNetRequest | tabs API | Native Messaging | Distribution |
|---------|-------------------|----------------------|----------|-----------------|-------------|
| Chrome | MV3 | Full support | Full | Full | Chrome Web Store or `--load-extension` |
| Arc | MV3 (Chromium) | Full support | Full | Full | Same as Chrome |
| Brave | MV3 (Chromium) | Full support | Full | Full | Same as Chrome |
| Edge | MV3 (Chromium) | Full support | Full | Full | Edge Add-ons or sideload |
| Firefox | MV3 + webRequest | Full (also keeps webRequest blocking!) | Full | Full | AMO or sideload |
| Safari | Safari Web Extension | Partial (declarativeNetRequest supported since Safari 15.4) | Full | **No native messaging** | Requires Xcode project, distributed via App Store or Developer ID |

**Safari is the outlier**: no native messaging, requires an Xcode project to build, and must be distributed through the App Store or with a Developer ID. The extension must be wrapped in a macOS app. However, Safari Web Extensions DO support `declarativeNetRequest` and the `tabs` API, so the core blocking + tab-closing mechanism works.

### Implementation complexity

| Component | Effort |
|-----------|--------|
| Chrome/Chromium extension (MV3) | 4-6 hours (service worker + manifest + blocking rules) |
| Firefox port | 2-3 hours (mostly works, minor API differences) |
| Safari port | 8-12 hours (Xcode project, Safari Web Extension wrapping, signing) |
| Native messaging host (Node.js) | 3-4 hours (stdin/stdout JSON protocol) |
| Polling fallback (HTTP) | 1-2 hours (simpler, works everywhere) |
| Extension heartbeat + browser force-close | 4-6 hours |
| Chrome enterprise policy force-install | 2-3 hours |
| **Total (Chrome + Firefox)** | **~15-20 hours** |
| **Total (all browsers including Safari)** | **~30-40 hours** |

---

## 3. Approach 2: NEFilterDataProvider (Network Extension)

Already researched extensively in `ne-filter-deep-dive.md`. Summarized here with focus on the revocation problem.

### How it handles revocation

NEFilterDataProvider operates at the **flow level**, not the packet level. When a new TCP/UDP flow is created, the extension's `handleNewFlow()` is called. The extension returns `.allow()` or `.drop()`.

**For NEW connections after revocation**: The extension polls `localhost:8053/api/filter-state` every 5 seconds. When the blocklist changes, it updates its internal `Set<String>`. The next `handleNewFlow()` call for the blocked domain returns `.drop()`. This is instant for new connections.

**For EXISTING connections**: This is where NE falls short. NEFilterDataProvider **cannot retroactively kill an already-allowed flow**. Once `handleNewFlow()` returns `.allow()`, that flow is allowed for its entire lifetime. There is no `revokeFlow()` API.

When a grant expires and Twitter becomes blocked again:
1. The NE extension updates its blocklist
2. **New** connections to Twitter are dropped immediately
3. **Existing** HTTP/2 connections from the open tab continue to work
4. The open tab remains functional until the HTTP/2 connection drops or the user navigates away
5. In practice: Twitter's feed will stop loading new content (new XHR/fetch requests create new flows, which get dropped), but the already-rendered page stays visible

**Supplementary mechanism needed**: Even with NE, you still need AppleScript tab closing (or a browser extension) to fully revoke a loaded page.

### How fast is it?

| Operation | Latency |
|-----------|---------|
| Blocking a new connection to blocked domain | ~1ms (flow-level verdict) |
| Unblocking (grant): remove domain from set | ~5s (polling interval) |
| **Revocation of existing connection** | **Cannot do it** -- existing flows persist |
| With pf connection killing supplement | ~1-2s for connection kill, but page content stays rendered |

### Bypassability

- Cannot be bypassed by browser settings (DoH, DNS cache, etc.)
- Cannot be disabled without admin permission in System Settings
- Apple system apps bypass the filter (Maps, App Store, etc. -- irrelevant for cc-focus)
- Chrome/Chromium browsers don't expose `remoteHostname` -- must parse SNI from TLS ClientHello (implemented in `FilterDataProvider.swift`)
- ECH (Encrypted ClientHello) will eventually degrade SNI-based blocking for Cloudflare-hosted sites

### The prototype exists

cc-focus already has a working NE extension prototype in `/extension/`:
- `FocusShieldFilter/FilterDataProvider.swift` -- NEFilterDataProvider with SNI parsing and localhost polling
- `FocusShieldHelper/AppDelegate.swift` -- headless container app for system extension lifecycle
- Not yet signed/notarized for production use

---

## 4. Approach 3: Local DNS Resolver

Already researched in `local-dns-resolver.md`. Quick summary focused on revocation.

### How it handles revocation

A local DNS resolver (dnsmasq on 127.0.0.1:53) replaces `/etc/hosts`. When a domain is revoked (re-blocked):

1. Remove the domain from the dnsmasq blocklist file
2. Send SIGHUP to dnsmasq (clears cache, re-reads hosts file)
3. Next DNS query for the domain returns NXDOMAIN / 0.0.0.0

**For NEW connections after revocation**: Works within the browser's DNS cache TTL (60s minimum in Chromium). NOT instant.

**For EXISTING connections**: Does nothing. The connection is already established with a resolved IP. DNS changes don't affect existing connections.

### How fast is it?

| Operation | Latency |
|-----------|---------|
| dnsmasq response to blocked query | ~1ms |
| dnsmasq SIGHUP reload | ~100ms |
| **Browser DNS cache expiry** | **60-120s (the bottleneck)** |
| Existing connection revocation | **Cannot do it** |

### Verdict on revocation

**Does not solve the revocation problem.** Marginally better than `/etc/hosts` (eliminates system DNS cache layer, supports wildcards), but the browser DNS cache is the bottleneck and it exists regardless of the DNS backend. The 60-second Chromium minimum cache is hardcoded and unaffectable by TTL settings.

---

## 5. Approach 4: What Open-Source Blockers Actually Do

### SelfControl

**Approach**: `/etc/hosts` + `pf` (same as cc-focus). Does NOT do revocation -- blocks are timer-based and cannot be revoked early by design. When the timer expires, the block is removed by:
1. Clearing hosts entries
2. Removing pf rules
3. Flushing system DNS cache
4. Deleting browser cache directories
5. Prompting user to restart Firefox

**On revocation (block expiry)**: SelfControl acknowledges the browser DNS cache problem. Their solution: delete browser cache directories and prompt for restart. They also use `pf -F states` to flush kernel connection state.

**Key insight**: SelfControl sidesteps the revocation problem by making blocks one-way (extend only). This is a deliberate design choice for self-control tools. The block never needs to be revoked mid-session because the user chose the duration upfront.

### LuLu

**Approach**: NEFilterDataProvider. Primarily a firewall (allow/block per-app, per-domain), not a website blocker.

**On revocation**: When a user changes a rule from "allow" to "block" for a domain, LuLu blocks **new** flows. Existing flows continue. LuLu does not close tabs or kill connections -- it's a firewall, not a focus tool.

### Cold Turkey Blocker

**Approach**: Browser extensions as primary mechanism + desktop app as enforcement backstop.

**How blocking works**:
1. Desktop app installs browser extensions in Chrome, Firefox, Edge
2. Extensions use `webRequest` (MV2) or `declarativeNetRequest` (MV3) to block requests
3. If a browser doesn't support extensions, it is **force-closed entirely**
4. If the extension is disabled in a supported browser, the desktop app **force-closes that browser**

**On revocation**: The extension intercepts requests in real-time. When a block expires, the extension stops intercepting. When a block starts, existing tabs showing the domain are redirected to a block page via `tabs.update()`. **This is instant.**

**Cold Turkey's key innovation**: The force-close-browser-on-extension-disable pattern. This solves the bypassability problem of browser extensions. The user cannot disable the extension without losing the browser entirely.

**Lock mechanism**: A "locked" block prevents:
- Uninstalling Cold Turkey
- Disabling the browser extension (browser gets force-closed)
- Changing system time (monitors for clock changes)
- Accessing browser's extension management page (blocked via the extension itself)

### Focus Firewall

**Approach**: NEFilterDataProvider (inferred from behavior -- Mac App Store distribution, no extensions required, all-browser support).

**On revocation**: Blocks new connections at the flow level. Does not appear to close tabs or kill existing connections based on user reports. The user must navigate away from a blocked page.

### LeechBlock NG

**Approach**: Pure browser extension (Firefox + Chrome). MV3 service worker polls time and checks tabs.

**How blocking works**:
1. Service worker runs on tab update events and alarm intervals
2. Checks if the current tab URL matches any blocked site pattern
3. If blocked: navigates the tab to a block page, or closes the tab (configurable)
4. Time tracking: accumulates time spent on blocked sites, enforces time limits

**On revocation**: When the time limit is reached or the scheduled block period starts, LeechBlock checks all open tabs and immediately navigates/closes matching ones. This is the same `tabs.query()` + `tabs.update()` pattern.

**Limitation**: MV3 service worker goes idle after 30s of inactivity. LeechBlock uses alarms (minimum 1-minute interval in packed extensions) to periodically wake up and check tabs. Between checks, a user could navigate to a blocked site and see it for up to 1 minute before the block kicks in.

### uBlock Origin / uBlock Origin Lite

**Approach**: uBlock Origin (MV2) used `webRequest.onBeforeRequest` for real-time request interception -- every network request passed through JavaScript for evaluation. Extremely powerful and flexible.

uBlock Origin Lite (MV3) uses `declarativeNetRequest` with pre-compiled filter rules. Rules are split into rulesets. Uses dynamic and session rules for different use cases. Lost the ability to do real-time, programmatic, per-request evaluation.

**Relevance to cc-focus**: uBlock Origin's MV2 approach (intercepting every request in JavaScript) is overkill. cc-focus only needs domain-level blocking, which `declarativeNetRequest` handles perfectly. The dynamic rules API (`updateDynamicRules()`) provides real-time rule changes, which is exactly what we need.

### Pi-hole

**Approach**: DNS sinkhole (dnsmasq fork). Responds to blocked domain queries with 0.0.0.0 or NXDOMAIN.

**On revocation**: When a domain is whitelisted, Pi-hole sends SIGHUP to clear the cache. The next DNS query gets the real IP. But: the client (browser) has its own cache. Pi-hole's answer: "clear your browser cache." There is no better solution at the DNS layer.

**TTL strategy**: Pi-hole sets `local-ttl=2` for blocked responses (very short cache). This minimizes the window where a client holds a stale blocked response after whitelisting. But Chromium enforces a 60-second minimum regardless.

### Summary of what blockers do about revocation

| Tool | Revocation mechanism | Speed |
|------|---------------------|-------|
| SelfControl | Does not support mid-block revocation. Block expiry: clear hosts + pf + caches + prompt restart. | N/A (by design) |
| Cold Turkey | Browser extension `tabs.update()` redirects to block page. Force-closes browser if extension disabled. | **Instant** (~10ms) |
| Focus Firewall | NEFilterDataProvider drops new flows. Existing connections persist until they drop naturally. | New connections: instant. Loaded pages: persist. |
| LeechBlock | Browser extension `tabs.query()` + `tabs.update()` or `tabs.remove()`. | 1-60s (alarm polling interval) |
| LuLu | NEFilterDataProvider drops new flows. No tab management. | New connections: instant. Loaded pages: persist. |
| Pi-hole | DNS cache clear + short TTLs. Client cache is the bottleneck. | 60-120s (browser DNS cache) |
| cc-focus (current) | `/etc/hosts` + pf + DNS flush + AppleScript tab close | Blocking: instant (pf). Tab close: ~1-2s. DNS propagation: 60s+. |

---

## 6. Approach 5: Hybrid -- Extension + NE + pf

The optimal architecture combines the strengths of each layer.

### Architecture

```
                    ┌──────────────────────────────────────┐
                    │         cc-focus server               │
                    │        (localhost:8053)               │
                    │                                      │
                    │   Owns all state. Manages grants,    │
                    │   blocklist, lockouts, categories.    │
                    │   Bumps version on every change.      │
                    └─────┬──────────┬──────────┬─────────┘
                          │          │          │
                    Layer 1     Layer 2     Layer 3
                          │          │          │
                    ┌─────▼────┐ ┌──▼────────┐ ┌▼──────────────┐
                    │ Browser  │ │ NE Filter  │ │ Root Daemon    │
                    │Extension │ │ (system    │ │ (/etc/hosts,   │
                    │          │ │ extension) │ │  pf, connection│
                    │ - blocks │ │ - blocks   │ │  killing,      │
                    │   new    │ │   new      │ │  tab closing)  │
                    │   requests│ │  flows    │ │                │
                    │ - closes │ │ - SNI      │ │                │
                    │   tabs   │ │   parsing  │ │                │
                    │ - shows  │ │ - all apps │ │                │
                    │   block  │ │   covered  │ │                │
                    │   page   │ │            │ │                │
                    └──────────┘ └───────────┘ └────────────────┘

    Speed:          Instant       Instant         ~1-2s (pf)
                    (in-browser)  (flow-level)    60s (DNS)

    Revocation:     YES (close    NO (existing    Partial (kills
                    tabs, redirect flows persist) connections,
                    to block page)               closes tabs via
                                                 AppleScript)

    Bypass:         Disable       Admin only     Root only
                    extension,    (System         (sudo)
                    switch        Settings)
                    browser

    Coverage:       Per-browser   All apps,      All apps,
                    (must install all browsers   all browsers
                    in each)
```

### Why three layers?

1. **Browser extension (Layer 1)**: Only mechanism that can **close tabs** and **redirect loaded pages**. Handles the revocation problem. Fast (~ms). But bypassable (user can disable).

2. **NEFilterDataProvider (Layer 2)**: Covers ALL applications, ALL browsers, resistant to DoH, DNS caching, QUIC. Cannot be bypassed without admin permission. But cannot revoke loaded pages.

3. **Root daemon with pf + hosts (Layer 3)**: Defense in depth. Blocks at the IP and DNS level. Kills TCP connections. Closes tabs via AppleScript (fallback for browsers without the extension). The most robust against bypass but the slowest for DNS propagation.

### Grant flow

1. Server receives `POST /api/grant {domain, minutes}`
2. Server updates state, bumps version
3. Layer 1 (extension): polls server, removes declarativeNetRequest rules for domain. Instant.
4. Layer 2 (NE): polls server, removes domain from blockedDomains set. New flows to domain are allowed.
5. Layer 3 (daemon): removes hosts entries, pf rules. DNS flush. Delayed DNS propagation (60s browser cache).
6. User opens new tab, navigates to domain. Works immediately (NE allows, no pf rules, extension allows).

### Revocation flow (the critical one)

1. Grant expires (30s expiry checker) or manual revoke via `DELETE /api/grant/:domain`
2. Server updates state, bumps version
3. **Layer 1 (extension)**: polls server (within 2-5s), adds declarativeNetRequest rules, **queries tabs matching domain, closes/redirects them**. User sees block page or tab closes within 2-5s.
4. Layer 2 (NE): polls server (within 5s), adds domain to blockedDomains set. New flows are dropped.
5. Layer 3 (daemon): adds hosts entries, pf rules. Kills connections (`pfctl -k`). Closes tabs via AppleScript (redundant with extension but covers browsers without extension).
6. **Net result**: tab is gone within 2-5s (extension). New connections blocked immediately (NE + pf). Even if extension is disabled, NE prevents new connections and pf kills existing ones within 1-2s.

### The extension heartbeat pattern (anti-bypass)

```
Extension (every 30s) ---> POST /api/extension-heartbeat {browser: "chrome"}
                           POST /api/extension-heartbeat {browser: "arc"}

Server tracks last heartbeat per browser.

If heartbeat missing for >60s from a known browser:
  Option A: Alert via monastic-os overlay ("Chrome extension disabled")
  Option B: Tell daemon to kill that browser process
  Option C: Log it (least aggressive -- for the "soft" self-control use case)
```

Cold Turkey uses Option B. For cc-focus, Option A (alert) is probably the right default, with Option B as a "locked" mode.

---

## 7. Comparison Matrix

| Factor | Browser Extension | NEFilterDataProvider | Local DNS (dnsmasq) | pf + /etc/hosts (current) |
|--------|------------------|---------------------|--------------------|--------------------------|
| **Blocking new requests** | Instant (~1ms) | Instant (~1ms) | Instant (resolver) but 60s browser cache | Instant (pf) but 60s DNS cache |
| **Revoking loaded page** | **YES** (close tab, redirect) | **NO** (existing flows persist) | **NO** | Partial (kill connections, AppleScript) |
| **Speed of revocation** | 2-5s (polling) or <100ms (native messaging) | N/A | N/A | 1-2s (pf + AppleScript) |
| **Covers all browsers** | No (per-browser install) | **YES** | Yes (system DNS) | Yes |
| **Covers non-browser apps** | No | **YES** | Yes | Yes |
| **Resistant to DoH** | Yes (operates in-browser, above DNS) | **YES** (flow-level) | No (fundamental weakness) | Partial (pf can block DoH IPs) |
| **Resistant to DNS cache** | Yes (operates above DNS) | **YES** | No (browser cache is bottleneck) | No |
| **Resistant to user bypass** | **LOW** (can disable extension) | **HIGH** (admin required) | Medium (can change DNS settings) | Medium (requires sudo) |
| **Implementation effort** | Medium (15-20h for Chrome+Firefox) | High (20-35h, Apple Developer account) | Medium (8-12h) | Done (current) |
| **Path-level blocking** | **YES** (URL patterns in rules) | No (domain-level only) | No | No (proxy only) |
| **ECH-proof** | **YES** (operates above TLS) | Degrades over time | N/A | N/A |
| **macOS version risk** | None (browser API, not OS API) | Low (Apple-supported API) | Medium (Apple may restrict) | Low (pf is stable) |

### The key insight from this matrix

No single approach solves everything. But:
- **Browser extension** is the ONLY approach that solves revocation (closing loaded tabs)
- **NEFilterDataProvider** is the ONLY approach that's resistant to all bypass vectors
- **pf** is the ONLY approach that can kill existing TCP connections at the kernel level
- **DNS** (hosts or dnsmasq) is the weakest layer but provides defense in depth

The optimal solution layers all of them.

---

## 8. Recommendation

### Priority 1: Browser Extension (solves the acute revocation problem)

Build a Manifest V3 browser extension for Chrome/Arc (same extension works in all Chromium browsers). This is the highest-impact, lowest-risk improvement:

- **Solves revocation immediately**: `tabs.query()` + `tabs.remove()` closes blocked tabs within seconds
- **Solves DNS cache problem**: `declarativeNetRequest` operates above DNS entirely
- **Solves DoH bypass**: operates in-browser, doesn't touch DNS
- **No Apple Developer account needed**
- **No system extension approval needed**
- **Supports path-level blocking** (`urlFilter` patterns)
- **Works TODAY** on Chrome, Arc, Brave, Edge

The extension polls `localhost:8053/api/filter-state` every 5 seconds. On blocklist change:
1. Sync `declarativeNetRequest` dynamic rules (block new requests)
2. Query and close/redirect tabs matching newly-blocked domains
3. Report heartbeat so server knows the extension is active

For Firefox: port the extension (minor API differences, Firefox still supports `webRequest` blocking in MV3).

For Safari: Requires a separate Xcode project. Defer unless Safari is a primary browser.

**Implementation order:**
1. Chrome/Chromium extension with `declarativeNetRequest` + `tabs` API (4-6h)
2. Polling service worker with `alarms` API (2-3h)
3. Integration with cc-focus server `/api/filter-state` endpoint (already exists)
4. Firefox port (2-3h)
5. Native messaging for faster push-based updates (optional, 3-4h)
6. Extension heartbeat + enforcement policy (4-6h)

### Priority 2: NEFilterDataProvider (solves the bypass problem)

The NE extension prototype already exists in `/extension/`. What remains:
1. Apple Developer account ($99/year)
2. Provisioning profiles with NE + System Extension entitlements
3. Code signing + notarization
4. Install/approval UX

This covers the scenario where the user disables the browser extension or uses a browser without it. NE blocks at the flow level, covering everything.

**Important nuance**: NE does NOT replace the browser extension for revocation. Even with NE, you still need the extension to close loaded tabs. NE prevents new connections; the extension handles loaded pages.

### Priority 3: Keep pf + hosts as defense-in-depth

The current `/etc/hosts` + pf architecture stays as a fallback layer. It works, it's proven, and it catches things the other layers might miss (e.g., non-browser applications, CLI tools).

### What NOT to prioritize

- **Local DNS resolver (dnsmasq)**: Does not solve the core revocation problem. Marginal improvement over `/etc/hosts` for the added complexity and new failure modes. The browser extension + NE approach makes DNS-level blocking less critical. Keep `/etc/hosts` -- it works and is simpler.

- **MITM proxy as primary blocker**: Already exists for path-level blocking and delay friction. Keep it for those features but don't expand its role. The browser extension can do path-level blocking more cleanly via `declarativeNetRequest` URL patterns.

### Architecture after implementation

```
Best case (all layers active):
  Extension blocks requests, closes tabs, shows block page     [instant, in-browser]
  NE Filter drops flows at system level                        [instant, all apps]
  pf kills connections, blocks IP ranges                       [instant, kernel-level]
  /etc/hosts poisons DNS                                       [defense in depth]

If extension disabled:
  NE still blocks new connections                              [bypass-resistant]
  pf still kills connections                                   [kernel-level]
  AppleScript still closes tabs (slower, less reliable)        [fallback]
  Server alerts user (overlay via monastic-os)                 [awareness]

If NE not installed (pre-Apple Developer account):
  Extension handles in-browser blocking + tab closing          [primary]
  pf + /etc/hosts handle system-level                          [secondary]
  This is the current architecture + extension = significant improvement

If nothing but pf + hosts (current state):
  DNS cache lag on revocation (60s+)                           [known issue]
  AppleScript tab closing (slow, fragile)                      [partial fix]
```

---

## Sources

### Browser Extension APIs
- [chrome.declarativeNetRequest API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [declarativeNetRequest - MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest)
- [declarativeNetRequest.updateDynamicRules - MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest/updateDynamicRules)
- [Replace blocking web request listeners (MV2->MV3)](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests)
- [chrome.tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [tabs.query() - MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/query)
- [tabs.remove() - MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/remove)
- [Native Messaging - Chrome Developers](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Native Messaging - MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
- [Safari Web Extensions - Apple Developer](https://developer.apple.com/documentation/safariservices/safari-web-extensions)
- [Distributing Safari Web Extensions - Apple Developer](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension)
- [Adopting Declarative Content Blocking in Safari - Apple Developer](https://developer.apple.com/documentation/SafariServices/adopting-declarative-content-blocking-in-safari-web-extensions)

### LeechBlock NG
- [LeechBlock NG (Firefox) - GitHub](https://github.com/proginosko/LeechBlockNG)
- [LeechBlock NG (Chrome) - GitHub](https://github.com/proginosko/LeechBlockNG-chrome)
- [LeechBlock Documentation](https://www.proginosko.com/leechblock/documentation/)

### uBlock Origin / Manifest V3
- [uBlock Origin Lite MV3 - DeepWiki](https://deepwiki.com/gorhill/uBlock/8-ublock-origin-lite-(mv3))
- [Chrome Extension MV3 proposal - uBlock Issues #338](https://github.com/uBlockOrigin/uBlock-issues/issues/338)

### Cold Turkey
- [Cold Turkey Blocker](https://getcoldturkey.com/)
- [Cold Turkey Configuration Guide (Tech Lockdown)](https://www.techlockdown.com/articles/cold-turkey-blocker)
- [Protect Chrome Extension from being Disabled (Tech Lockdown)](https://www.techlockdown.com/guides/how-to-enforce-browser-extensions)

### Chrome Enterprise Policy
- [Block the Extensions Store (Tech Lockdown)](https://www.techlockdown.com/guides/how-to-block-the-browser-extensions-store)

### Native Messaging
- [Web-to-App Communication: Native Messaging API (textslashplain)](https://textslashplain.com/2020/09/04/web-to-app-communication-the-native-messaging-api/)
- [simov/native-messaging (Node.js library)](https://github.com/simov/native-messaging)
- [chrome-native-messaging-golang example](https://github.com/jfarleyx/chrome-native-messaging-golang)

### Prior cc-focus Research
- [DNS Cache Bug](dns-cache-bug.md) -- the original bug that motivates this research
- [Blocking Approaches](blocking-approaches.md) -- comprehensive comparison of all approaches
- [NE Filter Deep Dive](ne-filter-deep-dive.md) -- NEFilterDataProvider analysis + prototype code
- [SelfControl Analysis](selfcontrol-analysis.md) -- how SelfControl handles dual-layer blocking
- [Local DNS Resolver](local-dns-resolver.md) -- dnsmasq/unbound evaluation
- [Existing Tools Deep Dive](existing-tools-deep-dive.md) -- SelfControl, LuLu, Pi-hole, Focus Firewall, mitmproxy
