/**
 * Amber Focus Privileged Daemon — entry point.
 *
 * Runs as root. Owns convergence: a Reconciler reads config.json (desired
 * state, written by the server) and keeps /etc/hosts and pf in line with it —
 * every 10 s, whenever config.json changes, and on request over the socket.
 * Grants and expiries therefore apply even when the server is down.
 *
 * Key principle: default state is BLOCKED. If anything goes wrong, the OS
 * keeps its current blocks and the status reports the error.
 *
 * Config path: --config <path>, AMBER_FOCUS_CONFIG, the path last announced
 * by the server (persisted in /var/db/amber-focus), in that order.
 *
 * Start: sudo node daemon/daemon.cjs (esbuild bundle of this file)
 * Socket: /tmp/amberfocus.sock
 */

import net from 'net';
import fs from 'fs';
import path from 'path';
import { MacOSSystem } from './system.js';
import { PfManager } from './pf.js';
import { BrowserManager } from './browser.js';
import { OperationQueue } from './queue.js';
import { RpcDispatcher } from './rpc.js';
import { Reconciler } from './reconciler.js';
import { flushDnsCache } from './dns.js';
import type { DaemonStatus, FlushDnsResult, RestartResult } from '../shared/ipc-types.js';

const SOCKET_PATH = '/tmp/amberfocus.sock';
const STATE_DIR = '/var/db/amber-focus';
const CONFIG_PATH_FILE = path.join(STATE_DIR, 'config-path');
const TICK_INTERVAL_MS = 10_000;
const CONFIG_POLL_MS = 1_000;
const startTime = Date.now();

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- Subsystems ---

const sys = new MacOSSystem();
const queue = new OperationQueue();
const pf = new PfManager(sys, queue);
const browser = new BrowserManager(sys);
const rpc = new RpcDispatcher();
const reconciler = new Reconciler({ sys, pf, browser, log });

// --- Config path discovery ---

function argConfigPath(): string | null {
  const idx = process.argv.indexOf('--config');
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

function loadPersistedConfigPath(): string | null {
  try {
    const p = fs.readFileSync(CONFIG_PATH_FILE, 'utf8').trim();
    return p || null;
  } catch {
    return null;
  }
}

function persistConfigPath(p: string): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH_FILE, p + '\n');
  } catch (err) {
    log(`could not persist config path: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let watched: string | null = null;
function watchConfig(p: string): void {
  if (watched === p) return;
  if (watched) fs.unwatchFile(watched);
  watched = p;
  fs.watchFile(p, { interval: CONFIG_POLL_MS }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
      void reconciler.tick('config-change');
    }
  });
}

function setConfigPath(p: string, source: string): void {
  const resolved = path.resolve(p);
  if (reconciler.configPath === resolved) return;
  reconciler.configPath = resolved;
  persistConfigPath(resolved);
  watchConfig(resolved);
  log(`config path set from ${source}: ${resolved}`);
}

const initial = argConfigPath() ?? process.env.AMBER_FOCUS_CONFIG ?? loadPersistedConfigPath();
if (initial) setConfigPath(initial, argConfigPath() ? '--config' : process.env.AMBER_FOCUS_CONFIG ? 'env' : 'persisted');
else log('config path unknown until the server announces it');

// --- RPC handlers ---

function daemonStatus(): DaemonStatus {
  return { running: true, pid: process.pid, uptime: Date.now() - startTime, ...reconciler.getStatus() };
}

rpc.register('reconcile', async (params): Promise<DaemonStatus> => {
  const { configPath, reason } = params as { configPath?: string; reason?: string };
  if (configPath) setConfigPath(configPath, 'server');
  await reconciler.tick(reason ?? 'request');
  return daemonStatus();
});

rpc.register('status', async (): Promise<DaemonStatus> => daemonStatus());

rpc.register('flush_dns', async (): Promise<FlushDnsResult> => {
  await flushDnsCache(sys.exec.bind(sys), sys.execSilent.bind(sys));
  log('DNS cache flushed');
  return { flushed: true };
});

rpc.register('restart', async (): Promise<RestartResult> => {
  log('Self-restart requested — exiting after 200ms; launchd will respawn');
  setTimeout(() => process.exit(0), 200);
  return { scheduled: true };
});

// --- Socket server ---

try { fs.unlinkSync(SOCKET_PATH); } catch {}

const server = net.createServer((socket) => {
  let buffer = '';

  socket.on('data', async (data) => {
    buffer += data.toString();
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const message = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (message.trim()) {
        const response = await rpc.dispatch(message);
        socket.write(response + '\n');
      }
    }
  });

  socket.on('error', (err) => {
    log(`Socket error: ${err.message}`);
  });
});

server.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o666);
  log(`Daemon listening on ${SOCKET_PATH}`);
  log(`PID: ${process.pid}`);
});

// --- Reconcile loop ---

void reconciler.tick('boot');
setInterval(() => void reconciler.tick('timer'), TICK_INTERVAL_MS);

process.on('unhandledRejection', (err) => {
  log(`unhandled rejection: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});
process.on('uncaughtException', (err) => {
  log(`uncaught exception: ${err.stack ?? err.message}`);
});

// --- Graceful shutdown ---

function shutdown(): void {
  log('Shutting down...');
  server.close();
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
