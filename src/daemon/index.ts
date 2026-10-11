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
 * Config path: --config <path>, AMBER_FOCUS_CONFIG, or the console user's
 * ~/.config/amber-focus/config.json, in that order. No client can change it:
 * the socket is world-writable, so a path taken over RPC would let any local
 * process point root at any file.
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

/** config.json of the user logged in at the console; null at the login window. */
async function consoleUserConfigPath(): Promise<string | null> {
  const uid = fs.statSync('/dev/console').uid;
  if (uid === 0) return null;
  const out = await sys.execSilent('/usr/bin/dscacheutil', ['-q', 'user', '-a', 'uid', String(uid)]);
  const home = out?.stdout.match(/^dir: (\/.+)$/m)?.[1];
  return home ? path.join(home, '.config', 'amber-focus', 'config.json') : null;
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
  watchConfig(resolved);
  log(`config path set from ${source}: ${resolved}`);
}

/** Resolve the config path once; until it is known (login window), every tick retries. */
async function ensureConfigPath(): Promise<void> {
  if (reconciler.configPath) return;
  const fromArg = argConfigPath();
  if (fromArg) return setConfigPath(fromArg, '--config');
  if (process.env.AMBER_FOCUS_CONFIG) return setConfigPath(process.env.AMBER_FOCUS_CONFIG, 'env');
  const fromConsole = await consoleUserConfigPath();
  if (fromConsole) setConfigPath(fromConsole, 'console user');
}

async function tick(reason: string) {
  try {
    await ensureConfigPath();
  } catch (err) {
    log(`config path lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return reconciler.tick(reason);
}

// --- RPC handlers ---

function daemonStatus(): DaemonStatus {
  return { running: true, pid: process.pid, uptime: Date.now() - startTime, ...reconciler.getStatus() };
}

rpc.register('reconcile', async (params): Promise<DaemonStatus> => {
  const { reason } = params as { reason?: string };
  await tick(reason ?? 'request');
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

void tick('boot');
setInterval(() => void tick('timer'), TICK_INTERVAL_MS);

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
