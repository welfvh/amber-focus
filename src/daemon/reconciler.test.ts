import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Reconciler } from './reconciler.js';
import { PfManager } from './pf.js';
import { OperationQueue } from './queue.js';
import type { SystemOperations } from './system.js';
import { LEGACY_MARKER_START, LEGACY_MARKER_END } from '../shared/reconcile.js';

const CONFIG = '/cfg/config.json';
const HOSTS = '/etc/hosts';

function makeSys() {
  const files = new Map<string, string>();
  const writes: string[] = [];
  const sys: SystemOperations = {
    async readFile(p) {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    async writeFile(p, c) { files.set(p, c); },
    async writeFileAtomic(p, c) { files.set(p, c); writes.push(p); },
    async fileExists(p) { return files.has(p); },
    async exec() { return { stdout: '', stderr: '' }; },
    async execSilent() { return { stdout: '', stderr: '' }; },
  };
  return { sys, files, writes };
}

function makeDeps() {
  const { sys, files, writes } = makeSys();
  const pf = {
    updateStaticRules: vi.fn(async () => {}),
    refreshDynamicRules: vi.fn(async () => {}),
    blockDomain: vi.fn(async () => ['1.2.3.4']),
  };
  const browser = {
    flushBrowserDnsCache: vi.fn(async () => true),
  };
  let now = 1_000_000;
  const r = new Reconciler({
    sys,
    pf: pf as never,
    browser: browser as never,
    log: () => {},
    hostsPath: HOSTS,
    now: () => now,
    sleep: async () => {},
  });
  r.configPath = CONFIG;
  files.set(HOSTS, '127.0.0.1 localhost\n');
  const setConfig = (cfg: unknown) => files.set(CONFIG, JSON.stringify(cfg));
  const advance = (ms: number) => { now += ms; };
  return { r, sys, files, writes, pf, browser, setConfig, advance, now: () => now };
}

describe('Reconciler', () => {
  let d: ReturnType<typeof makeDeps>;
  beforeEach(() => { d = makeDeps(); });

  it('writes hosts and pf on boot, then stays idle when nothing changed', async () => {
    d.setConfig({ blockedDomains: ['a.com', 'b.com'], allowances: [] });
    const s1 = await d.r.tick('boot');
    expect(s1.converged).toBe(true);
    expect(s1.domainsBlocked).toBe(2);
    expect(d.files.get(HOSTS)).toContain('0.0.0.0 a.com');
    expect(d.writes).toEqual([HOSTS]);
    expect(d.pf.updateStaticRules).toHaveBeenCalledWith(true);
    expect(d.pf.refreshDynamicRules).toHaveBeenCalledWith(['a.com', 'b.com'], true);
    expect(d.pf.blockDomain).not.toHaveBeenCalled(); // fresh install: no prior section to diff against
    expect(d.browser.flushBrowserDnsCache).not.toHaveBeenCalled();

    const s2 = await d.r.tick('timer');
    expect(s2.converged).toBe(true);
    expect(d.writes).toEqual([HOSTS]); // no second write
    expect(d.pf.refreshDynamicRules).toHaveBeenCalledTimes(1);
  });

  it('applies a grant: drops the domain from hosts, flushes browser DNS, and re-blocks on expiry', async () => {
    d.setConfig({ blockedDomains: ['a.com', 'b.com'], allowances: [] });
    await d.r.tick('boot');

    d.setConfig({ blockedDomains: ['a.com', 'b.com'], allowances: [{ domain: 'a.com', expiresAt: 1_000_000 + 60_000, reason: 'x' }] });
    const granted = await d.r.tick('config-change');
    expect(granted.converged).toBe(true);
    expect(granted.domainsBlocked).toBe(1);
    expect(d.files.get(HOSTS)).not.toContain('0.0.0.0 a.com');
    expect(d.files.get(HOSTS)).toContain('0.0.0.0 b.com');
    expect(d.browser.flushBrowserDnsCache).toHaveBeenCalledTimes(1);
    expect(d.pf.blockDomain).not.toHaveBeenCalled();

    d.advance(120_000);
    const expired = await d.r.tick('timer');
    expect(expired.domainsBlocked).toBe(2);
    expect(d.files.get(HOSTS)).toContain('0.0.0.0 a.com');
    expect(d.pf.blockDomain).toHaveBeenCalledWith('a.com');
  });

  it('retries pf and the side effects when a pass fails after the hosts write', async () => {
    d.setConfig({ blockedDomains: ['a.com', 'b.com'], allowances: [] });
    await d.r.tick('boot');

    d.setConfig({ blockedDomains: ['a.com', 'b.com'], allowances: [{ domain: 'a.com', expiresAt: 1_000_000 + 60_000 }] });
    d.pf.refreshDynamicRules.mockRejectedValueOnce(new Error('pf write failed'));
    const failed = await d.r.tick('config-change');
    expect(failed.converged).toBe(false);
    expect(failed.lastError).toMatch(/pf write failed/);
    expect(d.files.get(HOSTS)).not.toContain('0.0.0.0 a.com'); // hosts already written

    const retried = await d.r.tick('timer');
    expect(retried.converged).toBe(true);
    expect(retried.lastError).toBeNull();
    expect(d.pf.refreshDynamicRules).toHaveBeenCalledTimes(3); // boot, failed, retry
    expect(d.pf.refreshDynamicRules).toHaveBeenLastCalledWith(['b.com'], true);
    expect(d.browser.flushBrowserDnsCache).toHaveBeenCalledTimes(1);
  });

  it('fails the pass and retries pf while pfctl cannot load the rules', async () => {
    let pfctlFails = false;
    let pfctlLoads = 0;
    d.sys.exec = async (cmd, args) => {
      if (cmd === '/sbin/pfctl' && args[0] === '-f') {
        pfctlLoads++;
        if (pfctlFails) throw new Error('pfctl: syntax error');
      }
      return { stdout: '', stderr: '' };
    };
    d.sys.execSilent = async (cmd, args) => {
      try { return await d.sys.exec(cmd, args); } catch { return null; }
    };
    d.files.set('/etc/pf.conf', '');
    const r = new Reconciler({
      sys: d.sys,
      pf: new PfManager(d.sys, new OperationQueue()),
      browser: d.browser as never,
      log: () => {},
      hostsPath: HOSTS,
      now: d.now,
      sleep: async () => {},
    });
    r.configPath = CONFIG;
    d.setConfig({ blockedDomains: ['a.com', 'b.com'], allowances: [] });
    expect((await r.tick('boot')).converged).toBe(true);

    d.setConfig({ blockedDomains: ['a.com', 'b.com'], allowances: [{ domain: 'a.com', expiresAt: 1_000_000 + 60_000 }] });
    pfctlFails = true;
    const failed = await r.tick('config-change');
    expect(failed.converged).toBe(false);
    expect(failed.lastError).toMatch(/pfctl/);

    pfctlFails = false;
    const loadsBefore = pfctlLoads;
    const retried = await r.tick('timer');
    expect(retried.converged).toBe(true);
    expect(retried.lastError).toBeNull();
    expect(pfctlLoads).toBeGreaterThan(loadsBefore);
    expect(d.browser.flushBrowserDnsCache).toHaveBeenCalledTimes(1);
  });

  it('enforces connections when a grant that allowed every domain expires', async () => {
    d.setConfig({ blockedDomains: ['a.com'], allowances: [] });
    await d.r.tick('boot');
    d.setConfig({ blockedDomains: ['a.com'], allowances: [{ domain: 'a.com', expiresAt: 1_000_000 + 60_000 }] });
    const granted = await d.r.tick('config-change');
    expect(granted.domainsBlocked).toBe(0);

    d.advance(120_000);
    await d.r.tick('timer');
    expect(d.files.get(HOSTS)).toContain('0.0.0.0 a.com');
    expect(d.pf.blockDomain).toHaveBeenCalledWith('a.com');
  });

  it('enforces connections on expiry after a daemon restart while every domain was allowed', async () => {
    d.setConfig({ blockedDomains: ['a.com'], allowances: [{ domain: 'a.com', expiresAt: 1_000_000 + 60_000 }] });
    await d.r.tick('boot');

    d.advance(120_000);
    const restarted = new Reconciler({
      sys: d.sys,
      pf: d.pf as never,
      browser: d.browser as never,
      log: () => {},
      hostsPath: HOSTS,
      now: d.now,
      sleep: async () => {},
    });
    restarted.configPath = CONFIG;
    await restarted.tick('boot');
    expect(d.files.get(HOSTS)).toContain('0.0.0.0 a.com');
    expect(d.pf.blockDomain).toHaveBeenCalledWith('a.com');
  });

  it('keeps the side effects of a failed first pass after a daemon restart', async () => {
    const restart = () => {
      const r = new Reconciler({
        sys: d.sys,
        pf: d.pf as never,
        browser: d.browser as never,
        log: () => {},
        hostsPath: HOSTS,
        now: d.now,
        sleep: async () => {},
      });
      r.configPath = CONFIG;
      return r;
    };
    d.setConfig({ blockedDomains: ['a.com', 'b.com'], allowances: [] });
    await d.r.tick('boot');

    // Granted while the daemon was down: the first pass fails after the hosts write.
    d.setConfig({ blockedDomains: ['a.com', 'b.com'], allowances: [{ domain: 'a.com', expiresAt: 1_000_000 + 60_000 }] });
    const granting = restart();
    d.pf.refreshDynamicRules.mockRejectedValueOnce(new Error('pf write failed'));
    expect((await granting.tick('boot')).converged).toBe(false);
    expect(d.files.get(HOSTS)).not.toContain('0.0.0.0 a.com');
    expect((await granting.tick('timer')).converged).toBe(true);
    expect(d.browser.flushBrowserDnsCache).toHaveBeenCalledTimes(1);

    // Expired while the daemon was down: same failure, then the retry enforces.
    d.advance(120_000);
    const expiring = restart();
    d.pf.refreshDynamicRules.mockRejectedValueOnce(new Error('pf write failed'));
    expect((await expiring.tick('boot')).converged).toBe(false);
    expect(d.files.get(HOSTS)).toContain('0.0.0.0 a.com');
    expect((await expiring.tick('timer')).converged).toBe(true);
    expect(d.pf.blockDomain).toHaveBeenCalledWith('a.com');
  });

  it('keeps the OS untouched and reports the error when config.json is unreadable', async () => {
    d.setConfig({ blockedDomains: ['a.com'], allowances: [] });
    await d.r.tick('boot');
    const before = d.files.get(HOSTS);

    d.files.set(CONFIG, '{ not json');
    const s = await d.r.tick('config-change');
    expect(s.converged).toBe(false);
    expect(s.lastError).toMatch(/JSON/);
    expect(d.files.get(HOSTS)).toBe(before);

    d.files.set(CONFIG, JSON.stringify({ allowances: [{ domain: 5 }] }));
    const s2 = await d.r.tick('config-change');
    expect(s2.converged).toBe(false);
    expect(s2.lastError).toMatch(/invalid/);
  });

  it('reports when the config path is unknown', async () => {
    d.r.configPath = null;
    const s = await d.r.tick('boot');
    expect(s.converged).toBe(false);
    expect(s.lastError).toMatch(/config path/);
  });

  it('empties the section when the shield is switched off', async () => {
    d.setConfig({ blockedDomains: ['a.com'], allowances: [], shieldActive: true });
    await d.r.tick('boot');
    d.setConfig({ blockedDomains: ['a.com'], allowances: [], shieldActive: false });
    const s = await d.r.tick('config-change');
    expect(s.shieldActive).toBe(false);
    expect(d.files.get(HOSTS)).not.toContain('a.com\n');
    expect(d.files.get(HOSTS)).toMatch(/^# Domains:$/m);
    expect(d.pf.updateStaticRules).toHaveBeenLastCalledWith(false);
    expect(d.browser.flushBrowserDnsCache).toHaveBeenCalledTimes(1);
  });

  it('flags allowed domains that the legacy section still blocks', async () => {
    d.files.set(HOSTS, `127.0.0.1 localhost\n${LEGACY_MARKER_START}\n0.0.0.0 a.com\n${LEGACY_MARKER_END}\n`);
    d.setConfig({ blockedDomains: ['a.com'], allowances: [{ domain: 'a.com', expiresAt: 2_000_000 }] });
    const s = await d.r.tick('boot');
    expect(s.converged).toBe(true);
    expect(s.legacyBlockedAllowed).toEqual(['a.com']);
  });

  it('migrates an old-format section without tab side effects', async () => {
    d.files.set(HOSTS, `127.0.0.1 localhost\n\n# BEGIN AMBER FOCUS BLOCK\n# Generated: old\n0.0.0.0 a.com\n:: a.com\n0.0.0.0 www.a.com\n# END AMBER FOCUS BLOCK\n`);
    d.setConfig({ blockedDomains: ['a.com'], allowances: [] });
    const s = await d.r.tick('boot');
    expect(s.converged).toBe(true);
    expect(d.files.get(HOSTS)).toContain('# Domains: a.com');
    expect(d.browser.flushBrowserDnsCache).not.toHaveBeenCalled();
    expect(d.pf.blockDomain).not.toHaveBeenCalled();
  });

  it('never writes an invalid domain to hosts, and an invalid allowance opens nothing', async () => {
    d.setConfig({
      blockedDomains: ['a.com', 'evil.com\n1.2.3.4 bank.com', '1.2.3.4', 'localhost', 'b c.com', '"x".com'],
      allowances: [{ domain: 'a.com\n', expiresAt: 2_000_000 }],
    });
    const s = await d.r.tick('boot');
    expect(s.converged).toBe(true);
    expect(s.domainsBlocked).toBe(1);
    const hosts = d.files.get(HOSTS)!;
    expect(hosts).toContain('0.0.0.0 a.com');
    expect(hosts.slice(hosts.indexOf("# BEGIN"))).not.toMatch(/bank\.com|1\.2\.3\.4|localhost|b c\.com|"x"/);
    expect(d.pf.refreshDynamicRules).toHaveBeenCalledWith(['a.com'], true);
  });

  it('serializes overlapping ticks so each caller sees a full pass', async () => {
    d.setConfig({ blockedDomains: ['a.com'], allowances: [] });
    const [s1, s2] = await Promise.all([d.r.tick('a'), d.r.tick('b')]);
    expect(s1.lastReason).toBe('a');
    expect(s2.lastReason).toBe('b');
    expect(d.writes).toEqual([HOSTS]);
  });
});
