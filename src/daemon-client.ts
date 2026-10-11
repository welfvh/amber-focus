/**
 * Daemon client — typed JSON-RPC 2.0 client over Unix socket.
 *
 * The server never throws on daemon trouble: every call returns null (or
 * false) when the daemon is unreachable, and the caller reports that truthfully.
 */

import net from 'net';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  DaemonStatus,
  FlushDnsResult,
  RestartResult,
} from './shared/ipc-types.js';

const DAEMON_SOCKET = '/tmp/amberfocus.sock';
const DEFAULT_TIMEOUT_MS = 15_000;
/** A pass resolves DNS for newly blocked domains; give it room. */
const RECONCILE_TIMEOUT_MS = 45_000;

let requestId = 0;

function logError(msg: string, err?: unknown): void {
  console.error(`[daemon-client] ${msg}`, err instanceof Error ? err.message : err ?? '');
}

/** One request, one response line. Exported for tests (socketPath). */
export async function rpcCall<T>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  socketPath = DAEMON_SOCKET,
): Promise<T> {
  const id = ++requestId;
  const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };

  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`Daemon request timed out: ${method}`));
      }
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1 && !settled) {
        settled = true;
        clearTimeout(timer);
        socket.end();
        const message = buffer.slice(0, newlineIdx);
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
    });

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Daemon connection failed: ${err.message}. Is the daemon running?`));
      }
    });

    // The daemon exited or dropped the connection before it replied.
    socket.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Daemon closed the connection before replying: ${method}`));
      }
    });
  });
}

/** Daemon health and the outcome of its last pass. Null when unreachable. */
export async function getDaemonStatus(): Promise<DaemonStatus | null> {
  try {
    return await rpcCall<DaemonStatus>('status');
  } catch {
    return null;
  }
}

/** Ask the daemon to converge now. Returns its status after the pass, or null when unreachable. */
export async function reconcile(reason: string): Promise<DaemonStatus | null> {
  try {
    return await rpcCall<DaemonStatus>('reconcile', { reason: reason.slice(0, 200) }, RECONCILE_TIMEOUT_MS);
  } catch (err) {
    logError(`reconcile (${reason}) failed:`, err);
    return null;
  }
}

/** Flush the system DNS cache via the daemon. */
export async function flushDns(): Promise<boolean> {
  try {
    await rpcCall<FlushDnsResult>('flush_dns');
    return true;
  } catch (err) {
    logError('flush_dns failed:', err);
    return false;
  }
}

/**
 * Trigger a daemon self-restart. The daemon exits; launchd KeepAlive respawns
 * it from the latest bundle on disk. Used by the redeploy script.
 */
export async function restartDaemon(): Promise<boolean> {
  try {
    await rpcCall<RestartResult>('restart');
    return true;
  } catch (err) {
    logError('restart failed:', err);
    return false;
  }
}
