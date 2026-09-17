/**
 * JSON-RPC 2.0 request parsing, validation, and dispatch.
 *
 * Validates incoming messages against Zod schemas defined in ipc-types.ts
 * and routes to handler functions.
 */

import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  RPC_ERRORS,
  DAEMON_METHODS,
} from '../shared/ipc-types.js';

export type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

export class RpcDispatcher {
  private handlers = new Map<string, RpcHandler>();

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  async dispatch(raw: string): Promise<string> {
    let request: JsonRpcRequest;

    try {
      request = JSON.parse(raw);
    } catch {
      return JSON.stringify(makeError(null, RPC_ERRORS.PARSE_ERROR, 'Parse error'));
    }

    if (request.jsonrpc !== '2.0' || !request.method || request.id === undefined) {
      return JSON.stringify(makeError(
        request?.id ?? null,
        RPC_ERRORS.INVALID_REQUEST,
        'Invalid JSON-RPC 2.0 request',
      ));
    }

    const handler = this.handlers.get(request.method);
    if (!handler) {
      return JSON.stringify(makeError(
        request.id,
        RPC_ERRORS.METHOD_NOT_FOUND,
        `Method not found: ${request.method}`,
      ));
    }

    const params = request.params ?? {};
    const validationError = validateParams(request.method, params);
    if (validationError) {
      return JSON.stringify(makeError(request.id, RPC_ERRORS.INVALID_PARAMS, validationError));
    }

    try {
      const result = await handler(params);
      return JSON.stringify({ jsonrpc: '2.0', id: request.id, result } satisfies JsonRpcResponse);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return JSON.stringify(makeError(request.id, RPC_ERRORS.INTERNAL_ERROR, message));
    }
  }
}

function validateParams(method: string, params: Record<string, unknown>): string | null {
  const schema = (DAEMON_METHODS as Record<string, { parse(v: unknown): unknown } | undefined>)[method];
  if (!schema) return `Unknown method: ${method}`;
  try {
    schema.parse(params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid params';
  }
}

function makeError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
