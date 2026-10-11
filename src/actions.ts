/**
 * Actions behind the REST API (server.ts).
 *
 * The server only edits desired state (store.ts → config.json) and then asks
 * the daemon to converge. It reports OS truth from /etc/hosts, never from its
 * own store alone. Browser tabs are handled here, as the user (browser.ts).
 */

import fs from 'fs';
import {
  grantAllowance,
  revokeAllowance,
  isDomainBlocked,
  isOnBlocklist,
  isHardLocked,
  lockoutCoveredBy,
  blockingParent,
  getAllowanceRemaining,
  isShieldActive,
  removeBlockedDomain,
  type Allowance,
} from './store.js';
import { reconcile, getDaemonStatus } from './daemon-client.js';
import { closeTabs, reloadTabs } from './browser.js';
import { buildHostsIndex, type HostsBlockSource, type HostsIndex } from './shared/reconcile.js';
import { parseDomain, parseMinutes, parseText } from './policy.js';
import type { DaemonStatus } from './shared/ipc-types.js';
import { startSession as startVigilantSession, stopSessionsForDomain } from './vigilant.js';

const HOSTS_PATH = '/etc/hosts';
/** A pass older than this means the daemon loop is not running. */
export const RECONCILE_STALE_MS = 60_000;
const MAX_REASON_LENGTH = 500;
const MAX_INTENT_LENGTH = 300;

export interface ApplyOutcome {
  daemonRunning: boolean;
  /** The OS matches the desired state after this call. */
  applied: boolean;
  error: string | null;
}

/** Ask the daemon to converge the OS to the current desired state. Never throws. */
export async function applyDesiredState(reason: string): Promise<ApplyOutcome> {
  const status = await reconcile(reason);
  if (!status) {
    console.error(`[apply] daemon unreachable (${reason}) — desired state saved, OS unchanged`);
    return { daemonRunning: false, applied: false, error: 'daemon unreachable' };
  }
  if (!status.converged) console.error(`[apply] not converged (${reason}): ${status.lastError}`);
  return { daemonRunning: true, applied: status.converged, error: status.lastError };
}

export function daemonHealthy(status: DaemonStatus | null, now = Date.now()): boolean {
  return (
    status !== null &&
    status.converged &&
    status.lastReconcileAt !== null &&
    now - status.lastReconcileAt < RECONCILE_STALE_MS
  );
}

export interface OsBlockState {
  blocked: boolean;
  source: HostsBlockSource | null;
}

let hostsCache: { mtimeMs: number; size: number; index: HostsIndex } | null = null;

/** Index of /etc/hosts, rebuilt only when the file's mtime or size changed (it can be ~5 MB). */
function hostsIndex(): HostsIndex {
  const stat = fs.statSync(HOSTS_PATH);
  if (!hostsCache || hostsCache.mtimeMs !== stat.mtimeMs || hostsCache.size !== stat.size) {
    hostsCache = { mtimeMs: stat.mtimeMs, size: stat.size, index: buildHostsIndex(fs.readFileSync(HOSTS_PATH, 'utf8')) };
  }
  return hostsCache.index;
}

/** What the OS enforces for this domain right now, read from /etc/hosts. */
export function osBlockState(domain: string): OsBlockState {
  const source = hostsIndex().lookup(domain);
  return { blocked: source !== null, source };
}

export interface DomainReport extends OsBlockState {
  domain: string;
  desiredBlocked: boolean;
  onBlocklist: boolean;
  allowanceMinutes: number;
  shieldActive: boolean;
  locked: boolean;
  daemonRunning: boolean;
  converged: boolean;
}

/** Desired state and OS truth for one domain, side by side. */
export async function describeDomain(domain: string): Promise<DomainReport> {
  const status = await getDaemonStatus();
  return {
    domain,
    ...osBlockState(domain),
    desiredBlocked: isDomainBlocked(domain),
    onBlocklist: isOnBlocklist(domain),
    allowanceMinutes: getAllowanceRemaining(domain),
    shieldActive: isShieldActive(),
    locked: isHardLocked(domain),
    daemonRunning: status !== null,
    converged: status?.converged ?? false,
  };
}

