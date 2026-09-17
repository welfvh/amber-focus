/**
 * JSON-RPC 2.0 IPC types for daemon ↔ server communication.
 *
 * The daemon listens on a Unix socket and accepts JSON-RPC 2.0 requests.
 * The server (daemon-client.ts) sends these requests and awaits responses.
 */

import { z } from 'zod';

// --- JSON-RPC 2.0 envelope ---

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// --- Error codes ---

export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// --- Daemon method schemas ---

/** reconcile — run one reconcile pass now. `configPath` announces where config.json lives. */
export const ReconcileParamsSchema = z.object({
  configPath: z.string().optional(),
  reason: z.string().optional(),
});

/** flush_dns — flush system DNS cache. */
export const FlushDnsParamsSchema = z.object({}).optional();

/** status — get daemon health without running a pass. */
export const StatusParamsSchema = z.object({}).optional();

/** restart — daemon self-exits; launchd KeepAlive respawns it with the latest bundle. No sudo needed. */
export const RestartParamsSchema = z.object({}).optional();

// --- Result types ---

/** Outcome of the last reconcile pass. */
export interface ReconcileStatus {
  configPath: string | null;
  shieldActive: boolean;
  domainsBlocked: number;
  lastReconcileAt: number | null;
  lastChangeAt: number | null;
  lastReason: string | null;
  converged: boolean;
  lastError: string | null;
  /** Allowed domains that the orphaned legacy hosts section still blocks. */
  legacyBlockedAllowed: string[];
}

export interface DaemonStatus extends ReconcileStatus {
  running: true;
  pid: number;
  uptime: number;
}

export interface FlushDnsResult {
  flushed: boolean;
}

export interface RestartResult {
  scheduled: true;
}

// --- Method registry ---

export const DAEMON_METHODS = {
  reconcile: ReconcileParamsSchema,
  flush_dns: FlushDnsParamsSchema,
  status: StatusParamsSchema,
  restart: RestartParamsSchema,
} as const;
