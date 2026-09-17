/**
 * Shared actions used by both REST (server.ts) and MCP (mcp.ts).
 *
 * The server only edits desired state (store.ts → config.json) and then asks
 * the daemon to converge. It reports OS truth from /etc/hosts, never from its
 * own store alone.
 */

import fs from 'fs';
import {
  CONFIG_FILE,
  revokeAllowance,
  isDomainBlocked,
  isOnBlocklist,
  isHardLocked,
  getAllowanceRemaining,
  isShieldActive,
  type Allowance,
} from './store.js';
import { reconcile, getDaemonStatus } from './daemon-client.js';
import { buildHostsIndex, type HostsBlockSource, type HostsIndex } from './shared/reconcile.js';
import type { DaemonStatus } from './shared/ipc-types.js';
import { startSession as startVigilantSession, stopSessionsForDomain } from './vigilant.js';

const HOSTS_PATH = '/etc/hosts';
/** A pass older than this means the daemon loop is not running. */
export const RECONCILE_STALE_MS = 60_000;

export interface ApplyOutcome {
  daemonRunning: boolean;
  /** The OS matches the desired state after this call. */
  applied: boolean;
  error: string | null;
}

/** Ask the daemon to converge the OS to the current desired state. Never throws. */
export async function applyDesiredState(reason: string): Promise<ApplyOutcome> {
  const status = await reconcile(CONFIG_FILE, reason);
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

/** Vigilant drift: revoke the grant and converge. The daemon re-blocks and closes tabs. */
export async function handleVigilantViolation(domain: string, bumpVersion?: () => void): Promise<void> {
  console.log(`[vigilant] Violation for ${domain} — revoking grant`);
  revokeAllowance(domain);
  stopSessionsForDomain(domain);
  bumpVersion?.();
  await applyDesiredState(`vigilant-violation:${domain}`);
}

/** Start (or resume after a restart) vigilant monitoring for an allowance that carries an intent. */
export function startVigilantForAllowance(allowance: Allowance, bumpVersion?: () => void): string | null {
  if (!allowance.vigilantIntent) return null;
  try {
    const id = startVigilantSession(
      allowance.domain,
      allowance.vigilantIntent,
      allowance.expiresAt,
      () => handleVigilantViolation(allowance.domain, bumpVersion),
    );
    console.log(`[vigilant] Session ${id} for ${allowance.domain}`);
    return id;
  } catch (err) {
    console.error('[vigilant] Failed to start session:', err);
    return null;
  }
}
