/**
 * Domain normalization and variant expansion — single source of truth.
 *
 * Extracts logic previously duplicated between daemon.cjs (lines 69-90)
 * and store.ts (normalizeDomain). All domain-related utilities live here.
 */

/** Strip www. prefix and lowercase. */
export function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '');
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * True for a plain DNS hostname with at least two labels: lowercase letters,
 * digits and inner hyphens, no IP literal. Only such names may reach
 * /etc/hosts, pf, or a browser script — everything else is refused.
 */
export function isValidHostname(host: string): boolean {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every(l => LABEL.test(l))) return false;
  return !/^[0-9]+$/.test(labels[labels.length - 1]);
}

/** Check if query matches pattern or is a subdomain of pattern. */
export function matchesDomain(query: string, pattern: string): boolean {
  const nq = normalizeDomain(query);
  const np = normalizeDomain(pattern);
  return nq === np || nq.endsWith('.' + np);
}

/**
 * Expand a list of domains to include known variants (www., mobile, etc.).
 * Used for /etc/hosts entries where we need to catch every subdomain variant.
 */
export function collectAllDomainsWithVariants(domains: string[]): string[] {
  const all = new Set<string>();
  for (const domain of domains) {
    all.add(domain);
    if (!domain.startsWith('www.')) {
      all.add('www.' + domain);
    }
    // YouTube variants
    if (domain.includes('youtube.com')) {
      for (const d of ['m.youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com']) {
        all.add(d);
      }
    }
    // Twitter/X variants (exact match only — don't expand reddit.com→mobile.twitter.com)
    if (domain === 'twitter.com' || domain === 'x.com') {
      for (const d of ['mobile.twitter.com', 'mobile.x.com']) {
        all.add(d);
      }
    }
    // Reddit variants
    if (domain.includes('reddit.com')) {
      for (const d of ['old.reddit.com', 'new.reddit.com', 'i.reddit.com']) {
        all.add(d);
      }
    }
  }
  return Array.from(all);
}

/**
 * Priority domains — only these get resolved to IPs for pf-level blocking.
 * The bulk adult blocklist stays /etc/hosts only, which is fine because users
 * don't grant/unblock those. pf resolution is only needed for domains where
 * the grant→unblock→reblock cycle matters.
 */
/**
 * iCloud Private Relay ingress hosts. Blocked in /etc/hosts while the shield is
 * on, whatever the blocklist says.
 *
 * Private Relay resolves sites through its own encrypted DNS and sends traffic
 * to Apple's relay, so neither the hosts entries nor the pf rules of a blocked
 * site apply to Safari while it is on. When these hosts do not resolve, Private
 * Relay does not start and Safari connects directly, through both layers. This
 * is Apple's documented way to turn Private Relay off for a network
 * (https://support.apple.com/en-us/102022), applied to this Mac.
 *
 * Hosts only, never pf: the relay IPs are in Apple's 17.0.0.0/8, which other
 * Apple services share.
 */
export const PRIVATE_RELAY_HOSTS = [
  'mask.icloud.com',
  'mask-h2.icloud.com',
  'mask-api.icloud.com',
  'mask.apple-dns.net', // CNAME target of mask-h2.icloud.com
] as const;

export const PRIORITY_DOMAINS = [
  // Social
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'tiktok.com',
  'reddit.com', 'linkedin.com', 'discord.com', 'threads.net', 'bsky.app',
  'pinterest.com', 'news.ycombinator.com', 'polymarket.com',
  // Video
  'youtube.com', 'youtu.be', 'netflix.com', 'twitch.tv',
  // News
  'substack.com',
  // Shopping
  'amazon.com', 'ebay.com', 'kleinanzeigen.de',
  // Gambling
  'bet365.com', 'draftkings.com', 'fanduel.com', 'bovada.lv',
  'pokerstars.com', 'betway.com', 'williamhill.com',
] as const;
