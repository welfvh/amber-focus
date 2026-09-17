/**
 * Reconcile core — pure functions shared by the daemon and the server.
 *
 * The daemon converges the OS (/etc/hosts, pf) to the desired state it derives
 * from config.json. The server uses the same functions to report OS truth.
 * Nothing in here touches the filesystem or the network.
 */

import { z } from 'zod';
import { normalizeDomain, collectAllDomainsWithVariants } from './domains.js';

export const MARKER_START = '# BEGIN AMBER FOCUS BLOCK';
export const MARKER_END = '# END AMBER FOCUS BLOCK';
/** Orphaned section written by a predecessor version. Never rewritten here. */
export const LEGACY_MARKER_START = '# BEGIN FOCUS SHIELD BLOCK';
export const LEGACY_MARKER_END = '# END FOCUS SHIELD BLOCK';

const DOMAINS_LINE_PREFIX = '# Domains: ';

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

/** Blocklist minus domains (and subdomains) covered by an unexpired allowance. */
export function effectiveBlockedDomains(
  blocked: string[],
  allowances: AllowanceLike[],
  now: number,
): string[] {
  const allowed = allowances
    .filter(a => a.expiresAt > now)
    .map(a => normalizeDomain(a.domain));
  const out = new Set<string>();
  for (const raw of blocked) {
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    const covered = allowed.some(a => domain === a || domain.endsWith('.' + a));
    if (!covered) out.add(domain);
  }
  return [...out].sort();
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
  return cfg.allowances
    .filter(a => a.expiresAt > now)
    .map(a => normalizeDomain(a.domain));
}

// --- /etc/hosts managed section ---

/**
 * Render the managed section. Empty string when there is nothing to block.
 * The `# Domains:` line records the base domains so a later pass can diff
 * against what was applied, even across daemon restarts.
 */
export function renderHostsSection(state: DesiredState, generatedAt: string): string {
  if (!state.shieldActive || state.blockedDomains.length === 0) return '';
  const variants = collectAllDomainsWithVariants(state.blockedDomains);
  const lines = [
    MARKER_START,
    `# Generated: ${generatedAt}`,
    `# Blocking ${variants.length} domains`,
    DOMAINS_LINE_PREFIX + state.blockedDomains.join(' '),
  ];
  for (const host of variants) {
    lines.push(`0.0.0.0 ${host}`);
    lines.push(`:: ${host}`);
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
        .split(' ')
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
 * Which part of /etc/hosts blocks `domain` (or its www. variant), if any.
 * "other" means an entry outside both known sections.
 */
export function hostsBlocks(content: string, domain: string): HostsBlockSource | null {
  const base = normalizeDomain(domain);
  const hosts = new Set([base, 'www.' + base]);
  const managed = findSpan(content, MARKER_START, MARKER_END);
  const legacy = findSpan(content, LEGACY_MARKER_START, LEGACY_MARKER_END);
  const re = /^(?:0\.0\.0\.0|::|127\.0\.0\.1|::1)[ \t]+(\S+)[ \t]*$/;

  let offset = 0;
  let found: HostsBlockSource | null = null;
  for (const line of content.split('\n')) {
    const m = line.match(re);
    if (m && hosts.has(m[1].toLowerCase())) {
      const inManaged = managed && offset >= managed.start && offset < managed.end;
      const inLegacy = legacy && offset >= legacy.start && offset < legacy.end;
      const source: HostsBlockSource = inManaged ? 'managed' : inLegacy ? 'legacy' : 'other';
      // Legacy or foreign entries override the managed section (first match wins
      // in the resolver, and both other sections precede ours).
      if (source !== 'managed') return source;
      found = source;
    }
    offset += line.length + 1;
  }
  return found;
}
