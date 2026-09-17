/**
 * Amber Focus Standalone Server
 * No Electron - just a simple HTTP API on port 8053.
 *
 * Sole editor of desired state (store.ts → config.json). The privileged daemon
 * reads that file and converges the OS to it on its own loop; this server only
 * asks it to converge now (daemon-client.ts) and reports OS truth (actions.ts).
 * Also exposes /api/filter-state for the NE system extension.
 *
 * Start with: npx tsx src/server.ts
 * Or build: npx tsc && node dist/server.js
 */

import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { execFile } from 'child_process';
import {
  applyDesiredState,
  describeDomain,
  osBlockState,
  daemonHealthy,
  startVigilantForAllowance,
} from './actions.js';
import {
  grantAllowance,
  revokeAllowance,
  addBlockedDomain,
  removeBlockedDomain,
  getBlockedDomains,
  getEffectivelyBlockedDomains,
  getActiveAllowances,
  pruneExpiredAllowances,
  isShieldActive,
  setShieldActive,
  isDomainDelayed,
  getDelaySeconds,
  recordDelayAccess,
  isInActiveSession,
  updateSessionAccess,
  getDelayedDomains,
  addDelayedDomain,
  removeDelayedDomain,
  getBlockedPaths,
  addBlockedPath,
  removeBlockedPath,
  isHardLocked,
  getHardLockoutUntil,
  getActiveHardLockouts,
  addHardLockout,
  removeHardLockout,
  getProfile,
  setProfile,
  setEnabledCategories,
  getCooldowns,
  setCooldowns,
  isOnboardingComplete,
  setOnboardingComplete,
  getRetreat,
  setRetreat,
  disableRetreat,
} from './store.js';
import {
  startProxy,
  getCACertPath,
  setBlockedPaths,
  addBlockedPath as proxyAddBlockedPath,
  removeBlockedPath as proxyRemoveBlockedPath,
} from './proxy.js';
import { getDaemonStatus, flushDns } from './daemon-client.js';
import { collectAllDomainsWithVariants } from './shared/domains.js';
import { mountMCP } from './mcp.js';
import {
  stopSessionsForDomain,
  getStatus as getVigilantStatus,
  getRecentLog as getVigilantLog,
} from './vigilant.js';

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
const ALERT_COOLDOWN_MS = 10 * 60_000;

// Version counter for /api/filter-state — NE extension polls this
// and can skip refetch if version hasn't changed.
let filterStateVersion = 0;

/** Bump filter state version on every blocking state change. */
function bumpVersion(): void {
  filterStateVersion++;
}

/** Express 4 drops async rejections; route them to the error handler instead. */
type AsyncHandler = (req: Request, res: Response) => Promise<void> | void;
const route = (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

app.use(express.json());

// CORS for local requests
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

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
  });
}));

// Filter state endpoint for NE system extension
app.get('/api/filter-state', (_req: Request, res: Response) => {
  const blocked = getEffectivelyBlockedDomains();
  const allDomains = collectAllDomainsWithVariants(blocked);
  res.json({
    blockedDomains: allDomains,
    shieldActive: isShieldActive(),
    version: filterStateVersion,
  });
});

// List blocked domains
app.get('/api/blocked', (_req: Request, res: Response) => {
  res.json({ domains: getBlockedDomains() });
});

// Add domain to blocklist
app.post('/api/block', route(async (req, res) => {
  const { domain } = req.body;
  if (!domain) {
    res.status(400).json({ error: 'domain required' });
    return;
  }
  addBlockedDomain(domain);
  bumpVersion();
  const outcome = await applyDesiredState(`block:${domain}`);
  res.json({ success: true, domain, blocked: true, ...outcome });
}));

// Remove domain from blocklist
app.delete('/api/block/:domain', route(async (req, res) => {
  const { domain } = req.params;

  // Hard lockout — refuse to unblock domains with active lockouts
  if (isHardLocked(domain)) {
    const until = getHardLockoutUntil(domain);
    res.status(403).json({
      error: `REFUSED: ${domain} is HARD LOCKED until ${until}. Cannot unblock.`,
    });
    return;
  }

  removeBlockedDomain(domain);
  bumpVersion();
  const outcome = await applyDesiredState(`unblock:${domain}`);
  res.json({ success: true, domain, blocked: false, ...outcome });
}));

// Check a domain: `blocked` is what the OS enforces right now; `desiredBlocked` is the intent.
app.get('/api/check/:domain', route(async (req, res) => {
  res.json(await describeDomain(req.params.domain));
}));

