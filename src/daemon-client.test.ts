import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { rpcCall } from './daemon-client.js';

let server: net.Server | null = null;
let dir: string | null = null;

/** A fake daemon on a temporary socket; `onLine` handles each request line. */
async function fakeDaemon(onLine: (socket: net.Socket, line: string) => void): Promise<string> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amber-rpc-'));
  const socketPath = path.join(dir, 'd.sock');
  server = net.createServer(socket => {
    socket.on('data', data => onLine(socket, data.toString().trim()));
  });
  await new Promise<void>(resolve => server!.listen(socketPath, resolve));
  return socketPath;
}

afterEach(async () => {
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('rpcCall', () => {
  it('returns the result of a reply', async () => {
    const socketPath = await fakeDaemon((socket, line) => {
      const { id } = JSON.parse(line);
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }) + '\n');
    });
    await expect(rpcCall('status', undefined, 10_000, socketPath)).resolves.toEqual({ ok: true });
  });

  it('fails at once when the daemon closes the connection without replying', async () => {
    const socketPath = await fakeDaemon(socket => socket.end());
    const t0 = Date.now();
    await expect(rpcCall('reconcile', undefined, 10_000, socketPath)).rejects.toThrow(/closed the connection/);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
