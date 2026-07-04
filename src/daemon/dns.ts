/**
 * DNS resolution — uses external resolvers (8.8.8.8) to bypass local cache.
 *
 * Resolves domains to IPv4 addresses in parallel with Promise.allSettled()
 * and a 200ms per-query timeout to keep blocking fast.
 */

import dns from 'dns';

const EXTERNAL_RESOLVERS = ['8.8.8.8', '1.1.1.1'];
const RESOLVE_TIMEOUT_MS = 2000;

/** Resolve a domain to IPv4 addresses using external DNS. */
export async function resolveDomainIPs(domain: string): Promise<string[]> {
  const resolver = new dns.Resolver();
  resolver.setServers(EXTERNAL_RESOLVERS);

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), RESOLVE_TIMEOUT_MS);

    resolver.resolve4(domain, (err, addresses) => {
      clearTimeout(timer);
      if (err || !addresses) {
        resolve([]);
      } else {
        resolve(addresses);
      }
    });
  });
}

/** Resolve a domain and its www. variant in parallel. */
export async function resolveDomainWithVariants(domain: string): Promise<string[]> {
  const targets = [domain];
  if (!domain.startsWith('www.')) {
    targets.push('www.' + domain);
  }

  const results = await Promise.allSettled(targets.map(resolveDomainIPs));
  const ips = new Set<string>();
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const ip of r.value) ips.add(ip);
    }
  }
  return Array.from(ips);
}

/** Flush the system DNS cache (must run as root). */
export async function flushDnsCache(
  exec: (cmd: string, args: string[]) => Promise<unknown>,
  execSilent: (cmd: string, args: string[]) => Promise<unknown>,
): Promise<void> {
  await execSilent('dscacheutil', ['-flushcache']);
  await execSilent('killall', ['-HUP', 'mDNSResponder']);
}
