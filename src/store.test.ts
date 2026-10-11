import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let store: typeof import('./store.js');
let home: string;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'amber-store-'));
  const dir = path.join(home, '.config', 'amber-focus');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    blockedDomains: ['news.google.com', 'youtube.com'],
    hardLockouts: [
      { domain: 'news.google.com', until: '2999-01-01' },
      { domain: 'x.com', until: '2000-01-01' },
    ],
    unknownKey: { keep: true },
  }));
  process.env.HOME = home;
  store = await import('./store.js');
});

describe('lockoutCoveredBy', () => {
  it('refuses a grant on a locked domain, a subdomain of it, or a parent that covers it', () => {
    expect(store.lockoutCoveredBy('news.google.com')?.domain).toBe('news.google.com');
    expect(store.lockoutCoveredBy('a.news.google.com')?.domain).toBe('news.google.com');
    expect(store.lockoutCoveredBy('google.com')?.domain).toBe('news.google.com');
  });
  it('ignores expired locks and unrelated domains', () => {
    expect(store.lockoutCoveredBy('x.com')).toBeNull();
    expect(store.lockoutCoveredBy('youtube.com')).toBeNull();
  });
});

describe('blockingParent', () => {
  it('names the blocklist entry that covers a subdomain', () => {
    expect(store.blockingParent('m.youtube.com')).toBe('youtube.com');
    expect(store.blockingParent('a.news.google.com')).toBe('news.google.com');
  });
  it('is null for a listed domain itself and for unrelated domains', () => {
    expect(store.blockingParent('youtube.com')).toBeNull();
    expect(store.blockingParent('google.com')).toBeNull();
    expect(store.blockingParent('notyoutube.com')).toBeNull();
  });
});

describe('isDomainBlocked', () => {
  it('matches the daemon: an allowance on a subdomain does not open it while the parent is blocked', () => {
    expect(store.isDomainBlocked('m.youtube.com')).toBe(true);
    store.grantAllowance('m.youtube.com', 5, 'test');
    expect(store.isDomainBlocked('m.youtube.com')).toBe(true);
    store.grantAllowance('youtube.com', 5, 'test');
    expect(store.isDomainBlocked('m.youtube.com')).toBe(false);
    expect(store.isDomainBlocked('youtube.com')).toBe(false);
  });
});

describe('save', () => {
  it('keeps keys the store does not know', () => {
    store.addBlockedDomain('reddit.com');
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.config', 'amber-focus', 'config.json'), 'utf8'));
    expect(saved.unknownKey).toEqual({ keep: true });
    expect(saved.blockedDomains).toContain('reddit.com');
  });
});

describe('save failure', () => {
  const dir = () => path.join(home, '.config', 'amber-focus');
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(dir(), 'config.json'), 'utf8'));

  it.skipIf(process.getuid?.() === 0)('throws and leaves memory and file unchanged', () => {
    store.grantAllowance('savefail.com', 5, 'test');
    fs.chmodSync(dir(), 0o500);
    try {
      expect(() => store.revokeAllowance('savefail.com')).toThrow();
    } finally {
      fs.chmodSync(dir(), 0o700);
    }
    expect(store.getActiveAllowances().map(a => a.domain)).toContain('savefail.com');
    expect(onDisk().allowances.map((a: { domain: string }) => a.domain)).toContain('savefail.com');
  });
});

/** A separate store module instance on its own HOME; `setup` prepares the config dir first. */
async function freshStore(setup: (dir: string) => void) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'amber-store-'));
  const dir = path.join(h, '.config', 'amber-focus');
  fs.mkdirSync(dir, { recursive: true });
  setup(dir);
  process.env.HOME = h;
  vi.resetModules();
  const mod: typeof import('./store.js') = await import('./store.js');
  return { mod, file: path.join(dir, 'config.json') };
}

describe('first start', () => {
  it('writes the defaults so the daemon has a config to converge to', async () => {
    const { mod, file } = await freshStore(() => {});
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.shieldActive).toBe(true);
    expect(saved.blockedDomains.length).toBeGreaterThan(0);
    expect(saved.blockedDomains).toEqual(mod.getBlockedDomains());
  });
});

describe('unreadable config.json', () => {
  it.skipIf(process.getuid?.() === 0)('keeps the server up, refuses every change, and recovers once readable', async () => {
    const original = JSON.stringify({ blockedDomains: ['kept.com'] });
    let file = '';
    const { mod } = await freshStore(dir => {
      file = path.join(dir, 'config.json');
      fs.writeFileSync(file, original);
      fs.chmodSync(file, 0o000);
    });
    try {
      expect(() => mod.getBlockedDomains()).toThrow(/cannot read/);
      expect(() => mod.addBlockedDomain('new.com')).toThrow(/cannot read/);
    } finally {
      fs.chmodSync(file, 0o600);
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(mod.getBlockedDomains()).toEqual(['kept.com']);
  });
});
