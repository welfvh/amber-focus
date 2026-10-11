/**
 * Amber Focus server — the local HTTP API on 127.0.0.1:8053.
 *
 * Sole editor of desired state (store.ts → config.json). The privileged daemon
 * reads that file and converges the OS to it on its own loop; this server only
 * asks it to converge now (daemon-client.ts), reports OS truth (actions.ts),
 * and handles browser tabs as the user (browser.ts).
 *
 * Only local, non-browser clients are served: the Host header must be the
 * loopback address, and any request that carries an Origin header (every
 * cross-site fetch or form post a web page can make) is refused.
 *
 * Start with: npx tsx src/server.ts
 * Or build: npx tsc && node dist/server.js
 */

import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import {
  applyDesiredState,
  describeDomain,
  osBlockState,
  daemonHealthy,
  startVigilantForAllowance,
  grant,
  revoke,
  type ApplyOutcome,
} from './actions.js';
import { parseDomain } from './policy.js';
import { localClientsOnly } from './guard.js';
import {
  addBlockedDomain,
  removeBlockedDomain,
  getBlockedDomains,
  getEffectivelyBlockedDomains,
  getActiveAllowances,
  pruneExpiredAllowances,
  isDomainBlocked,
  isShieldActive,
  setShieldActive,
  isHardLocked,
  getHardLockoutUntil,
  getActiveHardLockouts,
  addHardLockout,
  getRetreat,
  setRetreat,
  disableRetreat,
} from './store.js';
import { getDaemonStatus, flushDns } from './daemon-client.js';
import { closeTabs } from './browser.js';
import { notify } from './notify.js';
import {
  stopSessionsForDomain,
  getStatus as getVigilantStatus,
  getRecentLog as getVigilantLog,
} from './vigilant.js';

// Timestamp every log line (server.log is the only record of what happened).
for (const level of ['log', 'error'] as const) {
  const write = console[level].bind(console);
  console[level] = (...args: unknown[]) => write(new Date().toISOString(), ...args);
}

// A daemon hiccup must never take the API down.
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection:', err instanceof Error ? err.stack ?? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception:', err.stack ?? err.message);
});

const app = express();
const API_PORT = 8053;
const EXPIRY_POLL_MS = 30_000;
const WATCHDOG_POLL_MS = 30_000;
const TAB_SWEEP_MS = 10_000;
const ALERT_COOLDOWN_MS = 10 * 60_000;

