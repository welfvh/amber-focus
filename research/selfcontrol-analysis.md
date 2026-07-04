# SelfControl (macOS) -- Technical Analysis

Source: https://github.com/SelfControlApp/selfcontrol
Analyzed: 2026-02-12
License: GPL v3

## Overview

SelfControl is an open-source macOS app that blocks access to websites for a user-specified duration. Its defining feature is that the block **cannot be undone early** -- not by deleting the app, rebooting, or killing processes. It achieves this through a dual-layer blocking mechanism (pf firewall + /etc/hosts) enforced by a privileged daemon that actively re-adds rules if they're tampered with.

---

## 1. How It Blocks Websites

SelfControl uses **two simultaneous blocking mechanisms**:

### Layer 1: pf (Packet Filter) Firewall Rules

The macOS packet filter (`/sbin/pfctl`) is used to block traffic at the IP level. This is the primary and most robust blocking layer.

**How it works:**

1. Domain names on the blocklist are resolved to IP addresses via DNS (`CFHostStartInfoResolution`)
2. For each resolved IP, pf rules are generated:
   - Blocklist mode: `block return out proto tcp from any to <IP>` and same for udp
   - Allowlist mode: `block return out proto tcp from any to any` (block everything), then `pass out proto tcp from any to <IP>` for allowed sites
3. Rules are written to `/etc/pf.anchors/org.eyebeam`
4. A reference to this anchor file is appended to `/etc/pf.conf`:
   ```
   anchor "org.eyebeam"
   load anchor "org.eyebeam" from "/etc/pf.anchors/org.eyebeam"
   ```
5. pf is enabled and rules loaded via `pfctl -E -f /etc/pf.conf -F states`
6. The `-F states` flag flushes existing connection states, killing any active connections to blocked IPs
7. A PF token is saved to `/etc/SelfControlPFToken` for clean removal later

**Key detail:** The `block return` policy is used (not `block drop`), which sends a TCP RST / ICMP unreachable back to the client. This gives browsers a fast failure rather than a timeout.

**Allowlist mode** also explicitly passes DNS (port 53), NTP (port 123), DHCP (ports 67/68), and mDNS (port 5353) so basic networking still works.

Source: `/tmp/selfcontrol/Block Management/PacketFilter.m`

### Layer 2: /etc/hosts File Modification

For domain-based blocking (not IP-based), entries are added to `/etc/hosts` mapping blocked domains to `0.0.0.0` and `::` (IPv4 and IPv6 null addresses).

**Format:**
```
# BEGIN SELFCONTROL BLOCK
0.0.0.0	twitter.com
::	twitter.com
0.0.0.0	www.twitter.com
::	www.twitter.com
# END SELFCONTROL BLOCK
```

Before modifying `/etc/hosts`, a backup is created at `/etc/hosts.bak`.

**VPN bypass protection:** `HostFileBlockerSet` also modifies backup host files used by VPN clients (Juniper Pulse, Cisco AnyConnect) that could otherwise bypass the hosts block:
- `/etc/pulse-hosts.bak`
- `/etc/jnpr-pulse-hosts.bak`
- `/etc/pulse.hosts.bak`
- `/etc/jnpr-nc-hosts.bak`
- `/etc/hosts.ac`

**Why two layers?** The hosts file provides name-level blocking (all IPs for a domain, including future DNS changes). pf provides IP-level blocking (works even if apps bypass the system resolver). Together they cover most bypass vectors.

Source: `/tmp/selfcontrol/Block Management/HostFileBlocker.m`, `HostFileBlockerSet.m`, `BlockManager.m`

### Domain-to-IP Resolution

When blocking a domain name, SelfControl:
1. Resolves it to all known IPs via `CFHostStartInfoResolution` (both IPv4 and IPv6)
2. Adds pf rules for each resolved IP
3. Adds hosts file entries for the domain name

Special handling exists for:
- **Google/YouTube**: In blocklist mode, Google domains are blocked only via hosts (not by IP) because Google's IP ranges overlap many services. In allowlist mode, hardcoded Google IP ranges (from `goog.json`) are used.
- **Facebook**: Hardcoded IP ranges are added due to many mirror subdomains resolving to different IPs.
- **Common subdomains**: `www.` prefix is auto-added/removed. `api.twitter.com` is added when blocking `twitter.com`. Netflix CDN domains like `nflxext.com` are included.