// --- Blocklist ---

export type UnblockResult =
  | { ok: true; outcome: ApplyOutcome }
  | { ok: false; status: 403; error: string };

/**
 * Remove a domain from the blocklist, then converge. Refused while a hard lock
 * touches it: on the domain, on a parent, or on a subdomain its block covers.
 */
export async function unblock(domain: string): Promise<UnblockResult> {
  const lock = lockoutCoveredBy(domain);
  if (lock) {
    return {
      ok: false,
      status: 403,
      error: `REFUSED: ${domain} touches ${lock.domain}, HARD LOCKED until ${lock.until}. Cannot unblock.`,
    };
  }
  removeBlockedDomain(domain);
  return { ok: true, outcome: await applyDesiredState(`unblock:${domain}`) };
}

// --- Grants ---

export interface GrantRequest {
  domain: unknown;
  minutes: unknown;
  reason?: unknown;
  /** Present when the grant must run under vigilant monitoring. */
  intent?: unknown;
}

export type GrantResult =
  | { ok: true; allowance: Allowance; outcome: ApplyOutcome; tabsReloaded: number; vigilantSessionId: string | null }
  | { ok: false; status: 400 | 403; error: string };

/** The one grant path: validate, check locks, save, converge, reload tabs, start monitoring. */
export async function grant(req: GrantRequest): Promise<GrantResult> {
  const domain = parseDomain(req.domain);
  if (!domain.ok) return { ok: false, status: 400, error: domain.error };
  const minutes = parseMinutes(req.minutes);
  if (!minutes.ok) return { ok: false, status: 400, error: minutes.error };
  const reason = parseText(req.reason, 'reason', MAX_REASON_LENGTH);
  if (!reason.ok) return { ok: false, status: 400, error: reason.error };
  const intent = parseText(req.intent, 'intent', MAX_INTENT_LENGTH);
  if (!intent.ok) return { ok: false, status: 400, error: intent.error };

  const parent = blockingParent(domain.value);
  if (parent) {
    return { ok: false, status: 400, error: `${domain.value} is blocked as part of ${parent}; grant ${parent} instead` };
  }

  const lock = lockoutCoveredBy(domain.value);
  if (lock) {
    return {
      ok: false,
      status: 403,
      error: `REFUSED: ${domain.value} touches ${lock.domain}, HARD LOCKED until ${lock.until}. No exceptions.`,
    };
  }

  const allowance = grantAllowance(domain.value, minutes.value, reason.value ?? 'Granted via API', intent.value);
  const outcome = await applyDesiredState(`grant:${domain.value}`);
  const reloaded = outcome.applied ? await reloadTabs([domain.value]) : { count: 0, errors: [] };
  const vigilantSessionId = startVigilantForAllowance(allowance);
  return { ok: true, allowance, outcome, tabsReloaded: reloaded.count, vigilantSessionId };
}

/** End a grant now: drop the allowance, converge, close the domain's tabs. */
export async function revoke(domain: string, reason: string): Promise<ApplyOutcome> {
  revokeAllowance(domain);
  stopSessionsForDomain(domain);
  const outcome = await applyDesiredState(`${reason}:${domain}`);
  if (isDomainBlocked(domain)) await closeTabs([domain]);
  return outcome;
}

/** Vigilant drift: revoke the grant and converge. */
export async function handleVigilantViolation(domain: string): Promise<void> {
  console.log(`[vigilant] Violation for ${domain} — revoking grant`);
  await revoke(domain, 'vigilant-violation');
}

/** Start (or resume after a restart) vigilant monitoring for an allowance that carries an intent. */
export function startVigilantForAllowance(allowance: Allowance): string | null {
  if (!allowance.vigilantIntent) return null;
  try {
    const id = startVigilantSession(
      allowance.domain,
      allowance.vigilantIntent,
      allowance.expiresAt,
      () => handleVigilantViolation(allowance.domain),
    );
    console.log(`[vigilant] Session ${id} for ${allowance.domain}`);
    return id;
  } catch (err) {
    console.error('[vigilant] Failed to start session:', err);
    return null;
  }
}
