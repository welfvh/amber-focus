/**
 * Daemon client — typed JSON-RPC 2.0 client over Unix socket.
 *
 * Replaces blocker.ts. The server uses this module to send commands
 * to the privileged daemon process running as root.
 */

import net from 'net';
import { execSync } from 'child_process';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  DesiredState,
  ApplyResult,
  EnforceResult,
  UnblockResult,
  FlushDnsResult,
  StatusResult,
  SweepBlockedTabsResult,
  RestartResult,
} from './shared/ipc-types.js';

const DAEMON_SOCKET = '/tmp/amberfocus.sock';
const REQUEST_TIMEOUT_MS = 15000;

let requestId = 0;

function log(msg: string): void {
  console.log(`[daemon-client] ${msg}`);
}

function logError(msg: string, err?: unknown): void {
  console.error(`[daemon-client] ${msg}`, err || '');
}

/** Send a JSON-RPC 2.0 request to the daemon and await the response. */
async function rpcCall<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const id = ++requestId;

  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id,
    method,
    ...(params ? { params } : {}),
  };

  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(DAEMON_SOCKET);
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`Daemon request timed out: ${method}`));
      }
    }, REQUEST_TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        const message = buffer.slice(0, newlineIdx);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.end();
          try {
            const response: JsonRpcResponse = JSON.parse(message);
            if (response.error) {
              reject(new Error(`Daemon error [${response.error.code}]: ${response.error.message}`));
            } else {
              resolve(response.result as T);
            }
          } catch {
            reject(new Error(`Invalid response from daemon: ${message}`));
          }
        }
      }
    });

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Daemon connection failed: ${err.message}. Is the daemon running?`));
      }
    });
  });
}

/** Check if the daemon is running and responsive. */
export async function isDaemonRunning(): Promise<boolean> {
  try {
    const status = await rpcCall<StatusResult>('status');
    return status.running === true;
  } catch {
    return false;
  }
}

/** Get daemon status details. */
export async function getDaemonStatus(): Promise<StatusResult | null> {
  try {
    return await rpcCall<StatusResult>('status');
  } catch {
    return null;
  }
}

/** Apply the full blocking state (hosts + pf). Called on every state change. */
export async function applyState(state: DesiredState): Promise<ApplyResult> {
  try {
    const result = await rpcCall<ApplyResult>('apply', { state });
    log(`State applied: ${result.domainsBlocked} domains`);
    return result;
  } catch (err) {
    logError('Failed to apply state:', err);
    throw err;
  }
}

/** Aggressively enforce a block: resolve IPs, add pf rules, kill connections, close tabs. */
export async function enforceDomain(domain: string): Promise<EnforceResult> {
  try {
    const result = await rpcCall<EnforceResult>('enforce', { domain });
    log(`Block enforced: ${domain} (${result.ipsBlocked.length} IPs blocked)`);
    return result;
  } catch (err) {
    logError(`Failed to enforce block for ${domain}:`, err);
    throw err;
  }
}

/** Remove pf rules and close stale tabs for a domain being granted access. */
export async function unblockDomain(domain: string): Promise<UnblockResult> {
  try {
    const result = await rpcCall<UnblockResult>('unblock_domain', { domain });
    log(`Domain unblocked: ${domain}`);
    return result;
  } catch (err) {
    logError(`Failed to unblock ${domain}:`, err);
    throw err;
  }
}

/**
 * Trigger a daemon self-restart. The daemon (running as root) exits, launchd
 * KeepAlive respawns it from the latest bundle on disk. Used by the redeploy
 * script so code reloads never need a manual `sudo kickstart`.
 */
export async function restartDaemon(): Promise<boolean> {
  try {
    await rpcCall<RestartResult>('restart');
    return true;
  } catch (err) {
    logError('Daemon restart request failed:', err);
    return false;
  }
}

/** Sweep all browser tabs and close any matching the given blocklist. Returns close count. */
export async function sweepBlockedTabs(domains: string[]): Promise<number> {
  try {
    const result = await rpcCall<SweepBlockedTabsResult>('sweep_blocked_tabs', { domains });
    return result.closedCount;
  } catch (err) {
    logError('Tab sweep failed:', err);
    return 0;
  }
}

/** Flush system DNS cache. */
export async function flushDns(): Promise<void> {
  try {
    await rpcCall<FlushDnsResult>('flush_dns');
    log('DNS cache flushed via daemon');
  } catch {
    // Fallback to direct call (may fail without sudo)
    try {
      execSync('dscacheutil -flushcache', { stdio: 'ignore' });
      execSync('killall -HUP mDNSResponder 2>/dev/null || true', { stdio: 'ignore' });
      log('DNS cache flushed (fallback)');
    } catch {
      // Ignore
    }
  }
}

// --- Compatibility shims for server.ts/mcp.ts transition ---

/** Enable blocking by applying the given domains as blocked. */
export async function enableBlocking(domains: string[]): Promise<boolean> {
  try {
    await applyState({ blockedDomains: domains, shieldActive: true });
    return true;
  } catch (e) {
    logError('Failed to apply blocking state:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Disable blocking entirely. */
export async function disableBlocking(): Promise<boolean> {
  try {
    await applyState({ blockedDomains: [], shieldActive: false });
    return true;
  } catch (e) {
    logError('Failed to disable blocking:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Check if shield is active (via daemon status). */
export async function hasHostsEntries(): Promise<boolean> {
  try {
    const status = await getDaemonStatus();
    return status?.shieldActive === true;
  } catch {
    return false;
  }
}

// Legacy aliases
export const enforceBlockViaDaemon = enforceDomain;
export const grantAllowanceViaDaemon = async (domain: string, _minutes: number, _reason: string): Promise<boolean> => {
  try {
    await unblockDomain(domain);
    return true;
  } catch {
    return false;
  }
};
export const revokeAllowanceViaDaemon = async (domain: string): Promise<boolean> => {
  try {
    await enforceDomain(domain);
    return true;
  } catch {
    return false;
  }
};
export const flushDnsCache = flushDns;