---

## 2. Why It's "Unbreakable"

### Privileged Daemon (`selfcontrold`)

The core enforcement is a **privileged XPC daemon** (`org.eyebeam.selfcontrold`) installed via `SMJobBless` into `/Library/PrivilegedHelperTools/`. This runs as **root** and is managed by launchd at the system level.

**Key properties:**
- Runs as root (EUID 0), so it has full write access to `/etc/hosts`, `/etc/pf.conf`, and `/etc/pf.anchors/`
- Registered with launchd as a system-level daemon, so it persists across reboots and user sessions
- Uses `NSXPCListener` with Mach service name `org.eyebeam.selfcontrold`

### Checkup Timer (1-second interval)

The daemon runs a checkup every **1 second** that:

1. Checks if the block timer has expired -- if so, removes the block
2. Checks if the block settings have been tampered with (e.g., `BlockIsRunning` set to NO without the timer expiring) -- if detected, **removes the block** but flags tampering
3. Every **15 seconds**, runs an integrity check that verifies pf rules and hosts file entries are still in place

### Block Integrity Check

`checkBlockIntegrity` (called every 15 seconds during an active block):
- Reads `/etc/pf.conf` to check if the `org.eyebeam` anchor is still present
- Reads `/etc/hosts` to check if the `BEGIN SELFCONTROL BLOCK` marker is still present
- If either is missing: **clears everything and re-adds all block rules from scratch**

This means if a user manually edits `/etc/hosts` or runs `pfctl -d`, the block is restored within 15 seconds.

### Hosts File Watcher

The daemon also uses `FSEventStream` (Core Services file system events API) to watch `/etc/hosts` for changes. When a modification is detected, it immediately triggers `checkBlockIntegrity` -- so hosts file tampering is caught even faster than the 15-second interval.

Source: `/tmp/selfcontrol/Common/SCFileWatcher.m`, `Daemon/SCDaemon.m`

### Code Signing Verification

The daemon only accepts XPC connections from processes that:
1. Are signed with the SelfControl team ID (`EG6ZYP3AQH`)
2. Have bundle identifier `org.eyebeam.SelfControl` or `org.eyebeam.selfcontrol-cli`
3. Have `CFBundleVersion >= 407` (v4.0+)
4. Pass Apple's notarization checks

This prevents third-party tools from sending commands to the daemon.

Source: `/tmp/selfcontrol/Daemon/SCDaemon.m` (line 159-162)

### Settings Storage

Block state is stored in a **root-owned plist** at `/usr/local/etc/.<hash>.plist`:
- The filename is a SHA-1 hash of `"SelfControlUserPreferences" + <serial number>`, making it non-obvious
- File permissions: owner root (UID 0), group root (GID 0), mode 0755
- The app (non-root) can only read; only the daemon (root) can write
- Settings include: `BlockEndDate`, `ActiveBlocklist`, `BlockIsRunning`, `ActiveBlockAsWhitelist`

Settings are synced between processes via `NSDistributedNotificationCenter` for real-time updates, with periodic disk sync every 30 seconds.

### What "Deleting the App" Does

Nothing useful. The blocking rules exist in:
- `/etc/hosts` -- system file, not inside the app bundle
- `/etc/pf.conf` and `/etc/pf.anchors/org.eyebeam` -- system files
- `/Library/PrivilegedHelperTools/org.eyebeam.selfcontrold` -- installed by SMJobBless, outside the app
- `/usr/local/etc/.<hash>.plist` -- settings file, outside the app

The daemon is a launchd system job. Deleting SelfControl.app does not unload or remove it.

### What "Rebooting" Does

