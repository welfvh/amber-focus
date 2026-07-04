/**
 * Amber Focus Privileged Daemon — entry point.
 *
 * Runs as root. Listens on a Unix socket for JSON-RPC 2.0 requests from
 * the server process. STATELESS — all state is owned by the server.
 * The daemon just applies the desired blocking state to the system.
 *
 * Key principle: Default state is BLOCKED. If anything goes wrong, we block.
 *
 * Start: sudo node daemon/daemon.cjs (esbuild bundle of this file)
 * Socket: /tmp/amberfocus.sock
 */

import net from 'net';
import fs from 'fs';
import { MacOSSystem } from './system.js';
import { HostsManager } from './hosts.js';
import { PfManager } from './pf.js';
import { BrowserManager } from './browser.js';
import { OperationQueue } from './queue.js';
import { RpcDispatcher } from './rpc.js';
import { flushDnsCache } from './dns.js';
import type { ApplyResult, EnforceResult, UnblockResult, FlushDnsResult, StatusResult, DesiredState, SweepBlockedTabsResult, RestartResult } from '../shared/ipc-types.js';

const SOCKET_PATH = '/tmp/amberfocus.sock';
const startTime = Date.now();

// --- Subsystems ---

const sys = new MacOSSystem();
const queue = new OperationQueue();
const hosts = new HostsManager(sys);
const pf = new PfManager(sys, queue);
const browser = new BrowserManager(sys);
const rpc = new RpcDispatcher();

// Last known state (for status reporting only — NOT authoritative)
let lastState: DesiredState = { blockedDomains: [], shieldActive: true };

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- RPC handlers ---

rpc.register('apply', async (params): Promise<ApplyResult> => {
  const { state } = params as { state: DesiredState };
  lastState = state;

  log(`Applying state: ${state.blockedDomains.length} domains, shield=${state.shieldActive}`);

  // Update hosts file
  const domainsBlocked = await hosts.update(state.blockedDomains, state.shieldActive);

  // Update pf rules
  await pf.updateStaticRules(state.shieldActive);
  await pf.refreshDynamicRules(state.blockedDomains, state.shieldActive);

  // Flush DNS after hosts change
  await flushDnsCache(
    sys.exec.bind(sys),
    sys.execSilent.bind(sys),
  );

  log(`State applied: ${domainsBlocked} domain variants in hosts, pf updated`);
  return { hostsUpdated: true, pfUpdated: true, domainsBlocked };
});

rpc.register('enforce', async (params): Promise<EnforceResult> => {
  const { domain } = params as { domain: string };
  log(`Enforcing block: ${domain}`);

  const ips = await pf.blockDomain(domain.toLowerCase());
  await pf.killConnections(domain.toLowerCase());
  const tabsClosed = await browser.closeTabs(domain.toLowerCase());
  await flushDnsCache(sys.exec.bind(sys), sys.execSilent.bind(sys));

  log(`Block enforced: ${domain} (${ips.length} IPs, tabs closed: ${tabsClosed})`);
  return { ipsBlocked: ips, connectionsKilled: true, tabsClosed };
});

rpc.register('unblock_domain', async (params): Promise<UnblockResult> => {
  const { domain } = params as { domain: string };
  log(`Unblocking domain: ${domain}`);

  await pf.unblockDomain(domain.toLowerCase());
  // Close stale tabs so user opens fresh ones with new DNS resolution
  const tabsClosed = await browser.closeTabs(domain.toLowerCase());
  // Flush Chromium DNS caches — they ignore system DNS flushes and cache 0.0.0.0
  const browserDnsFlushed = await browser.flushBrowserDnsCache();

  log(`Domain unblocked: ${domain} (pf rules removed, tabs closed: ${tabsClosed}, browser DNS flushed: ${browserDnsFlushed})`);
  return { pfRulesRemoved: true, tabsClosed };
});

rpc.register('sweep_blocked_tabs', async (params): Promise<SweepBlockedTabsResult> => {
  const { domains } = params as { domains: string[] };
  const closedCount = await browser.sweepBlockedTabs(domains.map(d => d.toLowerCase()));
  if (closedCount > 0) {
    log(`Tab sweep closed ${closedCount} tab(s) matching blocklist`);
  }
  return { closedCount };
});

rpc.register('flush_dns', async (): Promise<FlushDnsResult> => {
  await flushDnsCache(sys.exec.bind(sys), sys.execSilent.bind(sys));
  log('DNS cache flushed');
  return { flushed: true };
});

rpc.register('status', async (): Promise<StatusResult> => {
  return {
    running: true,
    pid: process.pid,
    shieldActive: lastState.shieldActive,
    domainsBlocked: lastState.blockedDomains.length,
    uptime: Date.now() - startTime,
  };
});

rpc.register('restart', async (): Promise<RestartResult> => {
  log('Self-restart requested — exiting after 200ms; launchd will respawn');
  setTimeout(() => process.exit(0), 200);
  return { scheduled: true };
});

// --- Socket server ---

// Clean up old socket
try { fs.unlinkSync(SOCKET_PATH); } catch {}

const server = net.createServer((socket) => {
  let buffer = '';

  socket.on('data', async (data) => {
    buffer += data.toString();

    // Process complete messages (newline-delimited JSON-RPC)
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

// --- Graceful shutdown ---

function shutdown(): void {
  log('Shutting down...');
  server.close();
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