// Grant temporary access (optionally with vigilant monitoring)
app.post('/api/grant', route(async (req, res) => {
  const { domain, minutes, reason, vigilant, intent } = req.body;
  if (!domain || !minutes) {
    res.status(400).json({ error: 'domain and minutes required' });
    return;
  }

  // Hard lockout — refuse domains with active lockouts
  if (isHardLocked(domain)) {
    const until = getHardLockoutUntil(domain);
    res.status(403).json({
      error: `REFUSED: ${domain} is HARD LOCKED until ${until}. No exceptions.`,
    });
    return;
  }

  const allowance = grantAllowance(
    domain,
    minutes,
    reason || 'Granted via API',
    vigilant && intent ? String(intent) : undefined,
  );
  bumpVersion();
  const outcome = await applyDesiredState(`grant:${domain}`);
  const vigilantSessionId = startVigilantForAllowance(allowance, bumpVersion);

  res.json({
    success: true,
    domain: allowance.domain,
    minutes,
    expiresAt: allowance.expiresAt,
    ...outcome,
    effective: osBlockState(allowance.domain),
    ...(vigilantSessionId ? { vigilant: true, vigilantSessionId } : {}),
  });
}));

// Revoke allowance
app.delete('/api/grant/:domain', route(async (req, res) => {
  const { domain } = req.params;
  revokeAllowance(domain);
  stopSessionsForDomain(domain);
  bumpVersion();
  const outcome = await applyDesiredState(`revoke:${domain}`);
  res.json({ success: true, domain, revoked: true, ...outcome });
}));

// List active allowances
app.get('/api/allowances', (_req: Request, res: Response) => {
  res.json({ allowances: getActiveAllowances() });
});

// Enable shield
app.post('/api/shield/enable', route(async (_req, res) => {
  setShieldActive(true);
  bumpVersion();
  const outcome = await applyDesiredState('shield-enable');
  res.json({ success: true, shieldActive: true, ...outcome });
}));

// Disable shield
app.post('/api/shield/disable', route(async (_req, res) => {
  setShieldActive(false);
  bumpVersion();
  const outcome = await applyDesiredState('shield-disable');
  res.json({ success: true, shieldActive: false, ...outcome });
}));

// Force one reconcile pass now (idempotent; safe to call any time)
app.post('/api/reconcile', route(async (_req, res) => {
  const outcome = await applyDesiredState('api');
  res.status(outcome.daemonRunning ? 200 : 503).json({ success: outcome.applied, ...outcome });
}));

// List delayed domains
app.get('/api/delayed', (_req: Request, res: Response) => {
  res.json({ domains: getDelayedDomains() });
});

// Add domain to delay list
app.post('/api/delay', (req: Request, res: Response) => {
  const { domain } = req.body;
  if (!domain) {
    res.status(400).json({ error: 'domain required' });
    return;
  }
  addDelayedDomain(domain);
  res.json({ success: true, domain, delayed: true });
});

// Remove from delay list
app.delete('/api/delay/:domain', (req: Request, res: Response) => {
  const { domain } = req.params;
  removeDelayedDomain(domain);
  res.json({ success: true, domain, delayed: false });
});

// Check delay status
app.get('/api/check-delay/:domain', (req: Request, res: Response) => {
  const { domain } = req.params;

  if (!isDomainDelayed(domain)) {
    res.json({ delayed: false, passThrough: true });
    return;
  }

  if (isInActiveSession(domain)) {
    updateSessionAccess(domain);
    res.json({ delayed: true, inSession: true, passThrough: true });
    return;
  }

  const delaySeconds = getDelaySeconds(domain);
  res.json({
    delayed: true,
    inSession: false,
    delaySeconds,
  });
});

// Record delay completion
app.post('/api/delay-complete', (req: Request, res: Response) => {
  const { domain } = req.body;
  if (!domain) {
    res.status(400).json({ error: 'domain required' });
    return;
  }
  recordDelayAccess(domain);
  res.json({ success: true, message: 'Access recorded' });
});

// === Path blocking API ===

// List blocked paths
app.get('/api/paths', (_req: Request, res: Response) => {
  res.json({ paths: getBlockedPaths() });
});

// Add blocked path
app.post('/api/path', (req: Request, res: Response) => {
  const { domain, path } = req.body;
  if (!domain || !path) {
    res.status(400).json({ error: 'domain and path required' });
    return;
  }
  addBlockedPath(domain, path);
  proxyAddBlockedPath(domain, path);
  res.json({ success: true, domain, path, blocked: true });
});

