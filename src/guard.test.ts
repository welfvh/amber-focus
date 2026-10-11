import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { localClientsOnly } from './guard.js';

function call(headers: Record<string, string>) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn();
  localClientsOnly({ headers } as unknown as Request, res as unknown as Response, next);
  return { status: res.status.mock.calls[0]?.[0] as number | undefined, next: next.mock.calls.length };
}

describe('localClientsOnly', () => {
  it('serves curl and scripts on the loopback address', () => {
    expect(call({ host: '127.0.0.1:8053' })).toEqual({ status: undefined, next: 1 });
    expect(call({ host: 'localhost:8053' })).toEqual({ status: undefined, next: 1 });
  });
  it('refuses any request a web page can send', () => {
    expect(call({ host: 'localhost:8053', origin: 'https://evil.example' }).status).toBe(403);
    expect(call({ host: '127.0.0.1:8053', origin: 'null' }).status).toBe(403);
  });
  it('refuses other Host headers (tunnels, DNS rebinding)', () => {
    expect(call({ host: 'focus.potential.app' }).status).toBe(403);
    expect(call({ host: 'rebind.evil.example:8053' }).status).toBe(403);
    expect(call({}).status).toBe(403);
  });
});
