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
  // Application-specific
  PF_FAILURE: -32000,
  HOSTS_FAILURE: -32001,
  DNS_FAILURE: -32002,
} as const;

// --- Daemon method schemas ---

/** The desired system state, computed by the server and sent to the daemon. */
export const DesiredStateSchema = z.object({
  blockedDomains: z.array(z.string()),
  shieldActive: z.boolean(),
  priorityDomains: z.array(z.string()).optional(),
});
export type DesiredState = z.infer<typeof DesiredStateSchema>;

/** apply — set the full blocking state (hosts + pf). */
export const ApplyParamsSchema = z.object({
  state: DesiredStateSchema,
});

/** enforce — aggressively block a specific domain (IPs, connections, tabs). */
export const EnforceParamsSchema = z.object({
  domain: z.string(),
});

/** unblock_domain — remove pf rules and close stale tabs for a domain. */
export const UnblockDomainParamsSchema = z.object({
  domain: z.string(),
});

/** flush_dns — flush system DNS cache. */
export const FlushDnsParamsSchema = z.object({}).optional();

/** status — get daemon health. */
export const StatusParamsSchema = z.object({}).optional();

/** sweep_blocked_tabs — close any open browser tab whose URL matches a blocked domain. */
export const SweepBlockedTabsParamsSchema = z.object({
  domains: z.array(z.string()),
});

/** restart — daemon self-exits; launchd KeepAlive respawns it with the latest bundle. No sudo needed. */
export const RestartParamsSchema = z.object({}).optional();

// --- Result types ---

export interface ApplyResult {
  hostsUpdated: boolean;
  pfUpdated: boolean;
  domainsBlocked: number;
}

export interface EnforceResult {
  ipsBlocked: string[];
  connectionsKilled: boolean;
  tabsClosed: boolean;
}

export interface UnblockResult {
  pfRulesRemoved: boolean;
  tabsClosed: boolean;
}

export interface FlushDnsResult {
  flushed: boolean;
}

export interface StatusResult {
  running: boolean;
  pid: number;
  shieldActive: boolean;
  domainsBlocked: number;
  uptime: number;
}

export interface SweepBlockedTabsResult {
  closedCount: number;
}

export interface RestartResult {
  scheduled: true;
}

// --- Method registry ---

export const DAEMON_METHODS = {
  apply: ApplyParamsSchema,
  enforce: EnforceParamsSchema,
  unblock_domain: UnblockDomainParamsSchema,
  flush_dns: FlushDnsParamsSchema,
  status: StatusParamsSchema,
  sweep_blocked_tabs: SweepBlockedTabsParamsSchema,
  restart: RestartParamsSchema,
} as const;