/** Express 4 drops async rejections; route them to the error handler instead. */
type AsyncHandler = (req: Request, res: Response) => Promise<void> | void;
const route = (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

app.use(localClientsOnly);

app.use(express.json());

// Status endpoint — desired state plus daemon truth
app.get('/status', route(async (_req, res) => {
  const daemon = await getDaemonStatus();
  const vigilant = getVigilantStatus();
  res.json({
    running: true,
    shieldActive: isShieldActive(),
    daemonRunning: daemon !== null,
    healthy: daemonHealthy(daemon),
    converged: daemon?.converged ?? false,
    lastReconcileAt: daemon?.lastReconcileAt ?? null,
    lastError: daemon?.lastError ?? (daemon ? null : 'daemon unreachable'),
    legacyBlockedAllowed: daemon?.legacyBlockedAllowed ?? [],
    blockedDomains: getBlockedDomains().length,
    activeAllowances: getActiveAllowances(),
    vigilant: { active: vigilant.active, degraded: vigilant.degraded },
    tabSweep: { lastError: tabSweepError },
  });
}));

// List blocked domains
app.get('/api/blocked', (_req: Request, res: Response) => {
  res.json({ domains: getBlockedDomains() });
});

// Add domain to blocklist
app.post('/api/block', route(async (req, res) => {
  const parsed = parseDomain(req.body?.domain);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const domain = parsed.value;
  addBlockedDomain(domain);
  const outcome = await applyDesiredState(`block:${domain}`);
  const closed = isDomainBlocked(domain) ? await closeTabs([domain]) : { count: 0 };
  res.json({ success: true, domain, blocked: true, tabsClosed: closed.count, ...outcome });
}));

// Remove domain from blocklist
app.delete('/api/block/:domain', route(async (req, res) => {
  const parsed = parseDomain(req.params.domain);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const domain = parsed.value;
  if (isHardLocked(domain)) {
    res.status(403).json({
      error: `REFUSED: ${domain} is HARD LOCKED until ${getHardLockoutUntil(domain)}. Cannot unblock.`,
    });
    return;
  }
  removeBlockedDomain(domain);
  const outcome = await applyDesiredState(`unblock:${domain}`);
  res.json({ success: true, domain, blocked: false, ...outcome });
}));

// Check a domain: `blocked` is what the OS enforces right now; `desiredBlocked` is the intent.
app.get('/api/check/:domain', route(async (req, res) => {
  const parsed = parseDomain(req.params.domain);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  res.json(await describeDomain(parsed.value));
}));

// Grant temporary access (optionally with vigilant monitoring: `intent`)
app.post('/api/grant', route(async (req, res) => {
  const { domain, minutes, reason, vigilant, intent } = req.body ?? {};
  if (vigilant && !intent) {
    res.status(400).json({ error: 'vigilant grants need an intent' });
    return;
  }
  const result = await grant({ domain, minutes, reason, intent: vigilant ? intent : undefined });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  const { allowance, outcome, tabsReloaded, vigilantSessionId } = result;
  res.json({
    success: true,
    domain: allowance.domain,
    minutes: allowance.grantedMinutes,
    expiresAt: allowance.expiresAt,
    ...outcome,
    effective: osBlockState(allowance.domain),
    tabsReloaded,
    ...(vigilantSessionId ? { vigilant: true, vigilantSessionId } : {}),
  });
}));

// Revoke allowance
app.delete('/api/grant/:domain', route(async (req, res) => {
  const parsed = parseDomain(req.params.domain);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const outcome = await revoke(parsed.value, 'revoke');
  res.json({ success: true, domain: parsed.value, revoked: true, ...outcome });
}));

// List active allowances
app.get('/api/allowances', (_req: Request, res: Response) => {
  res.json({ allowances: getActiveAllowances() });
});

// Enable shield
app.post('/api/shield/enable', route(async (_req, res) => {
  setShieldActive(true);
  const outcome = await applyDesiredState('shield-enable');
  res.json({ success: true, shieldActive: true, ...outcome });
}));

// Disable shield — never while a hard lock is active: it would open the locked domains too.
app.post('/api/shield/disable', route(async (_req, res) => {
  const locks = getActiveHardLockouts();
  if (locks.length > 0) {
    res.status(403).json({
      error: `REFUSED: ${locks.length} hard lock(s) active (${locks.map(l => l.domain).join(', ')}). The shield stays on.`,
    });
    return;
  }
  setShieldActive(false);
  const outcome = await applyDesiredState('shield-disable');
  res.json({ success: true, shieldActive: false, ...outcome });
}));

// Force one reconcile pass now (idempotent; safe to call any time)
app.post('/api/reconcile', route(async (_req, res) => {
  const outcome = await applyDesiredState('api');
  res.status(outcome.daemonRunning ? 200 : 503).json({ success: outcome.applied, ...outcome });
}));

// === Retreat mode (Mac app allowlist, enforced by retreat-enforcer) ===

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const isBundleIdList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(id => typeof id === 'string' && BUNDLE_ID.test(id));

app.get('/api/retreat', (_req: Request, res: Response) => {
  res.json(getRetreat());
});

app.post('/api/retreat', (req: Request, res: Response) => {
  const { endDate, windows, allowlist, blocklist } = req.body || {};
  if (typeof endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    res.status(400).json({ error: 'endDate required (YYYY-MM-DD)' });
    return;
  }
  if (!Array.isArray(windows) || windows.length === 0) {
    res.status(400).json({ error: 'windows must be a non-empty array of {start,end} (minutes from midnight)' });
    return;
  }
  for (const w of windows) {
    if (!Number.isInteger(w?.start) || !Number.isInteger(w?.end) ||
        w.start < 0 || w.start >= 1440 || w.end < 0 || w.end >= 1440) {
      res.status(400).json({ error: 'each window needs whole-number start,end in 0..1439' });
      return;
    }
  }
  if (!isBundleIdList(allowlist)) {
    res.status(400).json({ error: 'allowlist must be an array of bundle IDs' });
    return;
  }
  if (blocklist !== undefined && !isBundleIdList(blocklist)) {
    res.status(400).json({ error: 'blocklist must be an array of bundle IDs' });
    return;
  }
  const cleanWindows = windows.map((w: { start: number; end: number }) => ({ start: w.start, end: w.end }));
  setRetreat({ enabled: true, endDate, windows: cleanWindows, allowlist, blocklist: blocklist ?? [] });
  res.json({ success: true, retreat: getRetreat() });
});

app.delete('/api/retreat', (_req: Request, res: Response) => {
  disableRetreat();
  res.json({ success: true, retreat: getRetreat() });
});

// Flush DNS cache (calls daemon which runs as root)
app.post('/api/flush-dns', route(async (_req, res) => {
  const flushed = await flushDns();
  if (flushed) {
    res.json({ success: true, message: 'DNS cache flushed' });
  } else {
    res.status(503).json({ error: 'Failed to flush DNS — daemon unreachable' });
  }
}));

// === Vigilant mode API ===

app.get('/api/vigilant/status', (_req: Request, res: Response) => {
  res.json(getVigilantStatus());
});

app.get('/api/vigilant/log', (req: Request, res: Response) => {
  const count = Math.min(parseInt(req.query.count as string) || 20, 200);
  res.json({ evaluations: getVigilantLog(count) });
});

// === Hard lockouts: added here, never removed before they expire ===

app.get('/api/locks', (_req: Request, res: Response) => {
  res.json({ lockouts: getActiveHardLockouts() });
});

app.post('/api/lock', (req: Request, res: Response) => {
  const parsed = parseDomain(req.body?.domain);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const until = req.body?.until;
  const untilMs = typeof until === 'string' ? Date.parse(until) : NaN;
  if (Number.isNaN(untilMs) || untilMs <= Date.now()) {
    res.status(400).json({ error: 'until must be a future ISO date' });
    return;
  }
  const lock = addHardLockout(parsed.value, until);
  res.json({ success: true, domain: lock.domain, until: lock.until });
});

// Errors from async routes land here instead of killing the process.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[server] route error:', message);
  if (!res.headersSent) res.status(500).json({ error: message });
});

