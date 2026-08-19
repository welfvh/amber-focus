/**
 * Shared blocking actions used by both REST (server.ts) and MCP (mcp.ts).
 *
 * Extracted to avoid duplicated logic between the two entry points.
 * Each action coordinates store mutations with daemon enforcement.
 */

import {
  revokeAllowance,
  getEffectivelyBlockedDomains,
  getBlockedDomains,
  isDomainBlocked,
} from './store.js';
import { enableBlocking, enforceDomain } from './daemon-client.js';
import { matchesDomain, normalizeDomain } from './shared/domains.js';

/**
 * Aggressively enforce every blocked domain that an ended allowance covered.
 *
 * Two rules:
 * 1. Never enforce a domain that is not blocked. Enforcing a never-blocked
 *    domain writes pf rules that no layer reports and nothing cleans up
 *    (github.com incident, 2026-08-17).
 * 2. An allowance for a parent domain (google.com) also covered blocked child
 *    domains (news.google.com). Enforce those too, or live connections stay open.
 */
export async function enforceEndedAllowance(domain: string): Promise<void> {
  const targets = new Set<string>();
  if (isDomainBlocked(domain)) {
    targets.add(normalizeDomain(domain));
  }
  for (const blocked of getBlockedDomains()) {
    if (matchesDomain(blocked, domain) && isDomainBlocked(blocked)) {
      targets.add(normalizeDomain(blocked));
    }
  }
  for (const target of targets) {
    // Re-check per iteration: a grant issued mid-loop must win over stale targets.
    if (!isDomainBlocked(target)) continue;
    await enforceDomain(target);
  }
}

/**
 * Handle a vigilant mode violation: revoke the grant, re-apply blocking,
 * and aggressively enforce the domain (kill connections, close tabs).
 *
 * Called from both server.ts and mcp.ts vigilant session callbacks.
 */
export async function handleVigilantViolation(
  domain: string,
  shieldActive: boolean | (() => boolean),
  bumpVersion?: () => void,
): Promise<void> {
  console.log(`[vigilant] Violation for ${domain} — revoking grant`);
  revokeAllowance(domain);
  bumpVersion?.();

  const isActive = typeof shieldActive === 'function' ? shieldActive() : shieldActive;
  if (isActive) {
    const applied = await enableBlocking(getEffectivelyBlockedDomains());
    if (!applied) {
      console.error(`[vigilant] Failed to re-apply blocking for ${domain}`);
    }
  }
  await enforceEndedAllowance(domain);
}
