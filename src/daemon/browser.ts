/**
 * Browser tab management — close tabs matching a domain via JXA (AppleScript).
 *
 * Runs in parallel across Safari, Arc, and Chrome. Failures are silently
 * ignored since the browser might not be running.
 */

import type { SystemOperations } from './system.js';

const BROWSERS = ['Safari', 'Arc', 'Google Chrome'] as const;

function tabCloseScript(browser: string, domain: string): string {
  // Escape domain for AppleScript string interpolation
  const safeDomain = domain.replace(/"/g, '\\"');
  return `tell application "${browser}"
  set windowList to every window
  repeat with w in windowList
    set tabList to every tab of w
    repeat with t in tabList
      if URL of t contains "${safeDomain}" then
        close t
      end if
    end repeat
  end repeat
end tell`;
}

/**
 * Chromium-based browsers cache DNS internally and ignore macOS DNS flushes.
 * Killing their network service subprocess forces a cache reset — Chrome/Arc
 * automatically respawn it with a clean DNS cache.
 */
const CHROMIUM_NETWORK_PATTERNS = [
  'Google Chrome Helper.*network\\.mojom\\.NetworkService',
  'Arc Helper.*network\\.mojom\\.NetworkService',
] as const;

/**
 * Build an AppleScript that scans every tab in every window of `browser` and
 * closes any tab whose **hostname** equals or is a subdomain of any of `domains`.
 * Returns the number of tabs closed as a string. The whole sweep happens in
 * one osascript call.
 *
 * Hostname-only matching is critical: substring matching against the full URL
 * causes false positives like `x.com` (Twitter, in the blocklist) matching
 * `dropbox.com` (substring within "drop[box.com]").
 */
function sweepTabsScript(browser: string, domains: string[]): string {
  const list = domains.map(d => `"${d.replace(/"/g, '\\"').toLowerCase()}"`).join(', ');
  return `tell application "${browser}"
    set blockedDomains to {${list}}
    set closedCount to 0
    try
      repeat with w in every window
        set tabsToClose to {}
        repeat with t in (every tab of w)
          try
            set u to URL of t
            -- Extract hostname: between "://" and next "/" (or end)
            set host to ""
            set schemeIdx to offset of "://" in u
            if schemeIdx > 0 then
              set rest to text (schemeIdx + 3) thru -1 of u
              set slashIdx to offset of "/" in rest
              if slashIdx > 0 then
                set host to text 1 thru (slashIdx - 1) of rest
              else
                set host to rest
              end if
              -- Strip port if present
              set colonIdx to offset of ":" in host
              if colonIdx > 0 then
                set host to text 1 thru (colonIdx - 1) of host
              end if
              -- AppleScript string comparison is case-insensitive by default,
              -- so we match host vs lowercased domain list directly.
              -- Match: host equals d OR host ends with "." & d
              repeat with d in blockedDomains
                set ds to d as text
                if host is equal to ds then
                  set end of tabsToClose to t
                  exit repeat
                else if host ends with ("." & ds) then
                  set end of tabsToClose to t
                  exit repeat
                end if
              end repeat
            end if
          end try
        end repeat
        repeat with t in tabsToClose
          try
            close t
            set closedCount to closedCount + 1
          end try
        end repeat
      end repeat
    end try
    return closedCount as text
  end tell`;
}

export class BrowserManager {
  constructor(private sys: SystemOperations) {}

  /** Close tabs containing the domain across all supported browsers. */
  async closeTabs(domain: string): Promise<boolean> {
    const results = await Promise.allSettled(
      BROWSERS.map(browser =>
        this.sys.execSilent('osascript', ['-e', tabCloseScript(browser, domain)])
      )
    );

    return results.some(r => r.status === 'fulfilled' && r.value !== null);
  }

  /**
   * Sweep all browsers and close any tab matching any of `domains`.
   * One osascript call per browser. Designed for periodic invocation.
   */
  async sweepBlockedTabs(domains: string[]): Promise<number> {
    if (domains.length === 0) return 0;
    const results = await Promise.allSettled(
      BROWSERS.map(browser =>
        this.sys.execSilent('osascript', ['-e', sweepTabsScript(browser, domains)])
      )
    );
    let total = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value !== null) {
        const n = parseInt(String(r.value).trim(), 10);
        if (!isNaN(n)) total += n;
      }
    }
    return total;
  }

  /** Flush Chromium-based browser DNS caches by killing their network service processes. */
  async flushBrowserDnsCache(): Promise<boolean> {
    const results = await Promise.allSettled(
      CHROMIUM_NETWORK_PATTERNS.map(pattern =>
        this.sys.execSilent('/usr/bin/pkill', ['-f', pattern])
      )
    );

    return results.some(r => r.status === 'fulfilled' && r.value !== null);
  }
}