// --- Allowance expiry: prune the store, stop monitoring, converge, close tabs. ---
// The daemon re-blocks expired domains on its own loop too; this pass only
// keeps config.json tidy and makes the change immediate.
async function checkAllowanceExpiry(): Promise<void> {
  const expired = pruneExpiredAllowances();
  if (expired.length === 0) return;
  const domains = expired.map(a => a.domain);
  console.log(`Allowances expired for: ${domains.join(', ')}`);
  for (const domain of domains) stopSessionsForDomain(domain);
  const outcome: ApplyOutcome = await applyDesiredState(`expiry:${domains.join(',')}`);
  if (outcome.applied) await closeTabs(domains.filter(isDomainBlocked));
}

// --- Tab sweep: closes tabs on blocked domains, even when a browser bypassed DNS (DoH, cache). ---
let sweeping = false;
let tabSweepError: string | null = null;

async function sweepTabs(): Promise<void> {
  if (sweeping || !isShieldActive()) return;
  sweeping = true;
  try {
    const { count, errors } = await closeTabs(getEffectivelyBlockedDomains());
    if (count > 0) console.log(`Tab sweep closed ${count} blocked tab(s)`);
    const error = errors.length > 0 ? errors.join('; ') : null;
    if (error !== tabSweepError) {
      if (error) console.error(`[tab-sweep] ${error}`);
      else console.log('[tab-sweep] browsers reachable again');
      tabSweepError = error;
    }
  } finally {
    sweeping = false;
  }
}

// --- Daemon watchdog: the server cannot restart the root daemon, but it can say so loudly. ---
let unhealthyChecks = 0;
let lastAlertAt = 0;
let wasHealthy = true;

async function watchdog(): Promise<void> {
  const status = await getDaemonStatus();
  if (daemonHealthy(status)) {
    if (!wasHealthy) console.log('[watchdog] daemon healthy again');
    wasHealthy = true;
    unhealthyChecks = 0;
    return;
  }
  wasHealthy = false;
  unhealthyChecks++;
  const reason = status === null
    ? 'daemon unreachable — run: sudo launchctl enable system/com.amberfocus.daemon && sudo launchctl kickstart -k system/com.amberfocus.daemon'
    : `daemon not converged: ${status.lastError ?? 'stale reconcile'}`;
  console.error(`[watchdog] ${reason}`);
  if (unhealthyChecks >= 2 && Date.now() - lastAlertAt > ALERT_COOLDOWN_MS) {
    lastAlertAt = Date.now();
    notify('Amber Focus', reason);
  }
}

async function start(): Promise<void> {
  // Converge on boot; the outcome is informational — the daemon loop keeps trying.
  const boot = await applyDesiredState('server-boot');
  if (!boot.daemonRunning) {
    console.error('Warning: daemon not running. Blocks stay as they are until it is back.');
  }

  // Resume vigilant monitoring for grants that survived a server restart.
  // An unreadable config.json must not keep the API from starting.
  try {
    for (const allowance of getActiveAllowances()) {
      startVigilantForAllowance(allowance);
    }
  } catch (err) {
    console.error('[vigilant] cannot resume sessions:', err instanceof Error ? err.message : err);
  }

  setInterval(() => { checkAllowanceExpiry().catch(err => console.error('[expiry]', err)); }, EXPIRY_POLL_MS);
  setInterval(() => { watchdog().catch(err => console.error('[watchdog]', err)); }, WATCHDOG_POLL_MS);
  setInterval(() => { sweepTabs().catch(err => console.error('[tab-sweep]', err)); }, TAB_SWEEP_MS);

  const server = http.createServer(app);
  server.listen(API_PORT, '127.0.0.1', () => {
    console.log(`Amber Focus API running on http://127.0.0.1:${API_PORT}`);
    try {
      console.log(`   Shield active: ${isShieldActive()} (daemon ${boot.daemonRunning ? (boot.applied ? 'converged' : 'not converged') : 'unreachable'})`);
      console.log(`   Blocked domains: ${getBlockedDomains().length} (${getEffectivelyBlockedDomains().length} effective)`);
    } catch (err) {
      console.error('[server]', err instanceof Error ? err.message : err);
    }
  });
}

start().catch(console.error);
