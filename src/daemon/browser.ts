/**
 * Browser tab management via AppleScript — Safari, Arc, Google Chrome.
 *
 * All matching is by hostname: a tab matches when its URL host equals one of
 * the domains or is a subdomain of it. Substring matching against the full URL
 * is never used — `x.com` must not match `dropbox.com`.
 *
 * Failures are ignored: the browser may not be running.
 */

import type { SystemOperations } from './system.js';

const BROWSERS = ['Safari', 'Arc', 'Google Chrome'] as const;
type Browser = (typeof BROWSERS)[number];

/**
 * Chromium-based browsers cache DNS internally and ignore macOS DNS flushes.
 * Killing their network service subprocess forces a cache reset — Chrome/Arc
 * automatically respawn it with a clean DNS cache.
 */
const CHROMIUM_NETWORK_PATTERNS = [
  'Google Chrome Helper.*network\\.mojom\\.NetworkService',
  'Arc Helper.*network\\.mojom\\.NetworkService',
] as const;

function domainList(domains: string[]): string {
  return domains.map(d => `"${d.replace(/"/g, '\\"').toLowerCase()}"`).join(', ');
}

/**
 * One osascript per browser: walk every tab, extract the hostname, collect the
 * tabs whose host matches, then run `action` on each. Returns the count.
 */
function tabScript(browser: Browser, domains: string[], action: string): string {
  return `tell application "${browser}"
    set targetDomains to {${domainList(domains)}}
    set matchCount to 0
    try
      repeat with w in every window
        set matched to {}
        repeat with t in (every tab of w)
          try
            set u to URL of t
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
              set colonIdx to offset of ":" in host
              if colonIdx > 0 then
                set host to text 1 thru (colonIdx - 1) of host
              end if
              repeat with d in targetDomains
                set ds to d as text
                if host is equal to ds then
                  set end of matched to t
                  exit repeat
                else if host ends with ("." & ds) then
                  set end of matched to t
                  exit repeat
                end if
              end repeat
            end if
          end try
        end repeat
        repeat with t in matched
          try
            ${action}
            set matchCount to matchCount + 1
          end try
        end repeat
      end repeat
    end try
    return matchCount as text
  end tell`;
}

function reloadAction(browser: Browser): string {
  // Safari tabs have no reload verb; re-setting the URL reloads.
  return browser === 'Safari' ? 'set URL of t to (URL of t)' : 'reload t';
}

export class BrowserManager {
  constructor(private sys: SystemOperations) {}

  private async runAll(scriptFor: (b: Browser) => string): Promise<number> {
    const results = await Promise.allSettled(
      BROWSERS.map(browser => this.sys.execSilent('osascript', ['-e', scriptFor(browser)])),
    );
    let total = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value !== null) {
        const n = parseInt(String(r.value.stdout).trim(), 10);
        if (!isNaN(n)) total += n;
      }
    }
    return total;
  }

  /** Close every tab whose host matches any of `domains`. Returns the count. */
  async sweepBlockedTabs(domains: string[]): Promise<number> {
    if (domains.length === 0) return 0;
    return this.runAll(b => tabScript(b, domains, 'close t'));
  }

  /** Reload every tab whose host matches any of `domains` (after an unblock). */
  async reloadTabs(domains: string[]): Promise<number> {
    if (domains.length === 0) return 0;
    return this.runAll(b => tabScript(b, domains, reloadAction(b)));
  }

  /** Flush Chromium-based browser DNS caches by killing their network service processes. */
  async flushBrowserDnsCache(): Promise<boolean> {
    const results = await Promise.allSettled(
      CHROMIUM_NETWORK_PATTERNS.map(pattern => this.sys.execSilent('/usr/bin/pkill', ['-f', pattern])),
    );
    return results.some(r => r.status === 'fulfilled' && r.value !== null);
  }
}