// Remove blocked path
app.delete('/api/path', (req: Request, res: Response) => {
  const { domain, path } = req.body;
  if (!domain || !path) {
    res.status(400).json({ error: 'domain and path required' });
    return;
  }
  removeBlockedPath(domain, path);
  proxyRemoveBlockedPath(domain, path);
  res.json({ success: true, domain, path, blocked: false });
});

// === Retreat mode (Mac app allowlist) ===

app.get('/api/retreat', (_req: Request, res: Response) => {
  res.json(getRetreat());
});

app.post('/api/retreat', (req: Request, res: Response) => {
  const { endDate, windows, allowlist, blocklist } = req.body || {};
  if (typeof endDate !== 'string' || !endDate) {
    res.status(400).json({ error: 'endDate required (YYYY-MM-DD)' });
    return;
  }
  if (!Array.isArray(windows) || windows.length === 0) {
    res.status(400).json({ error: 'windows must be a non-empty array of {start,end} (minutes from midnight)' });
    return;
  }
  for (const w of windows) {
    if (typeof w?.start !== 'number' || typeof w?.end !== 'number' ||
        w.start < 0 || w.start >= 1440 || w.end < 0 || w.end >= 1440) {
      res.status(400).json({ error: 'each window needs numeric start,end in 0..1439' });
      return;
    }
  }
  if (!Array.isArray(allowlist)) {
    res.status(400).json({ error: 'allowlist must be an array of bundle IDs' });
    return;
  }
  if (blocklist !== undefined && !Array.isArray(blocklist)) {
    res.status(400).json({ error: 'blocklist must be an array of bundle IDs' });
    return;
  }
  setRetreat({ enabled: true, endDate, windows, allowlist, blocklist: blocklist ?? [] });
  res.json({ success: true, retreat: getRetreat() });
});

app.delete('/api/retreat', (_req: Request, res: Response) => {
  disableRetreat();
  res.json({ success: true, retreat: getRetreat() });
});

// Get CA cert path for installation
app.get('/api/proxy/ca', (_req: Request, res: Response) => {
  res.json({ path: getCACertPath() });
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

// Get vigilant monitoring status
app.get('/api/vigilant/status', (_req: Request, res: Response) => {
  res.json(getVigilantStatus());
});

// Get recent vigilant evaluations
app.get('/api/vigilant/log', (req: Request, res: Response) => {
  const count = parseInt(req.query.count as string) || 20;
  res.json({ evaluations: getVigilantLog(count) });
});

// === Hard lockout management ===

// List active hard lockouts
app.get('/api/locks', (_req: Request, res: Response) => {
  res.json({ lockouts: getActiveHardLockouts() });
});

// Add a hard lockout
app.post('/api/lock', (req: Request, res: Response) => {
  const { domain, until } = req.body;
  if (!domain || !until) {
    res.status(400).json({ error: 'domain and until (ISO date) required' });
    return;
  }
  addHardLockout(domain, until);
  res.json({ success: true, domain, until });
});

// Remove a hard lockout
app.delete('/api/lock/:domain', (req: Request, res: Response) => {
  const { domain } = req.params;
  removeHardLockout(domain);
  res.json({ success: true, domain, removed: true });
});

// === Setup API (used by native macOS app during onboarding) ===

// Get onboarding status
app.get('/api/setup/status', (_req: Request, res: Response) => {
  res.json({
    complete: isOnboardingComplete(),
    profile: getProfile(),
    cooldowns: getCooldowns(),
  });
});

// Save user profile (triggers, pain, purpose)
app.post('/api/setup/profile', (req: Request, res: Response) => {
  const { triggers, pain, purpose } = req.body;
  if (!triggers || !Array.isArray(triggers)) {
    res.status(400).json({ error: 'triggers (array) required' });
    return;
  }
  setProfile({
    triggers,
    pain: pain || '',
    purpose: purpose || '',
    completedAt: new Date().toISOString(),
  });
  res.json({ success: true });
});

// Configure enabled categories + exceptions
app.post('/api/setup/categories', route(async (req, res) => {
  const { categories, exceptions } = req.body;
  if (!categories || !Array.isArray(categories)) {
    res.status(400).json({ error: 'categories (array) required' });
    return;
  }
  setEnabledCategories(categories, exceptions || []);
  bumpVersion();
  const outcome = await applyDesiredState('categories');
  res.json({ success: true, categories, exceptions: exceptions || [], ...outcome });
}));

// Configure cooldowns for high-risk sites
app.post('/api/setup/cooldowns', (req: Request, res: Response) => {
  const { cooldowns } = req.body;
  if (!cooldowns || !Array.isArray(cooldowns)) {
    res.status(400).json({ error: 'cooldowns (array) required' });
    return;
  }
  setCooldowns(cooldowns);
  res.json({ success: true, cooldowns });
});

// Activate shield (final onboarding step)
app.post('/api/setup/activate', route(async (_req, res) => {
  setShieldActive(true);
  setOnboardingComplete(true);
  bumpVersion();
  const outcome = await applyDesiredState('activate');
  if (outcome.applied) {
    res.json({ success: true, shieldActive: true, blockedDomains: getBlockedDomains().length, ...outcome });
  } else {
    res.status(503).json({ ...outcome, message: 'Shield set, but the daemon did not apply it — is it running?' });
  }
}));

// Errors from async routes land here instead of killing the process.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[server] route error:', message);
  if (!res.headersSent) res.status(500).json({ error: message });
});