Almost nothing. On reboot:
- The `/etc/hosts` modifications persist (it's a regular file)
- pf rules in `/etc/pf.conf` persist
- The daemon is re-launched by launchd (SMJobBless registers it permanently)
- pf gets re-enabled when the daemon runs `pfctl -E -f /etc/pf.conf`

The only thing lost on reboot is the pf runtime state, but the daemon's checkup re-activates it immediately.

### Intentional Safety Valve: Tampering Detection

If the daemon detects that `BlockIsRunning` has been set to NO (without the timer expiring), it interprets this as tampering. Interestingly, it **removes the block** in this case rather than re-adding it, because without valid settings (specifically `BlockEndDate`), it can't know when the block should end and risks creating a "permablock." The intention is that messing with settings is self-defeating -- the cheater background is shown instead.

---

## 3. How It Unblocks

### Timer-Based Expiry

The daemon's checkup timer (every 1 second) checks:

```objc
if ([SCBlockUtilities currentBlockIsExpired]) {
    [SCHelperToolUtilities removeBlock];
}
```

`currentBlockIsExpired` simply checks: `[[settings valueForKey: @"BlockEndDate"] timeIntervalSinceNow] > 0`

### Block Removal Process (`removeBlock`)

1. **Clear settings**: `BlockIsRunning = NO`, `BlockEndDate = nil`, `ActiveBlocklist = nil`
2. **Clear pf rules**:
   - Empty the anchor file (`/etc/pf.anchors/org.eyebeam`)
   - Remove anchor references from `/etc/pf.conf`
   - Release the PF token via `pfctl -X <token> -f /etc/pf.conf` (or `pfctl -d` if force-clearing)
3. **Clear hosts file**: Remove everything between `# BEGIN SELFCONTROL BLOCK` and `# END SELFCONTROL BLOCK`
4. **Restore backup**: Delete `/etc/hosts.bak`
5. **Clear caches** (if user preference set):
   - Delete browser cache directories for Chrome, Firefox, Safari
   - Flush OS DNS cache: `dscacheutil -flushcache` and `killall -HUP mDNSResponder`
6. **Play sound** (optional)
7. **Sync settings** to disk
8. **Post notification** `SCConfigurationChangedNotification` to update the UI
9. **Stop the checkup timer** -- the daemon then exits after 2 minutes of inactivity via `SMJobRemove`

### Block Extension (One-Way Only)

During an active block, users can:
- **Extend** the block end date (but not shorten it), max 24 hours at a time
- **Add** sites to the blocklist (but not remove them)

This is enforced server-side in the daemon: `updateBlockEndDate` rejects dates earlier than the current end date, and `updateBlocklist` only processes additions (logs a warning for removals but ignores them).

### Emergency Kill (SelfControl Killer)

A separate app ("SelfControl Killer") and an in-app kill button (shown after 7 seconds of failed block removal) exist as a safety valve. These:
1. Require admin authentication
2. Run `SCKillerHelper` as root
3. Unload the daemon via `SMJobRemove`
4. Call `forceClearBlock` which brute-forces removal of all pf and hosts rules
5. Reset all settings to defaults
6. Write a detailed log to `~/Documents/SelfControl-Killer.log`

The killer uses a time-limited HMAC key (`killerKey`) that expires after 10 seconds, preventing replay attacks.

---

## 4. Key Source Files

| File | Role |
|------|------|
| `Block Management/BlockManager.m` | Orchestrates adding/removing block rules across both layers |
| `Block Management/PacketFilter.m` | All pf firewall operations: writing anchors, enabling/disabling pfctl |
| `Block Management/HostFileBlocker.m` | Reads/writes /etc/hosts, adds/removes SELFCONTROL BLOCK sections |
| `Block Management/HostFileBlockerSet.m` | Manages multiple host files (VPN bypass protection) |
| `Block Management/SCBlockEntry.m` | Parses block entries (domain, IP, port, CIDR mask) |
| `Block Management/AllowlistScraper.m` | Scrapes linked domains for allowlist mode |
| `Daemon/SCDaemon.m` | XPC listener, checkup timer, file watcher, inactivity timeout |
| `Daemon/SCDaemonBlockMethods.m` | Core daemon logic: startBlock, checkupBlock, checkBlockIntegrity |
| `Daemon/SCDaemonXPC.m` | XPC method dispatch with authorization checks |
| `Daemon/SCDaemonProtocol.h` | XPC protocol definition (startBlock, updateBlocklist, updateBlockEndDate) |
| `Common/SCSettings.m` | Root-owned settings plist at /usr/local/etc/, cross-process sync |
| `Common/SCXPCClient.m` | App-side XPC client, daemon installation via SMJobBless |
| `Common/SCXPCAuthorization.m` | macOS Authorization Services integration |
| `Common/SCFileWatcher.m` | FSEventStream wrapper for monitoring /etc/hosts changes |
| `Common/Utility/SCHelperToolUtilities.m` | installBlockRulesFromSettings, removeBlock, clearCaches, clearOSDNSCache |
| `Common/Utility/SCBlockUtilities.m` | Block state detection (modern + legacy), blockRulesFoundOnSystem |
| `SCKillerHelper/main.m` | Emergency block removal tool (runs as root) |
| `cli-main.m` | CLI interface for starting blocks programmatically |

---

## 5. macOS APIs and Frameworks Used

### Core Blocking
- **`pfctl` (`/sbin/pfctl`)** -- BSD packet filter, executed via `NSTask`. Used for IP-level traffic blocking.
- **`/etc/hosts`** -- Standard Unix hosts file, modified directly via `NSMutableString` + `writeToFile:`.
- **`/etc/pf.conf`** and **`/etc/pf.anchors/`** -- pf configuration files, modified directly.

### Daemon Architecture
- **`SMJobBless` (ServiceManagement.framework)** -- Installs the privileged helper tool (`selfcontrold`) as a system-level launchd daemon. This is Apple's sanctioned mechanism for privilege escalation.
- **`NSXPCConnection` / `NSXPCListener`** -- Inter-process communication between the app and daemon. The daemon exposes a Mach service (`org.eyebeam.selfcontrold`).
- **`AuthorizationServices` (Security.framework)** -- `AuthorizationCreate`, `AuthorizationCopyRights`, `AuthorizationMakeExternalForm`. Used to prompt the user for admin credentials before starting a block.
- **`SecCodeCheckValidity` (Security.framework)** -- Validates the code signature of XPC clients to ensure only legitimate SelfControl binaries can talk to the daemon.

### DNS Resolution
- **`CFHost` (CFNetwork)** -- `CFHostCreateWithName`, `CFHostStartInfoResolution`, `CFHostGetAddressing`. Used for resolving domain names to IP addresses.

### File System Monitoring
- **`FSEventStream` (CoreServices)** -- Watches `/etc/` directory for changes to the hosts file. Triggers immediate integrity check on modification.

### Cache Clearing
- **`dscacheutil -flushcache`** -- Clears the macOS DNS cache (via `NSTask`).
- **`killall -HUP mDNSResponder`** -- Restarts the DNS resolver daemon.
- **Direct file deletion** of browser cache directories for Chrome, Firefox, Safari.

### Settings & IPC
- **`NSDistributedNotificationCenter`** -- Cross-process notification delivery for settings changes and configuration updates.
- **`NSPropertyListSerialization`** -- Binary plist serialization for the settings file.

### Other
- **`NSNetService` / `SCNetworkReachability` (SystemConfiguration)** -- Network availability checks.
- **`Sentry SDK`** -- Error reporting and crash tracking (optional, user-configurable).

---

## 6. Browser Cache Problem

SelfControl is **aware of the browser DNS cache problem** and takes several measures to mitigate it, though it does not fully solve it.

### What SelfControl Does

**On block start** (if user has "Clear Caches" enabled, which defaults to YES):
1. Deletes browser cache directories:
   - Chrome: `~/Library/Caches/Google/Chrome/Default`, `~/Library/Caches/Google/Chrome/com.google.Chrome`
   - Firefox: `~/Library/Caches/Firefox/Profiles`
   - Safari: `~/Library/Caches/com.apple.Safari`, `~/Library/Containers/com.apple.Safari/Data/Library/Caches` (note: this one often fails due to sandbox permissions)
2. Flushes OS DNS cache: `dscacheutil -flushcache` + `killall -HUP mDNSResponder` + `killall mDNSResponderHelper`

**Same cache clearing also runs on block end** (removeBlock calls clearCachesIfRequested).

**Firefox-specific handling**: After starting a block, the UI prompts the user to restart Firefox, because Firefox maintains its own DNS cache that persists even after OS DNS cache is flushed. The prompt offers to `terminate` Firefox automatically.

Source: `/tmp/selfcontrol/SCUIUtilities.m` (promptBrowserRestartIfNecessary), `SCHelperToolUtilities.m` (clearBrowserCaches, clearOSDNSCache)

### Remaining Gaps

1. **Chrome's internal DNS cache** is not explicitly flushed (only disk cache directories are deleted). Chrome caches DNS in-memory at `chrome://net-internals/#dns`. SelfControl relies on pf firewall rules (which work regardless of DNS cache) to handle this.
2. **Safari sandbox** often prevents cache deletion (`~/Library/Containers/com.apple.Safari/...` -- the code comments acknowledge this fails).
3. **HSTS/HPKP preloads** and browser connection pools are not addressed.
4. **On block end**, cleared sites may remain inaccessible briefly because:
   - The hosts file pointed domains to `0.0.0.0`, which may have been cached by browsers
   - The OS DNS cache flushed on removal helps, but browser-internal caches may still hold stale entries
5. The pf layer (`block return`) works independently of DNS caching, so even if a browser has a cached IP, the firewall still blocks it. This is why the dual-layer approach is effective -- hosts handles name resolution, pf handles the actual packets.

### Relevance to cc-focus

The key lesson: **pf-level blocking doesn't suffer from DNS cache issues** because it operates on IP addresses at the network layer, below any application DNS cache. The hosts file approach IS vulnerable to DNS caching (both OS-level and browser-level). SelfControl mitigates this by using both layers simultaneously, and by explicitly flushing caches. The Firefox restart prompt is an acknowledgment that some caches can't be programmatically flushed.

---

## Architecture Diagram

```
User clicks "Start Block"
        |
        v
  [SelfControl.app]  ──(admin auth)──>  [Authorization Services]
        |
        v
  [SCXPCClient]  ──(SMJobBless)──>  installs selfcontrold
        |
        v
  [SCXPCClient]  ──(XPC, Mach IPC)──>  [selfcontrold daemon (root)]
                                               |
                                    ┌──────────┼──────────┐
                                    v          v          v
                              [PacketFilter] [HostFileBlocker] [SCSettings]
                                    |          |               |
                                    v          v               v
                              /etc/pf.conf  /etc/hosts    /usr/local/etc/
                              /etc/pf.anchors/             .<hash>.plist
                              org.eyebeam
                                    |
                                    v
                              pfctl -E -f /etc/pf.conf -F states

                    ┌─── Checkup Timer (1s) ───────────────────┐
                    |   - Check if block expired               |
                    |   - Check for tampering                  |
                    |   - Every 15s: integrity check           |
                    |     (re-add rules if removed)            |
                    └──────────────────────────────────────────┘

                    ┌─── FSEventStream on /etc/hosts ──────────┐
                    |   - Immediate integrity check on change  |
                    └──────────────────────────────────────────┘
```

---

## Key Takeaways for cc-focus

1. **Dual-layer blocking is essential.** Hosts file alone is fragile (DNS caches, VPN overrides). pf firewall alone misses new IPs for a domain. Together they're robust.
2. **A privileged daemon is what makes it unbreakable.** Without root persistence, any user-level process can be killed. The `SMJobBless` / launchd approach is the Apple-sanctioned way to do this on macOS.
3. **Active integrity monitoring** (checking every 15s + file watcher) is more important than just setting rules once. SelfControl's block survives because the daemon actively fights back against tampering.
4. **Cache clearing is a known unsolved problem.** SelfControl does its best (OS DNS flush, browser cache deletion, Firefox restart prompt) but acknowledges it's not perfect. The pf layer is the real safety net.
5. **One-way modification** during a block (can extend but not shorten, can add sites but not remove) is a smart UX pattern for commitment devices.
6. **The settings file is the weak point.** If someone manages to corrupt or delete the root-owned plist, the daemon detects "no block running" and removes rules (to avoid permablock). SelfControl chose safety over strictness here.
