/**
 * Browser DNS cache flush — the one browser operation that needs root.
 *
 * Tab handling (close, reload, read) lives in the server: it runs as the user,
 * in the user's GUI session, with the user's Automation consent. Root never
 * drives a browser.
 */

import type { SystemOperations } from './system.js';

/**
 * Chromium-based browsers cache DNS internally and ignore macOS DNS flushes.
 * Killing their network service subprocess forces a cache reset — Chrome/Arc
 * automatically respawn it with a clean DNS cache.
 */
const CHROMIUM_NETWORK_PATTERNS = [
  'Google Chrome Helper.*network\\.mojom\\.NetworkService',
  'Arc Helper.*network\\.mojom\\.NetworkService',
] as const;

export class BrowserManager {
  constructor(private sys: SystemOperations) {}

  /** Flush Chromium-based browser DNS caches by killing their network service processes. */
  async flushBrowserDnsCache(): Promise<boolean> {
    const results = await Promise.allSettled(
      CHROMIUM_NETWORK_PATTERNS.map(pattern => this.sys.execSilent('/usr/bin/pkill', ['-f', pattern])),
    );
    return results.some(r => r.status === 'fulfilled' && r.value !== null);
  }
}
