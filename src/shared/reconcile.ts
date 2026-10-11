/**
 * Reconcile core — pure functions shared by the daemon and the server.
 *
 * The daemon converges the OS (/etc/hosts, pf) to the desired state it derives
 * from config.json. The server uses the same functions to report OS truth.
 * Nothing in here touches the filesystem or the network.
 */

import { z } from 'zod';
import { normalizeDomain, collectAllDomainsWithVariants, isValidHostname, PRIVATE_RELAY_HOSTS } from './domains.js';

export const MARKER_START = '# BEGIN AMBER FOCUS BLOCK';
export const MARKER_END = '# END AMBER FOCUS BLOCK';
/** Orphaned section written by a predecessor version. Never rewritten here. */
export const LEGACY_MARKER_START = '# BEGIN FOCUS SHIELD BLOCK';
export const LEGACY_MARKER_END = '# END FOCUS SHIELD BLOCK';

const DOMAINS_LINE_PREFIX = '# Domains:';

/** The subset of config.json the daemon needs. Unknown keys are ignored. */
export const DesiredConfigSchema = z.object({
  blockedDomains: z.array(z.string()).default([]),
  allowances: z
    .array(z.object({ domain: z.string(), expiresAt: z.number() }).loose())
    .default([]),
  shieldActive: z.boolean().default(true),
});
export type DesiredConfig = z.infer<typeof DesiredConfigSchema>;

/** What the OS should enforce right now. Domains are normalized base domains, sorted. */
export interface DesiredState {
  shieldActive: boolean;
  blockedDomains: string[];
}

interface AllowanceLike {
  domain: string;
  expiresAt: number;
}

/**
 * Blocklist minus domains (and subdomains) covered by an unexpired allowance.
 * Entries that are not plain hostnames are dropped: they never reach /etc/hosts
 * or pf. An invalid allowance is ignored, so its domain stays blocked.
 */
export function effectiveBlockedDomains(
  blocked: string[],
  allowances: AllowanceLike[],
  now: number,
): string[] {
  const allowed = activeAllowances(allowances, now);
  const out = new Set<string>();
  for (const raw of blocked) {
    const domain = normalizeDomain(raw);
    if (!isValidHostname(domain)) continue;
    const covered = allowed.some(a => domain === a || domain.endsWith('.' + a));
    if (!covered) out.add(domain);
  }
  return [...out].sort();
}

function activeAllowances(allowances: AllowanceLike[], now: number): string[] {
  return allowances
    .filter(a => a.expiresAt > now)
    .map(a => normalizeDomain(a.domain))
    .filter(isValidHostname);
}

/** Config entries that are not plain hostnames (blocklist and allowances). */
export function invalidConfigDomains(cfg: DesiredConfig): string[] {
  const raw = [...cfg.blockedDomains, ...cfg.allowances.map(a => a.domain)];
  return raw.filter(d => !isValidHostname(normalizeDomain(d)));
}

export function desiredStateFromConfig(cfg: DesiredConfig, now: number): DesiredState {
  if (!cfg.shieldActive) return { shieldActive: false, blockedDomains: [] };
  return {
    shieldActive: true,
    blockedDomains: effectiveBlockedDomains(cfg.blockedDomains, cfg.allowances, now),
  };
}

/** Active (unexpired) allowance domains, normalized. */
export function activeAllowanceDomains(cfg: DesiredConfig, now: number): string[] {
  return activeAllowances(cfg.allowances, now);
}

// --- /etc/hosts managed section ---

/**
 * Render the managed section. The `# Domains:` line records the base domains
 * so a later pass can diff against what was applied, even across daemon
 * restarts. The section is rendered even when nothing is blocked (shield off,
 * or every domain allowed): an empty Domains line is a known state, so the
 * pass that blocks those domains again also enforces their connections.
 */
export function renderHostsSection(state: DesiredState, generatedAt: string): string {
  const domains = state.shieldActive ? state.blockedDomains : [];
  const variants = collectAllDomainsWithVariants(domains);
  const lines = [
    MARKER_START,
    `# Generated: ${generatedAt}`,
    `# Blocking ${variants.length} domains`,
    DOMAINS_LINE_PREFIX + domains.map(d => ' ' + d).join(''),
  ];
  for (const host of variants) {
    lines.push(`0.0.0.0 ${host}`);
    lines.push(`:: ${host}`);
  }
  if (state.shieldActive) {
    // Not in the `# Domains:` line: they are no site, so grants and expiry never diff them.
    lines.push('# iCloud Private Relay ingress (see PRIVATE_RELAY_HOSTS)');
    for (const host of PRIVATE_RELAY_HOSTS) {
      lines.push(`0.0.0.0 ${host}`);
      lines.push(`:: ${host}`);
    }
  }
  lines.push(MARKER_END);
  return lines.join('\n') + '\n';
}

