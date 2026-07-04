/**
 * Shared blocking actions used by both REST (server.ts) and MCP (mcp.ts).
 *
 * Extracted to avoid duplicated logic between the two entry points.
 * Each action coordinates store mutations with daemon enforcement.
 */

import { revokeAllowance, getEffectivelyBlockedDomains } from './store.js';
import { enableBlocking, enforceDomain } from './daemon-client.js';

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
  await enforceDomain(domain);
}
