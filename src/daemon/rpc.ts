/**
 * JSON-RPC 2.0 request parsing, validation, and dispatch.
 *
 * Validates incoming messages against Zod schemas defined in ipc-types.ts
 * and routes to handler functions.
 */

import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  RPC_ERRORS,
  ApplyParamsSchema,
  EnforceParamsSchema,
  UnblockDomainParamsSchema,
  SweepBlockedTabsParamsSchema,
} from '../shared/ipc-types.js';

export type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

export class RpcDispatcher {
  private handlers = new Map<string, RpcHandler>();

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  async dispatch(raw: string): Promise<string> {
    let request: JsonRpcRequest;

    // Parse JSON
    try {
      request = JSON.parse(raw);
    } catch {
      return JSON.stringify(makeError(null, RPC_ERRORS.PARSE_ERROR, 'Parse error'));
    }

    // Validate envelope
    if (request.jsonrpc !== '2.0' || !request.method || request.id === undefined) {
      return JSON.stringify(makeError(
        request?.id ?? null,
        RPC_ERRORS.INVALID_REQUEST,
        'Invalid JSON-RPC 2.0 request',
      ));
    }

    // Find handler
    const handler = this.handlers.get(request.method);
    if (!handler) {
      return JSON.stringify(makeError(
        request.id,
        RPC_ERRORS.METHOD_NOT_FOUND,
        `Method not found: ${request.method}`,
      ));
    }

    // Validate params per method
    const params = request.params ?? {};
    const validationError = validateParams(request.method, params);
    if (validationError) {
      return JSON.stringify(makeError(
        request.id,
        RPC_ERRORS.INVALID_PARAMS,
        validationError,
      ));
    }

    // Execute
    try {
      const result = await handler(params);
      return JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result,
      } satisfies JsonRpcResponse);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return JSON.stringify(makeError(request.id, RPC_ERRORS.INTERNAL_ERROR, message));
    }
  }
}

function validateParams(method: string, params: Record<string, unknown>): string | null {
  try {
    switch (method) {
      case 'apply':
        ApplyParamsSchema.parse(params);
        break;
      case 'enforce':
        EnforceParamsSchema.parse(params);
        break;
      case 'unblock_domain':
        UnblockDomainParamsSchema.parse(params);
        break;
      case 'sweep_blocked_tabs':
        SweepBlockedTabsParamsSchema.parse(params);
        break;
      case 'flush_dns':
      case 'status':
      case 'restart':
        // No required params
        break;
      default:
        return `Unknown method: ${method}`;
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid params';
  }
}

function makeError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
}
