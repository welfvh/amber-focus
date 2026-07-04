# NEFilterDataProvider Deep Dive

Research compiled 2026-02-12 for cc-focus.

This document is a comprehensive evaluation of NEFilterDataProvider as a replacement blocking mechanism for cc-focus, which currently uses `/etc/hosts` + `pf` firewall rules.

---

## Table of Contents

1. [Apple Developer Entitlements (2026)](#1-apple-developer-entitlements-2026)
2. [LuLu as Reference Implementation](#2-lulu-as-reference-implementation)
3. [System Extension <-> Node.js Communication](#3-system-extension--nodejs-communication)
4. [Minimal Viable App Bundle](#4-minimal-viable-app-bundle)
5. [ECH (Encrypted ClientHello) Timeline](#5-ech-encrypted-clienthello-timeline)
6. [Practical Considerations](#6-practical-considerations)
7. [Recommendations for cc-focus](#7-recommendations-for-cc-focus)

---

## 1. Apple Developer Entitlements (2026)

### What entitlements are needed?

A NEFilterDataProvider-based content filter on macOS requires these entitlements:

**On the system extension target:**

```xml
<!-- Extension.entitlements -->
<key>com.apple.developer.networking.networkextension</key>
<array>
    <string>content-filter-provider</string>
</array>
```

**However** -- and this is critical -- the entitlement value changes based on distribution method:

| Distribution | Entitlement Value |
|---|---|
| Mac App Store | `content-filter-provider` |
| Developer ID (non-App Store) | `content-filter-provider-systemextension` |
| Development (Xcode) | `content-filter-provider` |

The `-systemextension` suffix is **required for Developer ID distribution**. This is a purely bureaucratic distinction -- the code is identical, but the provisioning profile must contain the `-systemextension` variant. This mismatch trips up many developers. ([Source: Network Extension Entitlement Woes](https://www.nubco.xyz/blog/networkextension-entitlements/index.html))

**On the container app:**

```xml
<!-- App.entitlements -->
<key>com.apple.developer.system-extension.install</key>
<true/>
```

This lets the container app activate/deactivate the system extension via `OSSystemExtensionRequest`. ([Source: Apple System Extension Entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.system-extension.install))

### Is special Apple approval required?

**No, not since November 2016.** Apple changed the policy for Network Extension providers, making the `com.apple.developer.networking.networkextension` entitlement available to any developer like any other standard capability. Prior to 2016, it was a managed capability requiring explicit Apple authorization.

The one exception is Network Extension **app push providers** (introduced in iOS 14, 2020), which still require managed capability approval. Content filter providers do not. ([Source: Apple Developer Forums thread 67613](https://developer.apple.com/forums/thread/67613))

However, the **System Extension entitlement** (`com.apple.developer.system-extension.install`) is also needed on the container app. This is documented as freely available for Developer ID distribution and does not require special Apple approval. ([Source: Apple System Extensions documentation](https://developer.apple.com/system-extensions/))

**Bottom line:** As of 2026, an individual developer with a $99/year Apple Developer Program membership can get all required entitlements without any special application or approval process.

### Individual developers

There are no reports of individual developers being rejected for NE content filter entitlements -- because no special approval is needed. LuLu (Objective-See, Patrick Wardle) is an individual-developer project that ships with these entitlements via Developer ID distribution. Focus Firewall (focusfirewall.com) is another small-team/individual project using the same approach.

### macOS Sequoia / Tahoe changes

No breaking changes to NEFilterDataProvider entitlements have been introduced in macOS Sequoia (15) or Tahoe (26). The user approval flow moved from "Privacy & Security" settings (pre-Sequoia) to "Login Items & Extensions" settings in macOS Sequoia 15+. ([Source: Apple Support](https://support.apple.com/en-us/120363))

WWDC 2025 introduced a **new** `NEURLFilter` API (separate from NEFilterDataProvider) for privacy-preserving URL-level filtering using Private Information Retrieval and bloom filters. This is complementary, not a replacement -- more suited to SafeBrowsing-style malware detection than domain blocking. ([Source: WWDC25 Session 234](https://developer.apple.com/videos/play/wwdc2025/234/), [Source: textslashplain.com analysis](https://textslashplain.com/2025/06/10/apple-url-filter-api/))

### Local development without entitlements

**Yes, you can develop and test by disabling SIP:**

1. Boot into Recovery Mode (hold power button on Apple Silicon).
2. Run `csrutil disable` in Terminal.
3. Build and sign the app/extension with a development certificate (not Developer ID).
4. The system will load the system extension without checking for the production entitlement.

**Important caveats:**
- Do this on a test machine or VM, not your daily driver.
- With SIP disabled, the entitlement check is bypassed entirely -- any development-signed system extension will load.
- For production, re-enable SIP and sign with Developer ID + proper provisioning profile.

An alternative workflow for development without disabling SIP:
1. Create an App ID in the Apple Developer portal with the "System Extension" and "Network Extension" capabilities enabled.
2. Create a development provisioning profile for that App ID.
3. Sign with an Apple Development certificate (not Developer ID).
4. The development profile allows the entitlement to be used on registered development devices.

([Source: Apple Developer Forums thread 131240](https://forums.developer.apple.com/forums/thread/131240), [Source: Apple Developer Forums thread 665478](https://developer.apple.com/forums/thread/665478))

---

## 2. LuLu as Reference Implementation

LuLu is the best open-source reference for NEFilterDataProvider on macOS. It is a free, GPLv3-licensed firewall by Patrick Wardle (Objective-See). Repository: https://github.com/objective-see/LuLu

### Project structure

```
LuLu/
  lulu.xcworkspace          # Xcode workspace
  LuLu/
    LuLu.xcodeproj          # Xcode project (multiple targets)
    App/                     # Container app (main UI)
      AppDelegate.m          # App lifecycle, extension activation
      WelcomeWindowController.m  # User onboarding / extension approval flow
      ...
    Extension/               # System extension (NEFilterDataProvider)
      FilterDataProvider.m   # Core: handleNewFlow: implementation
      ...
    Shared/                  # Code shared between app and extension
      consts.h               # Bundle IDs, Mach service names
      XPCDaemonProto.h       # XPC protocol definitions
      ...
    Tests/                   # Test suite
  DMG/                       # Disk image packaging assets
```

The project has **two primary targets**:
1. **LuLu.app** -- the container app (menu bar UI)
2. **LuLu Extension** -- the system extension (NEFilterDataProvider subclass)

Both share code via the `Shared/` directory. The extension's bundle ID must be a child of the container app's bundle ID (e.g., `com.objective-see.lulu` and `com.objective-see.lulu.extension`).

### Container app <-> System extension communication

LuLu uses **XPC with Mach services** for bidirectional IPC between the container app and the system extension.

**Key mechanism:**
- The system extension declares a `NEMachServiceName` in its `Info.plist`, which registers a Mach service that other processes can connect to.
- The container app creates an `NSXPCConnection` to this Mach service.
- Both sides define protocol interfaces for what methods can be called.

**Two XPC protocols:**

```objc
// XPCDaemonProtocol — App calls these on the extension/daemon
- (void)getPreferences:(void(^)(NSDictionary*))reply;
- (void)updatePreferences:(NSDictionary*)prefs;
- (void)getRules:(void(^)(NSArray*))reply;
- (void)addRule:(NSDictionary*)rule;
- (void)deleteRule:(NSString*)key;
```

```objc
// XPCUserProtocol — Extension/daemon calls these on the app
- (void)alertShow:(NSDictionary*)alert reply:(void(^)(NSDictionary*))reply;
- (void)rulesChanged;
```

**Key files:**
- `XPCDaemonClient.m` (app side) -- initiates XPC connection to the extension
- `XPCDaemon.m` (extension side) -- handles incoming XPC requests
- `XPCDaemonProto.h` (shared) -- protocol definitions
- `consts.h` (shared) -- Mach service name constant (`DAEMON_MACH_SERVICE`)

**Alert flow (critical XPC path):**
1. `FilterDataProvider` receives a new flow via `handleNewFlow:`
2. No matching rule exists -- flow is paused
3. Extension calls `alertShow:reply:` on the app via XPC
4. App shows an alert window to the user
5. User responds (allow/block)
6. Response travels back via XPC reply block
7. Extension creates a rule and resumes the flow with the verdict

### How did LuLu get approved?

LuLu doesn't need special approval beyond a standard Apple Developer Program membership. The NE content filter entitlement has been freely available since 2016. LuLu is signed with Patrick Wardle's Developer ID certificate and notarized by Apple. The entitlement is included in the provisioning profile as `content-filter-provider-systemextension` (Developer ID variant).

### Compiling LuLu yourself

Per [issue #568](https://github.com/objective-see/LuLu/issues/568), compiling LuLu with your own identity requires:
1. Apple Developer Program membership ($99/year)
2. Changing all hardcoded bundle IDs in `Shared/consts.h` to match your own
3. Creating provisioning profiles with System Extension + Network Extension capabilities
4. Signing with your Developer ID certificate
5. **Or**: Disable SIP to bypass entitlement checks during development

---

## 3. System Extension <-> Node.js Communication

cc-focus's server is Node.js/TypeScript on localhost:8053. The NE system extension would be Swift. We need a reliable IPC channel between them.

### Option analysis

| Method | Feasible? | Notes |
|---|---|---|
| XPC (Mach services) | No | XPC is Apple-native only (Obj-C/Swift). Node.js cannot be an XPC client or server without native bindings, and the effort isn't worth it. |
| **Local HTTP (localhost)** | **Yes -- recommended** | The macOS NE sandbox is very liberal (unlike iOS). The extension **can make outbound network connections**, including to localhost. This is confirmed by Apple's own documentation and developer forum posts. |
| Unix domain sockets | Yes | Works on macOS. The extension can open UDS connections. Node.js has native support via the `net` module. |
| App Groups / shared UserDefaults | Partially | Good for simple config (blocklist), but not for request/response patterns. Synchronization between processes is unreliable (no cross-process KVO). |
| File watching | Yes (fragile) | Extension writes to a file, Node.js watches it. High latency, race conditions, not recommended for real-time decisions. |
| Named pipes / FIFO | Yes | Works but more complex than HTTP/UDS with no real advantage. |

### Recommended approach: localhost HTTP

**The macOS sandbox for NEFilterDataProvider is explicitly described as "very liberal"** by Apple engineers. Unlike iOS (where the data provider cannot make any network calls), macOS allows the extension to make outbound HTTP requests.

From Apple Developer Forums ([thread 127981](https://developer.apple.com/forums/thread/127981)):
> "The architecture on macOS is very different [from iOS], and there is no filter control provider on macOS. The sandbox for macOS is very liberal, and thus you'll be able to make outbound network connections just fine."

**Architecture:**

```
cc-focus Node.js server (localhost:8053)
    |
    | HTTP (localhost)
    |
NEFilterDataProvider system extension (Swift)
    |
    | Intercepts all network flows
    |
    Reads blocklist from Node.js server
    Reports status back to Node.js server
```

**How it would work:**

1. On startup, the extension fetches the current blocklist from `http://localhost:8053/api/blocked-list` (a new endpoint).
2. The extension caches the blocklist in memory.
3. For each new flow, the extension checks `flow.remoteHostname` or parses SNI from the TLS ClientHello against the cached blocklist.
4. Periodically (every 5-10 seconds), the extension polls `localhost:8053/api/blocked-list` for updates.
5. Alternatively, the extension could use a lightweight push mechanism: the Node.js server writes to a shared file (App Group container) and the extension watches it -- but polling HTTP is simpler and more reliable.

**Critical consideration: filter your own traffic.** The extension must NOT filter its own HTTP requests to localhost, or it will deadlock. Use `NEFilterRule` with `NENetworkRule` to exclude traffic to `127.0.0.1:8053` from filtering:

```swift
let localRule = NENetworkRule(
    remoteNetwork: NWHostEndpoint(hostname: "127.0.0.1", port: "8053"),
    remotePrefix: 32,
    localNetwork: nil,
    localPrefix: 0,
    protocol: .TCP,
    direction: .outbound
)
let filterRule = NEFilterRule(networkRule: localRule, action: .allow)
let settings = NEFilterSettings(rules: [filterRule], defaultAction: .filterExcept)
apply(settings) { error in ... }
```

### Alternative: Unix domain socket

If HTTP feels too heavy for IPC, Unix domain sockets are a solid alternative. The Node.js server can listen on `/tmp/cc-focus.sock` and the Swift extension can connect to it. Node.js `net.createServer()` supports UDS natively. The protocol could be simple JSON-over-newline.

---

## 4. Minimal Viable App Bundle

### What's the absolute minimum?

A NEFilterDataProvider system extension requires:

1. **A container `.app` bundle** -- this is non-negotiable. System extensions must be embedded inside an application bundle. A bare CLI binary cannot host a system extension.

2. **The system extension** -- a `.systemextension` bundle inside the app's `Contents/Library/SystemExtensions/` directory.

3. **Proper code signing and notarization.**

### Container app: can it be headless / menu bar only?

**Yes.** The container app does not need a window, dock icon, or any visible UI. It can be:
- A menu bar app (`LSUIElement = true` in Info.plist, no dock icon)
- A completely headless background app that just activates the extension on launch

However, the first time the extension is loaded, macOS will prompt the user in System Settings to approve it. The container app typically guides the user through this (like LuLu's WelcomeWindowController).

**Minimum container app code (Swift):**

```swift
import Cocoa
import SystemExtensions
import NetworkExtension

@main
class AppDelegate: NSObject, NSApplicationDelegate, OSSystemExtensionRequestDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Activate the system extension
        let request = OSSystemExtensionRequest.activationRequest(
            forExtensionWithIdentifier: "com.welf.ccfocus.extension",
            queue: .main
        )
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
    }

    // MARK: - OSSystemExtensionRequestDelegate

    func request(_ request: OSSystemExtensionRequest,
                 actionForReplacingExtension existing: OSSystemExtensionProperties,
                 withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
        return .replace
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        // User must approve in System Settings
        print("Please approve the system extension in System Settings > Login Items & Extensions")
    }

    func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        guard result == .completed else { return }
        enableContentFilter()
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        print("System extension activation failed: \(error)")
    }

    func enableContentFilter() {
        NEFilterManager.shared().loadFromPreferences { error in
            if let error = error {
                print("Load preferences error: \(error)")
                return
            }

            let config = NEFilterProviderConfiguration()
            config.filterSockets = true
            config.filterPackets = false

            NEFilterManager.shared().providerConfiguration = config
            NEFilterManager.shared().isEnabled = true

            NEFilterManager.shared().saveToPreferences { error in
                if let error = error {
                    print("Save preferences error: \(error)")
                } else {
                    print("Content filter enabled")
                }
            }
        }
    }
}
```

### Minimum system extension code (Swift):

```swift
import NetworkExtension

class FilterDataProvider: NEFilterDataProvider {

    private var blockedDomains: Set<String> = []

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        // Fetch blocklist from cc-focus server
        fetchBlocklist()

        // Configure filter rules: filter everything except localhost:8053
        let settings = NEFilterSettings(rules: [], defaultAction: .filterExcept)
        apply(settings) { error in
            completionHandler(error)
        }
    }

    override func stopFilter(with reason: NEProviderStopReason,
                             completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        // Check hostname from flow metadata
        if let hostname = flow.url?.host?.lowercased() ?? (flow as? NEFilterSocketFlow)?.remoteHostname?.lowercased() {
            for domain in blockedDomains {
                if hostname == domain || hostname.hasSuffix(".\(domain)") {
                    return .drop()
                }
            }
        }
        return .allow()
    }

    private func fetchBlocklist() {
        // HTTP GET to localhost:8053/api/blocked-list
        guard let url = URL(string: "http://localhost:8053/api/blocked-list") else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data = data,
                  let domains = try? JSONDecoder().decode([String].self, from: data) else { return }
            self.blockedDomains = Set(domains)
        }.resume()
    }
}
```

### Bundle structure on disk

```
cc-focus-helper.app/
  Contents/
    Info.plist                          # App metadata, LSUIElement=true
    MacOS/
      cc-focus-helper                   # Container app binary
    Library/
      SystemExtensions/
        com.welf.ccfocus.extension.systemextension/
          Contents/
            Info.plist                  # Extension metadata, NEProviderClasses
            MacOS/
              com.welf.ccfocus.extension  # Extension binary
    Resources/
      (optional assets)
    _CodeSignature/
      CodeResources
```

### Code signing requirements

1. **Developer ID Application** certificate for the container app.
2. **Developer ID Application** certificate for the system extension (same cert, different target).
3. **Hardened Runtime** must be enabled on both targets.
4. **Provisioning profiles** for both targets with the appropriate entitlements.
5. Both targets must have the **same Team ID**.
6. The extension's bundle ID must be a child of the app's bundle ID.

### Notarization

Required for Gatekeeper to allow the app. Process:
1. Archive the app in Xcode (or `xcodebuild archive`).
2. Submit to Apple's notary service: `xcrun notarytool submit cc-focus-helper.zip --apple-id ... --team-id ... --password ...`
3. Wait for approval (usually 5-15 minutes).
4. Staple the ticket: `xcrun stapler staple cc-focus-helper.app`

After stapling, the app can be distributed as a `.dmg` or `.zip` -- Gatekeeper will recognize it as notarized.

### Can the container app be a CLI?

**No.** The `OSSystemExtensionRequest` API requires a GUI application context (NSApplication). A pure CLI tool cannot activate system extensions. However, the app can be an `LSUIElement` (no dock icon, no menu bar) that runs completely invisibly and only shows UI when needed (e.g., for the extension approval flow).

([Source: Apple Developer Forums thread 131240](https://forums.developer.apple.com/forums/thread/131240), [Source: Apple System Extensions documentation](https://developer.apple.com/documentation/systemextensions))

---

## 5. ECH (Encrypted ClientHello) Timeline

ECH encrypts the SNI field in TLS ClientHello, which is the primary mechanism NEFilterDataProvider uses for hostname identification on HTTPS flows. Understanding the ECH timeline is critical for evaluating the longevity of an SNI-based blocking approach.

### Current status (February 2026)

- **IETF standardization**: ECH was approved for publication as an RFC in 2025. The latest draft is [draft-ietf-tls-esni-25](https://datatracker.ietf.org/doc/draft-ietf-tls-esni/25/). It has not yet been published as a final RFC but is effectively frozen and widely implemented. ([Source: Feisty Duck newsletter](https://www.feistyduck.com/newsletter/issue_127_encrypted_client_hello_approved_for_publication))

- **Server-side deployment**: Cloudflare enabled ECH by default for all customers (including free tier) in late 2024. ECH cannot be disabled on Cloudflare's free plan. Cloudflare is effectively the only major CDN with production ECH support -- 43% of TLS 1.3 servers with ECH are Cloudflare. Only ~6 non-Cloudflare servers had ECH configs in 2025 measurements. ([Source: RSAC 2025 Conference analysis](https://www.security.com/expert-perspectives/navigating-encrypted-client-hello-ech-insights-rsac-2025))

- **Website coverage**: 4.2% of top 100K websites and 9.2% of top 1M websites support ECH (overwhelmingly via Cloudflare). ([Source: TU Dresden research](https://netd.cs.tu-dresden.de/papers/mgsw-ptcve-25.pdf))

### Browser support

| Browser | ECH Status | Notes |
|---|---|---|
| Firefox | Enabled by default since Firefox 119 | First major browser to ship ECH |
| Chrome | Enabled by default | Shipped October 2023 |
| Edge | Enabled by default | Chromium-based, follows Chrome |
| Brave | Enabled by default | Chromium-based |
| Safari | **Not implemented** | WebKit has indicated interest but has not shipped ECH as of macOS Tahoe 26 |

([Source: Cisco ECH Defense Strategies](https://secure.cisco.com/secure-firewall/docs/encrypted-client-hello-defense-strategies-how-cisco-secure-firewall-tackles-ech), [Source: Mozilla ECH FAQ](https://support.mozilla.org/en-US/kb/faq-encrypted-client-hello))

A widely cited figure claims "59% of browsers actively use ECH," but this is misleading for cc-focus's use case. The relevant question is: **for a given blocked site (e.g., twitter.com), will ECH be active?**

The answer depends on whether the site's CDN/server supports ECH **and** the browser supports ECH. Currently:
- Twitter/X: Not on Cloudflare. ECH not supported. **SNI visible.**
- Reddit: On Fastly, not Cloudflare. ECH not supported. **SNI visible.**
- YouTube: Google infrastructure. ECH not supported. **SNI visible.**
- Hacker News: On Cloudflare. **ECH active in Chrome/Firefox.** SNI encrypted.
- Many smaller sites on Cloudflare: **ECH active.**

### When does SNI-based filtering become unreliable?

**Not yet, for cc-focus's primary targets.** The major distraction sites (Twitter, YouTube, Reddit, Instagram, Netflix) are NOT on Cloudflare and do not support ECH. SNI-based filtering works reliably for these.

However, the trajectory is clear:
- **2026-2027**: More CDNs (Fastly, Akamai, AWS CloudFront) will likely adopt ECH.
- **2027-2028**: Majority of HTTPS traffic could have ECH active.
- **Safari**: When Apple ships ECH in Safari, the last major holdout falls.

**Practical risk for cc-focus (next 1-2 years):** Low for primary blocked sites. Medium for Cloudflare-hosted sites (Hacker News, many Substacks, smaller sites).

### Does NEFilterDataProvider have fallback when SNI is encrypted?

**Partially.** When ECH is active:

1. **`flow.url?.host`**: Still works for flows created via WebKit or NSURLSession, because the hostname comes from the application layer, not the TLS handshake. Safari flows will have the hostname available even with ECH.

2. **`(flow as? NEFilterSocketFlow)?.remoteHostname`**: This is populated from the system's knowledge of the connection. For apps using the system resolver, the hostname may still be available from the DNS resolution step.

3. **TLS ClientHello SNI parsing**: Will see the "outer" (decoy) SNI, not the real hostname. The outer SNI is typically the CDN's general hostname (e.g., `cloudflare-ech.com`), which is useless for domain-level blocking.

4. **IP-based fallback**: You can still see the destination IP address. Combined with reverse DNS or a maintained IP-to-domain mapping, this provides partial coverage -- but it's the same fragile approach as pf rules.

5. **DNS snooping**: If you also run a DNS proxy (NEDNSProxyProvider), you can correlate DNS queries with subsequent connections. The DNS query reveals the domain even if the TLS handshake hides it. This is a common technique used by enterprise firewalls.

**Bottom line**: ECH does not immediately break NEFilterDataProvider-based blocking, but it degrades it progressively as ECH adoption grows. A layered approach (NE content filter + DNS proxy + IP fallback) provides the most resilience.

---

## 6. Practical Considerations

### Performance impact

NEFilterDataProvider adds a kernel-to-userspace callout for every new TCP/UDP flow. Based on real-world data:

- **LuLu**: Reports negligible CPU and memory impact. LuLu's description states "minimal performance impact" and user reports confirm this.
- **Focus Firewall** (commercial app using NE content filter): Claims <100MB RAM, negligible CPU.
- **Apple's guidance** (WWDC 2019): System extensions run independently of any logged-in user. The framework is designed for always-on filtering with minimal overhead.
- **Known issue**: Using NETransparentProxyProvider for system-wide proxying has "average to poor performance CPU and network-speed wise" according to developer reports. But NEFilterDataProvider (which only makes allow/drop verdicts, not proxying) is much lighter.

**For cc-focus's use case** (simple domain allow/drop, no data inspection), the performance impact should be negligible. The extension checks a hostname against a set of ~100 domains -- this is a trivial operation.

### Crash behavior: fail-open

**This is not well-documented by Apple**, but based on developer reports and observed behavior:

- **When the system extension crashes**: macOS automatically restarts it (system extensions are managed by the system, similar to launchd services). During the restart window (typically < 1 second), **traffic passes through unfiltered** (fail-open behavior).

- **When the extension is explicitly disabled**: All traffic passes normally. The content filter is simply removed from the network stack.

- **When the extension is slow to respond**: TCP flows may be paused indefinitely waiting for a verdict. UDP flows will be **dropped** if not resumed within 10 seconds of being paused.

- **Worst case observed**: Some developers report that a malfunctioning extension can make "the entire system network unreachable" -- essentially a fail-closed state. Disabling the content filter in System Settings restores connectivity.

**For cc-focus**: Fail-open on crash is actually acceptable for a self-control tool. A brief window of unblocked access during an extension restart is not a meaningful bypass vector. The extension restarts automatically in under a second.

### Apple apps bypass the content filter

**Important limitation**: Apple maintains an undocumented `ContentFilterExclusionList` that exempts approximately 50 Apple processes from NEFilterDataProvider. Maps, App Store, Software Update, and other Apple services bypass the content filter entirely. This was discovered in macOS Big Sur (2020) and has not been fully resolved.

([Source: Open Radar FB8808172](https://openradar.appspot.com/FB8808172), [Source: Hacker News discussion](https://news.ycombinator.com/item?id=25113039))

**Impact on cc-focus**: Minimal. Apple's exempt apps are system services (Maps, App Store, etc.), not the distraction websites cc-focus blocks. Users don't browse Twitter through Apple Maps.

### User approval flow

When the system extension is first activated, the user sees a multi-step approval process:

1. **System dialog**: "cc-focus-helper wants to install a system extension" -- user clicks "Open System Settings."
2. **System Settings > Login Items & Extensions** (Sequoia+) or **Privacy & Security** (pre-Sequoia): User toggles the extension to "Allow."
3. **Network Extension dialog**: "cc-focus-helper wants to filter network content" -- user clicks "Allow."
4. macOS may require a **restart** on some versions (Sequoia reportedly requires restart for some extensions).

This is a one-time process. After approval, the extension persists across reboots. Updates to the extension trigger a simpler replacement flow (step 1 only, with "Replace" option).

### Can the extension be auto-approved?

**Not without MDM.** For non-MDM-managed personal Macs, user approval through System Settings is always required. This is by design -- Apple enforces user consent for anything that filters network traffic.

For cc-focus (personal tool), this is fine. The user installs it intentionally.

### Interaction with VPNs and other NE providers

- **Multiple NE providers can coexist**, but with known issues. Memory leaks and conflicts have been reported when multiple network extensions are active simultaneously.
- **Little Snitch + cc-focus**: Could conflict. Both would be NEFilterDataProvider instances. macOS chains them, but the ordering and interaction are not well-documented.
- **VPNs**: The content filter sees flows **before** they enter a VPN tunnel (the VPN is a separate NE provider at a lower priority). This means cc-focus would still block traffic even when a VPN is active -- which is correct behavior for a self-control tool.
- **Apple apps bypass**: As noted above, Apple's exempt apps bypass all NE filters and VPNs.

([Source: Michael Tsai blog](https://mjtsai.com/blog/2020/10/22/apple-apps-exempt-from-network-filters-and-vpns/))

### Hostname availability per browser

**Critical issue**: Not all browsers provide `remoteHostname` equally.

| Browser | `flow.remoteHostname` | `flow.url?.host` | Notes |
|---|---|---|---|
| Safari | Yes | Yes (WebKit) | Most complete metadata |
| Firefox | Yes | Partial | Provides hostname |
| Chrome | **IP address only** | No | Chrome uses its own DNS resolver; system only sees the IP |
| Arc / Brave / Edge | **IP address only** | No | Chromium-based, same as Chrome |

([Source: Apple Developer Forums thread 760266](https://developer.apple.com/forums/thread/760266))

**This is a fundamental problem.** Chrome (and all Chromium browsers) resolve DNS internally, so the system extension only sees the IP address. Workarounds:

1. **Parse SNI from TLS ClientHello**: For HTTPS flows, request the first bytes of outbound data via `filterDataVerdict(withFilterInbound:false, peekInboundBytes:0, filterOutbound:true, peekOutboundBytes:256)`. Parse the ClientHello to extract the SNI extension. This works for Chrome traffic because SNI is sent regardless of how DNS was resolved.

2. **Reverse DNS lookup**: Use `getnameinfo()` or `DNSServiceQueryRecord()` to resolve the IP back to a hostname. Unreliable for CDN-hosted sites (many domains share one IP).

3. **DNS snooping**: If cc-focus also runs a DNS proxy (NEDNSProxyProvider), it can log all DNS queries and maintain an IP-to-domain mapping. When the content filter sees an IP-only flow, it checks the mapping.

**Recommended approach for cc-focus**: Option 1 (SNI parsing) is the most reliable. It works for all browsers regardless of their DNS resolution method, and does not require a second NE provider. The SNI field is available in the first outbound packet of any TLS connection.

Here is a sketch of SNI extraction from TLS ClientHello bytes:

```swift
func extractSNI(from data: Data) -> String? {
    // TLS record: byte 0 = content type (0x16 = handshake)
    guard data.count > 5, data[0] == 0x16 else { return nil }

    // Skip TLS record header (5 bytes) and handshake header (4 bytes)
    var offset = 5 + 4

    // Skip client version (2) + random (32) = 34 bytes
    offset += 34

    // Skip session ID
    guard offset < data.count else { return nil }
    let sessionIDLen = Int(data[offset])
    offset += 1 + sessionIDLen

    // Skip cipher suites
    guard offset + 1 < data.count else { return nil }
    let cipherLen = Int(data[offset]) << 8 | Int(data[offset + 1])
    offset += 2 + cipherLen

    // Skip compression methods
    guard offset < data.count else { return nil }
    let compLen = Int(data[offset])
    offset += 1 + compLen

    // Extensions length
    guard offset + 1 < data.count else { return nil }
    let extLen = Int(data[offset]) << 8 | Int(data[offset + 1])
    offset += 2

    let extEnd = offset + extLen
    while offset + 4 < extEnd && offset + 4 < data.count {
        let extType = Int(data[offset]) << 8 | Int(data[offset + 1])
        let extDataLen = Int(data[offset + 2]) << 8 | Int(data[offset + 3])
        offset += 4

        if extType == 0 { // SNI extension
            // Skip SNI list length (2 bytes) and host type (1 byte)
            guard offset + 5 <= data.count else { return nil }
            let nameLen = Int(data[offset + 3]) << 8 | Int(data[offset + 4])
            offset += 5
            guard offset + nameLen <= data.count else { return nil }
            return String(data: data[offset..<(offset + nameLen)], encoding: .utf8)
        }
        offset += extDataLen
    }
    return nil
}
```

---

## 7. Recommendations for cc-focus

### Architecture proposal

```
                    +--------------------------+
                    |   cc-focus Node.js       |
                    |   server (localhost:8053) |
                    |   - REST API / MCP       |
                    |   - Blocklist management |
                    |   - Grant/revoke logic    |
                    +----------+---------------+
                               |
                     HTTP (localhost)
                               |
                    +----------v---------------+
                    |  cc-focus-helper.app      |
                    |  (headless container)     |
                    |  - Activates extension    |
                    |  - Shows approval UI once |
                    +----------+---------------+
                               |
                    System Extension embedding
                               |
                    +----------v---------------+
                    |  NEFilterDataProvider     |
                    |  (system extension)       |
                    |  - Fetches blocklist from |
                    |    Node.js via localhost   |
                    |  - handleNewFlow: checks  |
                    |    hostname/SNI against    |
                    |    blocklist              |
                    |  - Returns allow/drop     |
                    +----------+---------------+
                               |
                     All network flows
                               |
                    +----------v---------------+
                    |  macOS network stack      |
                    +--------------------------+
```

### Migration strategy

**Phase 1: Build the NE system extension (alongside current approach)**
- Create a minimal Xcode project with container app + system extension.
- The extension fetches the blocklist from the existing Node.js server.
- Keep `/etc/hosts` + pf as fallback layers.
- Test with SIP disabled on a dev machine.

**Phase 2: Get Developer ID signing working**
- Create provisioning profiles with NE + System Extension entitlements.
- Sign and notarize the app.
- Package as a DMG or installer.

**Phase 3: Deprecate hosts/pf for blocked domains**
- Once the NE extension is stable, remove the `/etc/hosts` manipulation for domains that the extension handles.
- Keep pf for IP-range blocking of sites with known AS numbers (Twitter, Meta) as an additional layer.
- Keep the MITM proxy for delay/friction features (NE can't do progressive delays).

### Effort estimate

| Task | Effort |
|---|---|
| Xcode project setup (container app + extension targets) | 2-3 hours |
| FilterDataProvider implementation (handleNewFlow + SNI parsing) | 4-6 hours |
| localhost HTTP IPC with Node.js server | 2-3 hours |
| Container app (activation UI, extension management) | 2-3 hours |
| Code signing + provisioning profiles | 2-4 hours |
| Notarization pipeline | 1-2 hours |
| Testing + debugging | 4-8 hours |
| Integration with existing cc-focus server | 2-4 hours |
| **Total** | **~20-35 hours** |

### Key risks

1. **Chrome/Chromium hostname blindness**: The extension won't get hostnames from Chrome flows via `remoteHostname`. Must implement SNI parsing from TLS ClientHello bytes. This is well-understood but adds implementation complexity.

2. **ECH degradation**: Within 1-2 years, SNI-based blocking will become less reliable for Cloudflare-hosted sites. Mitigation: combine with DNS-level blocking (the current `/etc/hosts` approach or a future NEDNSProxyProvider).

3. **Debugging difficulty**: System extensions are harder to debug than regular processes. Use `log stream --predicate 'subsystem == "com.welf.ccfocus"'` for real-time logging. Xcode can attach to running system extensions.

4. **macOS Tahoe compatibility**: LuLu [issue #825](https://github.com/objective-see/LuLu/issues/825) reports that the NE provider "never attaches" on macOS Tahoe 26.2. This may be a LuLu-specific issue or a Tahoe regression. Needs testing.

5. **Extension coexistence**: If the user also runs Little Snitch, LuLu, or a VPN with a network extension, there could be conflicts. Not a blocker, but may need handling.

---

## Sources

### Apple Documentation
- [NEFilterDataProvider](https://developer.apple.com/documentation/networkextension/nefilterdataprovider)
- [Content Filter Providers](https://developer.apple.com/documentation/networkextension/content-filter-providers)
- [Network Extensions Entitlement](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.developer.networking.networkextension)
- [System Extension Entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.system-extension.install)
- [System Extensions](https://developer.apple.com/documentation/systemextensions)
- [TN3134: Network Extension Provider Deployment](https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment)
- [Configuring Network Extensions](https://developer.apple.com/documentation/xcode/configuring-network-extensions)
- [handleNewFlow(_:)](https://developer.apple.com/documentation/networkextension/nefilterdataprovider/handlenewflow(_:))
- [Signing Mac Software with Developer ID](https://developer.apple.com/developer-id/)
- [Notarizing macOS Software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Capability Requests](https://developer.apple.com/help/account/capabilities/capability-requests/)

### Apple WWDC Sessions
- [Network Extensions for the Modern Mac (WWDC 2019)](https://developer.apple.com/videos/play/wwdc2019/714/)
- [Filter and Tunnel Network Traffic with NetworkExtension (WWDC 2025)](https://developer.apple.com/videos/play/wwdc2025/234/)

### Apple Developer Forums
- [Network Extension entitlement policy change (2016)](https://developer.apple.com/forums/thread/67613)
- [HTTP requests from network extensions](https://developer.apple.com/forums/thread/127981)
- [Content filter remoteEndpoint hostname availability](https://developer.apple.com/forums/thread/760266)
- [Web filter implementation on macOS](https://developer.apple.com/forums/thread/662026)
- [NEFilterDataProvider best practices](https://forums.developer.apple.com/forums/thread/735504)
- [Getting started with System Extensions](https://developer.apple.com/forums/thread/665478)
- [Building system extension without entitlement](https://forums.developer.apple.com/forums/thread/131240)
- [XPC between container app and system extension](https://developer.apple.com/forums/thread/713744)
- [NEFilterDataProvider hostname from Chrome](https://developer.apple.com/forums/thread/690654)
- [Entitlement request for System Extensions](https://developer.apple.com/forums/thread/735356)

### LuLu (Reference Implementation)
- [LuLu GitHub Repository](https://github.com/objective-see/LuLu)
- [LuLu Extension Management (DeepWiki)](https://deepwiki.com/objective-see/LuLu/6.2-extension-management)
- [How to compile LuLu (Issue #568)](https://github.com/objective-see/LuLu/issues/568)
- [LuLu Tahoe 26.2 issue (Issue #825)](https://github.com/objective-see/LuLu/issues/825)

### ECH (Encrypted ClientHello)
- [IETF Draft: TLS Encrypted Client Hello (draft-25)](https://datatracker.ietf.org/doc/draft-ietf-tls-esni/25/)
- [ECH Approved for Publication (Feisty Duck)](https://www.feistyduck.com/newsletter/issue_127_encrypted_client_hello_approved_for_publication)
- [Navigating ECH: RSAC 2025 Conference (security.com)](https://www.security.com/expert-perspectives/navigating-encrypted-client-hello-ech-insights-rsac-2025)
- [TU Dresden: ECH Deployment Research](https://netd.cs.tu-dresden.de/papers/mgsw-ptcve-25.pdf)
- [Cisco: ECH Defense Strategies](https://secure.cisco.com/secure-firewall/docs/encrypted-client-hello-defense-strategies-how-cisco-secure-firewall-tackles-ech)
- [Mozilla: ECH FAQ](https://support.mozilla.org/en-US/kb/faq-encrypted-client-hello)
- [Chrome: ECH Status](https://chromestatus.com/feature/6196703843581952)
- [CIS: Security Control Changes due to ECH](https://www.cisecurity.org/insights/blog/security-control-changes-due-to-tls-encrypted-clienthello)
- [CDT: Encrypted Client Hello Closing the SNI Gap](https://cdt.org/insights/encrypted-client-hello-closing-the-sni-metadata-gap/)

### Apple Apps Bypass Issue
- [Open Radar FB8808172](https://openradar.appspot.com/FB8808172)
- [Hacker News: Apple apps bypass NEFilterDataProvider](https://news.ycombinator.com/item?id=25113039)
- [Michael Tsai: Apple Apps Exempt from Network Filters](https://mjtsai.com/blog/2020/10/22/apple-apps-exempt-from-network-filters-and-vpns/)

### Other
- [Network Extension Entitlement Woes (nubco.xyz)](https://www.nubco.xyz/blog/networkextension-entitlements/index.html)
- [Apple NEURLFilter API analysis (textslashplain.com)](https://textslashplain.com/2025/06/10/apple-url-filter-api/)
- [macOS System Extensions overview (Apple Support)](https://support.apple.com/en-us/120363)
- [SelfControl GitHub Repository](https://github.com/SelfControlApp/selfcontrol)