interface SectionSpan {
  start: number;
  end: number; // index just past the end marker line
}

function findSpan(content: string, startMarker: string, endMarker: string): SectionSpan | null {
  const start = content.indexOf(startMarker);
  if (start === -1) return null;
  const endMarkerIdx = content.indexOf(endMarker, start);
  if (endMarkerIdx === -1) return null;
  let end = endMarkerIdx + endMarker.length;
  if (content[end] === '\n') end += 1;
  return { start, end };
}

/** The current managed section text, or '' when absent. */
export function extractManagedSection(content: string): string {
  const span = findSpan(content, MARKER_START, MARKER_END);
  return span ? content.slice(span.start, span.end) : '';
}

/**
 * Base domains recorded in the managed section, or null when the previous
 * state is unknown: no section yet (fresh install), or a section written by an
 * older version without the Domains line. Null means "do not diff".
 */
export function parseManagedDomains(content: string): string[] | null {
  const section = extractManagedSection(content);
  if (!section) return null;
  for (const line of section.split('\n')) {
    if (line.startsWith(DOMAINS_LINE_PREFIX)) {
      return line
        .slice(DOMAINS_LINE_PREFIX.length)
        .split(/\s+/)
        .filter(Boolean)
        .sort();
    }
  }
  return null;
}

/** True when two rendered sections block the same thing (timestamp ignored). */
export function sectionEquivalent(a: string, b: string): boolean {
  const strip = (s: string) =>
    s
      .split('\n')
      .filter(line => !line.startsWith('# Generated:'))
      .join('\n');
  return strip(a) === strip(b);
}

/** Replace (or remove, when `section` is '') the managed section in a hosts file. */
export function replaceManagedSection(content: string, section: string): string {
  let out = content;
  const span = findSpan(out, MARKER_START, MARKER_END);
  if (span) out = out.slice(0, span.start) + out.slice(span.end);
  out = out.trimEnd() + '\n';
  if (section) out += '\n' + section;
  return out;
}

export interface DomainDiff {
  added: string[];
  removed: string[];
}

export function diffDomains(prev: string[], next: string[]): DomainDiff {
  const p = new Set(prev);
  const n = new Set(next);
  return {
    added: [...n].filter(d => !p.has(d)).sort(),
    removed: [...p].filter(d => !n.has(d)).sort(),
  };
}

export type HostsBlockSource = 'managed' | 'legacy' | 'other';

/**
 * One pass over a hosts file: every blocked hostname mapped to the section that
 * blocks it. Build once per file version (the file can be ~5 MB), then look up
 * in O(1). Legacy and foreign entries win over the managed section: the
 * resolver takes the first match, and both precede ours.
 */
export interface HostsIndex {
  readonly size: number;
  lookup(domain: string): HostsBlockSource | null;
}

/** Addresses that make a hosts entry a block. */
const BLOCK_ADDRESSES = new Set(['0.0.0.0', '::', '127.0.0.1', '::1']);

export function buildHostsIndex(content: string): HostsIndex {
  const managed = findSpan(content, MARKER_START, MARKER_END);
  const legacy = findSpan(content, LEGACY_MARKER_START, LEGACY_MARKER_END);
  const map = new Map<string, HostsBlockSource>();

  let offset = 0;
  let lineEnd: number;
  while (offset <= content.length) {
    lineEnd = content.indexOf('\n', offset);
    if (lineEnd === -1) lineEnd = content.length;
    // An entry is `address host [host...]`, optionally followed by a `# comment`.
    let line = content.slice(offset, lineEnd);
    const hash = line.indexOf('#');
    if (hash !== -1) line = line.slice(0, hash);
    const fields = line.trim().split(/\s+/);
    if (fields.length > 1 && BLOCK_ADDRESSES.has(fields[0])) {
      const inManaged = managed !== null && offset >= managed.start && offset < managed.end;
      const inLegacy = legacy !== null && offset >= legacy.start && offset < legacy.end;
      const source: HostsBlockSource = inManaged ? 'managed' : inLegacy ? 'legacy' : 'other';
      for (let i = 1; i < fields.length; i++) {
        const host = fields[i].toLowerCase();
        const existing = map.get(host);
        if (existing === undefined || (existing === 'managed' && source !== 'managed')) {
          map.set(host, source);
        }
      }
    }
    offset = lineEnd + 1;
  }

  return {
    size: map.size,
    lookup(domain: string): HostsBlockSource | null {
      const base = normalizeDomain(domain);
      const a = map.get(base) ?? null;
      const b = map.get('www.' + base) ?? null;
      if (a === null) return b;
      if (b === null) return a;
      return a === 'managed' ? b : a;
    },
  };
}

/** Which part of /etc/hosts blocks `domain` (or its www. variant), if any. */
export function hostsBlocks(content: string, domain: string): HostsBlockSource | null {
  return buildHostsIndex(content).lookup(domain);
}
