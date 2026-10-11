import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DaemonStatus } from './shared/ipc-types.js';

vi.mock('./daemon-client.js', () => ({ reconcile: vi.fn(), getDaemonStatus: vi.fn() }));
vi.mock('./browser.js', () => ({
  closeTabs: vi.fn(async () => ({ count: 0, errors: [] })),
  reloadTabs: vi.fn(async () => ({ count: 0, errors: [] })),
}));
vi.mock('./vigilant.js', () => ({ startSession: vi.fn(() => 'session'), stopSessionsForDomain: vi.fn() }));

import { reconcile } from './daemon-client.js';

let actions: typeof import('./actions.js');

function status(over: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    running: true,
    pid: 1,
    uptime: 1,
    configPath: null,
    shieldActive: true,
    domainsBlocked: 0,
    lastReconcileAt: Date.now(),
    lastChangeAt: null,
    lastReason: null,
    converged: true,
    lastError: null,
    legacyBlockedAllowed: [],
    ...over,
  };
}

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amber-actions-'));
  const dir = path.join(home, '.config', 'amber-focus');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ blockedDomains: ['youtube.com'] }));
  process.env.HOME = home;
  actions = await import('./actions.js');
});

beforeEach(() => {
  vi.mocked(reconcile).mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('daemonHealthy', () => {
  const now = 10_000_000;
  it('is true for a converged pass within the staleness window', () => {
    expect(actions.daemonHealthy(status({ lastReconcileAt: now - 1_000 }), now)).toBe(true);
  });
  it('is false for a stale, unconverged, never-run or unreachable daemon', () => {
    expect(actions.daemonHealthy(status({ lastReconcileAt: now - actions.RECONCILE_STALE_MS }), now)).toBe(false);
    expect(actions.daemonHealthy(status({ lastReconcileAt: now - 1_000, converged: false }), now)).toBe(false);
    expect(actions.daemonHealthy(status({ lastReconcileAt: null }), now)).toBe(false);
    expect(actions.daemonHealthy(null, now)).toBe(false);
  });
});

describe('applyDesiredState', () => {
  it('reports an unreachable daemon as not applied', async () => {
    vi.mocked(reconcile).mockResolvedValue(null);
    expect(await actions.applyDesiredState('test')).toEqual({ daemonRunning: false, applied: false, error: 'daemon unreachable' });
    expect(reconcile).toHaveBeenCalledWith('test');
  });
  it('reports the daemon error when the pass did not converge', async () => {
    vi.mocked(reconcile).mockResolvedValue(status({ converged: false, lastError: 'pfctl: syntax error' }));
    expect(await actions.applyDesiredState('test')).toEqual({ daemonRunning: true, applied: false, error: 'pfctl: syntax error' });
  });
  it('reports applied only when the pass converged', async () => {
    vi.mocked(reconcile).mockResolvedValue(status());
    expect(await actions.applyDesiredState('test')).toEqual({ daemonRunning: true, applied: true, error: null });
  });
});