// --- Allowance expiry: prune the store, stop monitoring, converge. ---
// The daemon re-blocks expired domains on its own loop too; this pass only
// keeps config.json tidy and makes the change immediate.
async function checkAllowanceExpiry(): Promise<void> {
  const expired = pruneExpiredAllowances();
  if (expired.length === 0) return;
  const domains = expired.map(a => a.domain);
  console.log(`Allowances expired for: ${domains.join(', ')}`);
  bumpVersion();
  for (const domain of domains) stopSessionsForDomain(domain);
  await applyDesiredState(`expiry:${domains.join(',')}`);
}

// --- Daemon watchdog: the server cannot restart the root daemon, but it can say so loudly. ---
let unhealthyChecks = 0;
let lastAlertAt = 0;
let wasHealthy = true;

function notify(title: string, body: string): void {
  const script = `display notification "${body.replace(/"/g, '\\"')}" with title "${title}"`;
  execFile('/usr/bin/osascript', ['-e', script], () => {});
}

async function watchdog(): Promise<void> {
  let status = await getDaemonStatus();
  if (status && status.configPath === null) {
    // Fresh daemon (redeploy, reinstall) that has not been told where config.json lives.
    console.log('[watchdog] daemon has no config path — announcing it');
    await applyDesiredState('announce-config');
    status = await getDaemonStatus();
  }
  const healthy = daemonHealthy(status);
  if (healthy) {
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

// Start server
async function start(): Promise<void> {
  // Converge on boot; the outcome is informational — the daemon loop keeps trying.
  const boot = await applyDesiredState('server-boot');
  if (!boot.daemonRunning) {
    console.error('Warning: daemon not running. Blocks stay as they are until it is back.');
  }
  bumpVersion();

  // Resume vigilant monitoring for grants that survived a server restart
  for (const allowance of getActiveAllowances()) {
    startVigilantForAllowance(allowance, bumpVersion);
  }

  // Load blocked paths into proxy
  const paths = getBlockedPaths();
  const pathMap = new Map<string, string[]>();
  for (const [domain, patterns] of Object.entries(paths)) {
    pathMap.set(domain, patterns);
  }
  setBlockedPaths(pathMap);

  // Start proxy server
  startProxy();
  console.log('   Configure system proxy: System Settings > Network > Wi-Fi > Details > Proxies');
  console.log('   Set HTTP & HTTPS proxy to: 127.0.0.1:8080');

  // Mount MCP endpoint for Claude Web access via Cloudflare Tunnel
  mountMCP(app, isShieldActive);

  setInterval(() => { checkAllowanceExpiry().catch(err => console.error('[expiry]', err)); }, EXPIRY_POLL_MS);
  setInterval(() => { watchdog().catch(err => console.error('[watchdog]', err)); }, WATCHDOG_POLL_MS);

  // Start HTTP server
  const server = http.createServer(app);
  server.listen(API_PORT, '127.0.0.1', () => {
    console.log(`Amber Focus API running on http://127.0.0.1:${API_PORT}`);
    console.log(`   Shield active: ${isShieldActive()} (daemon ${boot.daemonRunning ? (boot.applied ? 'converged' : 'not converged') : 'unreachable'})`);
    console.log(`   Blocked domains: ${getBlockedDomains().length} (${getEffectivelyBlockedDomains().length} effective)`);
    console.log(`   Delayed domains: ${getDelayedDomains().length}`);
  });
}

start().catch(console.error);
