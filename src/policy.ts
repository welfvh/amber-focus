/**
 * Input policy for the REST API: what counts as a domain, a grant length, a
 * free-text field. Pure functions; the routes and actions.ts call them.
 */

import { parse as parseHostname } from 'tldts';
import { isValidHostname, normalizeDomain } from './shared/domains.js';

/** Longest timed grant. Longer exceptions are a blocklist edit, made on purpose. */
export const MAX_GRANT_MINUTES = 60;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A domain from user input: trimmed, lowercased, without `www.` or a trailing
 * dot. It must be a plain hostname at or below a registrable domain — never a
 * public suffix like `com` or `co.uk`, which would cover thousands of sites.
 */
export function parseDomain(raw: unknown): Parsed<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'domain must be a string' };
  const domain = normalizeDomain(raw.trim().replace(/\.$/, ''));
  if (!isValidHostname(domain)) return { ok: false, error: `not a valid domain: ${JSON.stringify(raw)}` };
  const info = parseHostname(domain);
  if (info.isIp || info.domain === null) {
    return { ok: false, error: `${domain} is a public suffix, not a site — name the site (e.g. example.${domain})` };
  }
  return { ok: true, value: domain };
}

export function parseMinutes(raw: unknown): Parsed<number> {
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_GRANT_MINUTES) {
    return { ok: false, error: `minutes must be a whole number from 1 to ${MAX_GRANT_MINUTES}` };
  }
  return { ok: true, value: n };
}

export function parseText(raw: unknown, field: string, max: number): Parsed<string | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${field} must be a string` };
  const text = raw.trim();
  if (text.length > max) return { ok: false, error: `${field} is longer than ${max} characters` };
  return { ok: true, value: text || undefined };
}
