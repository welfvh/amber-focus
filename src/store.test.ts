import { describe, it, expect, beforeAll } from 'vitest';
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

describe('save', () => {
  it('keeps keys the store does not know', () => {
    store.addBlockedDomain('reddit.com');
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.config', 'amber-focus', 'config.json'), 'utf8'));
    expect(saved.unknownKey).toEqual({ keep: true });
    expect(saved.blockedDomains).toContain('reddit.com');
  });
});
