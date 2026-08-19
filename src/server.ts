/**
 * Amber Focus Standalone Server
 * No Electron - just a simple HTTP API on port 8053.
 *
 * Sole owner of application state (store.ts). Communicates with
 * the privileged daemon via JSON-RPC over Unix socket (daemon-client.ts).
 * Also exposes /api/filter-state for the NE system extension.
 *
 * Start with: npx tsx src/server.ts
 * Or build: npx tsc && node dist/server.js
 */

import express, { Request, Response } from 'express';
import http from 'http';
import { handleVigilantViolation } from './actions.js';
import {
  isDomainBlocked,
  grantAllowance,
  revokeAllowance,
  addBlockedDomain,
  removeBlockedDomain,
  getBlockedDomains,
  getEffectivelyBlockedDomains,
  getActiveAllowances,
  getAllowanceRemaining,
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
import {
  isDaemonRunning,
  enableBlocking,
  disableBlocking,
  flushDns as flushDnsCache,
  enforceDomain,
  unblockDomain,
  sweepBlockedTabs,
} from './daemon-client.js';
import { collectAllDomainsWithVariants } from './shared/domains.js';
import { mountMCP } from './mcp.js';
import {
  startSession as startVigilantSession,
  stopSessionsForDomain,
  getStatus as getVigilantStatus,
  getRecentLog as getVigilantLog,
} from './vigilant.js';

const app = express();
const API_PORT = 8053;

let shieldActive = false;

// Version counter for /api/filter-state — NE extension polls this
// and can skip refetch if version hasn't changed.
let filterStateVersion = 0;

/** Bump filter state version on every blocking state change. */
function bumpVersion(): void {
  filterStateVersion++;
}

app.use(express.json());

// CORS for local requests
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Status endpoint
app.get('/status', async (_req: Request, res: Response) => {
  const daemonRunning = await isDaemonRunning();
  res.json({
    running: true,
    shieldActive,
    daemonRunning,
    blockedDomains: getBlockedDomains().length,
    activeAllowances: getActiveAllowances(),
  });
});

// Filter state endpoint for NE system extension
app.get('/api/filter-state', (_req: Request, res: Response) => {
  const blocked = getEffectivelyBlockedDomains();
  const allDomains = collectAllDomainsWithVariants(blocked);
  res.json({
    blockedDomains: allDomains,
    shieldActive,
    version: filterStateVersion,
  });
});

// List blocked domains
app.get('/api/blocked', (_req: Request, res: Response) => {
  res.json({ domains: getBlockedDomains() });
});

// Add domain to blocklist
app.post('/api/block', async (req: Request, res: Response) => {
  const { domain } = req.body;
  if (!domain) {
    res.status(400).json({ error: 'domain required' });
    return;
  }
  addBlockedDomain(domain);
  bumpVersion();

  if (shieldActive) {
    const applied = await enableBlocking(getEffectivelyBlockedDomains());
    if (!applied) console.error(`[block] Failed to apply blocking for ${domain}`);
    await flushDnsCache();
    await enforceDomain(domain);
  }

  res.json({ success: true, domain, blocked: true });
});

// Remove domain from blocklist
app.delete('/api/block/:domain', async (req: Request, res: Response) => {
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

  if (shieldActive) {
    await enableBlocking(getEffectivelyBlockedDomains());
  }

  res.json({ success: true, domain, blocked: false });
});

// Check if domain is blocked
app.get('/api/check/:domain', (req: Request, res: Response) => {
  const { domain } = req.params;
  const blocked = isDomainBlocked(domain);
  const allowanceMinutes = getAllowanceRemaining(domain);
  res.json({ domain, blocked, allowanceMinutes, shieldActive });
});

// Grant temporary access (optionally with vigilant monitoring)
app.post('/api/grant', async (req: Request, res: Response) => {
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

  const allowance = grantAllowance(domain, minutes, reason || 'Granted via API');
  bumpVersion();

  // Unblock domain in daemon (remove pf rules, close stale tabs)
  await unblockDomain(domain);

  if (shieldActive) {
    // Re-apply with this domain excluded from effectively blocked list
    const applied = await enableBlocking(getEffectivelyBlockedDomains());
    if (!applied) {
      console.error(`[grant] Failed to apply blocking state for ${domain} grant`);
    }
  }

  // Start vigilant monitoring session if requested
  let vigilantSessionId: string | undefined;
  if (vigilant && intent) {
    try {
      vigilantSessionId = startVigilantSession(
        domain,
        intent,
        allowance.expiresAt,
        () => handleVigilantViolation(domain, shieldActive, bumpVersion),
      );
      console.log(`[vigilant] Session started: ${vigilantSessionId} for ${domain}`);
    } catch (err) {
      console.error('[vigilant] Failed to start session:', err);
    }
  }

  res.json({
    success: true,
    domain,
    minutes,
    expiresAt: allowance.expiresAt,
    ...(vigilantSessionId ? { vigilant: true, vigilantSessionId } : {}),
  });
});

// Revoke allowance
app.delete('/api/grant/:domain', async (req: Request, res: Response) => {
  const { domain } = req.params;
  revokeAllowance(domain);
  stopSessionsForDomain(domain);
  bumpVersion();

  if (shieldActive) {
    // Re-apply with revoked domain back in effectively blocked list
    await enableBlocking(getEffectivelyBlockedDomains());
  }

  // Aggressively enforce: kill connections, close tabs.
  // Guard: revoking a grant for a domain that is not on the blocklist must not
  // create pf rules for it (same failure mode as the expiry checker).
  if (isDomainBlocked(domain)) {
    await enforceDomain(domain);
  }

  res.json({ success: true, domain, revoked: true });
});

// List active allowances
app.get('/api/allowances', (_req: Request, res: Response) => {
  res.json({ allowances: getActiveAllowances() });
});

// Enable shield
app.post('/api/shield/enable', async (_req: Request, res: Response) => {
  const success = await enableBlocking(getEffectivelyBlockedDomains());
  if (success) {
    shieldActive = true;
    bumpVersion();
    res.json({ success: true, shieldActive: true });
  } else {
    res.status(500).json({ error: 'Failed to enable shield - is daemon running?' });
  }
});

// Disable shield
app.post('/api/shield/disable', async (_req: Request, res: Response) => {
  const success = await disableBlocking();
  shieldActive = false;
  bumpVersion();
  res.json({ success: true, shieldActive: false });
});

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
app.post('/api/flush-dns', async (_req: Request, res: Response) => {
  try {
    await flushDnsCache();
    res.json({ success: true, message: 'DNS cache flushed' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to flush DNS', details: String(e) });
  }
});

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
app.post('/api/setup/categories', async (req: Request, res: Response) => {
  const { categories, exceptions } = req.body;
  if (!categories || !Array.isArray(categories)) {
    res.status(400).json({ error: 'categories (array) required' });
    return;
  }
  setEnabledCategories(categories, exceptions || []);
  bumpVersion();

  if (shieldActive) {
    await enableBlocking(getEffectivelyBlockedDomains());
  }

  res.json({ success: true, categories, exceptions: exceptions || [] });
});

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
app.post('/api/setup/activate', async (_req: Request, res: Response) => {
  const success = await enableBlocking(getEffectivelyBlockedDomains());
  if (success) {
    shieldActive = true;
    setOnboardingComplete(true);
    bumpVersion();
    res.json({
      success: true,
      shieldActive: true,
      blockedDomains: getBlockedDomains().length,
    });
  } else {
    res.status(500).json({ error: 'Failed to enable shield - is daemon running?' });
  }
});

// Allowance expiry checker — tracks domain names to enforce blocks on specific expired domains
let lastAllowanceDomains = new Set<string>();
async function checkAllowanceExpiry(): Promise<void> {
  const active = getActiveAllowances();
  const activeDomains = new Set(active.map(a => a.domain));

  // Find which domains expired since last check
  const expiredDomains = [...lastAllowanceDomains].filter(d => !activeDomains.has(d));

  if (expiredDomains.length > 0 && shieldActive) {
    console.log(`Allowances expired for: ${expiredDomains.join(', ')}`);
    bumpVersion();
    // Stop any vigilant sessions for expired domains
    for (const domain of expiredDomains) {
      stopSessionsForDomain(domain);
    }
    await enableBlocking(getEffectivelyBlockedDomains());
    for (const domain of expiredDomains) {
      // Only enforce domains still on the blocklist. Enforcing a never-blocked
      // domain writes pf rules that no layer reports and nothing cleans up
      // (github.com incident, 2026-08-17).
      if (isDomainBlocked(domain)) {
        await enforceDomain(domain);
      }
    }
  }

  lastAllowanceDomains = activeDomains;
}

// Start server
async function start(): Promise<void> {
  // Check daemon
  const daemonRunning = await isDaemonRunning();
  if (!daemonRunning) {
    console.error('Warning: Daemon not running. Start with: sudo node daemon/daemon.cjs');
  }

  // Enable blocking on startup (respecting any existing allowances)
  const effectivelyBlocked = getEffectivelyBlockedDomains();
  const success = await enableBlocking(effectivelyBlocked);
  shieldActive = success;
  lastAllowanceDomains = new Set(getActiveAllowances().map(a => a.domain));
  bumpVersion();

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
  mountMCP(app, () => shieldActive);

  // Start expiry checker
  setInterval(checkAllowanceExpiry, 30000);

  // Periodic browser tab sweep — closes tabs matching the effective blocklist
  // even when DNS-level blocks are bypassed (e.g. browser DoH, cached resolutions).
  setInterval(async () => {
    if (!shieldActive) return;
    const blocked = getEffectivelyBlockedDomains();
    if (blocked.length === 0) return;
    try {
      const closed = await sweepBlockedTabs(blocked);
      if (closed > 0) console.log(`Tab sweep closed ${closed} blocked tab(s)`);
    } catch {
      // sweepBlockedTabs already logs failures
    }
  }, 10000);

  // Start HTTP server
  const server = http.createServer(app);
  server.listen(API_PORT, '127.0.0.1', () => {
    console.log(`Amber Focus API running on http://127.0.0.1:${API_PORT}`);
    console.log(`   Shield active: ${shieldActive}`);
    console.log(`   Blocked domains: ${getBlockedDomains().length} (${effectivelyBlocked.length} effective)`);
    console.log(`   Delayed domains: ${getDelayedDomains().length}`);
  });
}

start().catch(console.error);
