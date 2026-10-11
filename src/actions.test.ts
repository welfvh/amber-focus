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
import { startSession } from './vigilant.js';

let actions: typeof import('./actions.js');
let store: typeof import('./store.js');

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
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    blockedDomains: ['youtube.com', 'google.com', 'reddit.com'],
    hardLockouts: [
      { domain: 'news.google.com', until: '2999-01-01' },
      { domain: 'reddit.com', until: '2999-01-01' },
    ],
  }));
  process.env.HOME = home;
  actions = await import('./actions.js');
  store = await import('./store.js');
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

describe('unblock', () => {
  it('refuses a parent whose locked subdomain it would open', async () => {
    const result = await actions.unblock('google.com');
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(store.getBlockedDomains()).toContain('google.com');
    expect(reconcile).not.toHaveBeenCalled();
  });
  it('refuses a locked domain and its subdomains', async () => {
    expect(await actions.unblock('reddit.com')).toMatchObject({ ok: false, status: 403 });
    expect(await actions.unblock('old.reddit.com')).toMatchObject({ ok: false, status: 403 });
    expect(store.getBlockedDomains()).toContain('reddit.com');
  });
  it('removes an unlocked domain and converges', async () => {
    vi.mocked(reconcile).mockResolvedValue(status());
    expect(await actions.unblock('youtube.com')).toMatchObject({ ok: true, outcome: { applied: true } });
    expect(store.getBlockedDomains()).not.toContain('youtube.com');
    expect(reconcile).toHaveBeenCalledWith('unblock:youtube.com');
  });
});

describe('grant', () => {
  beforeEach(() => {
    vi.mocked(reconcile).mockResolvedValue(status());
    vi.mocked(startSession).mockClear();
  });

  it('refuses a vigilant grant without a usable intent', async () => {
    for (const intent of [undefined, '', '   ']) {
      expect(await actions.grant({ domain: 'vimeo.com', minutes: 5, vigilant: true, intent })).toMatchObject({ ok: false, status: 400 });
    }
    expect(store.getActiveAllowances().map(a => a.domain)).not.toContain('vimeo.com');
    expect(reconcile).not.toHaveBeenCalled();
  });
  it('runs a vigilant grant under monitoring with the trimmed intent', async () => {
    const result = await actions.grant({ domain: 'vimeo.com', minutes: 5, vigilant: true, intent: ' watch the talk ' });
    expect(result).toMatchObject({ ok: true, vigilantSessionId: 'session' });
    expect(startSession).toHaveBeenCalledWith('vimeo.com', 'watch the talk', expect.any(Number), expect.any(Function));
  });
  it('reports the hard lock first when the blocking parent is also locked', async () => {
    const result = await actions.grant({ domain: 'old.reddit.com', minutes: 5 });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(await actions.grant({ domain: 'reddit.com', minutes: 5 })).toMatchObject({ ok: false, status: 403 });
  });
  it('points a subdomain grant at its blocking parent when nothing is locked', async () => {
    expect(await actions.grant({ domain: 'mail.google.com', minutes: 5 })).toMatchObject({ ok: false, status: 400 });
  });
  it('starts monitoring only for the grant that is current when its pass ends', async () => {
    let releaseFirst!: (s: DaemonStatus) => void;
    vi.mocked(reconcile).mockImplementationOnce(() => new Promise(r => { releaseFirst = r; }));
    const first = actions.grant({ domain: 'vimeo.com', minutes: 10, vigilant: true, intent: 'old intent' });
    const second = await actions.grant({ domain: 'vimeo.com', minutes: 30, vigilant: true, intent: 'new intent' });
    releaseFirst(status());
    expect(second).toMatchObject({ ok: true, vigilantSessionId: 'session' });
    expect(await first).toMatchObject({ ok: true, vigilantSessionId: null });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith('vimeo.com', 'new intent', expect.any(Number), expect.any(Function));
  });
  it('starts no monitoring for a grant revoked while it converged', async () => {
    let release!: (s: DaemonStatus) => void;
    vi.mocked(reconcile).mockImplementationOnce(() => new Promise(r => { release = r; }));
    const pending = actions.grant({ domain: 'vimeo.com', minutes: 10, vigilant: true, intent: 'watch the talk' });
    await actions.revoke('vimeo.com', 'revoke');
    release(status());
    expect(await pending).toMatchObject({ ok: true, vigilantSessionId: null });
    expect(startSession).not.toHaveBeenCalled();
  });
  it('keeps monitoring when a vigilant grant is extended without an intent', async () => {
    await actions.grant({ domain: 'vimeo.com', minutes: 5, vigilant: true, intent: 'watch the talk' });
    const extended = await actions.grant({ domain: 'vimeo.com', minutes: 30 });
    expect(extended).toMatchObject({ ok: true, vigilantSessionId: 'session' });
    expect(startSession).toHaveBeenLastCalledWith('vimeo.com', 'watch the talk', expect.any(Number), expect.any(Function));
    expect(store.getActiveAllowances().find(a => a.domain === 'vimeo.com')?.vigilantIntent).toBe('watch the talk');
    await actions.revoke('vimeo.com', 'revoke');
  });
  it('ignores an intent when monitoring was not asked for', async () => {
    const result = await actions.grant({ domain: 'vimeo.com', minutes: 5, intent: 'not monitored' });
    expect(result).toMatchObject({ ok: true, vigilantSessionId: null });
    expect(startSession).not.toHaveBeenCalled();
  });
});
