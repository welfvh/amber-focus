import { describe, it, expect } from 'vitest';
import {
  DesiredConfigSchema,
  effectiveBlockedDomains,
  desiredStateFromConfig,
  invalidConfigDomains,
  renderHostsSection,
  extractManagedSection,
  parseManagedDomains,
  sectionEquivalent,
  replaceManagedSection,
  diffDomains,
  hostsBlocks,
  buildHostsIndex,
  MARKER_START,
  MARKER_END,
  LEGACY_MARKER_START,
  LEGACY_MARKER_END,
} from './reconcile.js';

const NOW = 1_000_000;

describe('DesiredConfigSchema', () => {
  it('fills defaults and ignores unknown keys', () => {
    const cfg = DesiredConfigSchema.parse({ retreat: { enabled: false }, allowances: [{ domain: 'a.com', expiresAt: 1, reason: 'x' }] });
    expect(cfg.blockedDomains).toEqual([]);
    expect(cfg.shieldActive).toBe(true);
    expect(cfg.allowances[0].domain).toBe('a.com');
  });
  it('rejects malformed allowances', () => {
    expect(() => DesiredConfigSchema.parse({ allowances: [{ domain: 1 }] })).toThrow();
  });
});

describe('effectiveBlockedDomains', () => {
  it('drops allowed domains and their subdomains, keeps expired ones blocked', () => {
    const out = effectiveBlockedDomains(
      ['youtube.com', 'news.google.com', 'www.reddit.com', 'x.com'],
      [
        { domain: 'google.com', expiresAt: NOW + 1 },
        { domain: 'x.com', expiresAt: NOW - 1 },
      ],
      NOW,
    );
    expect(out).toEqual(['reddit.com', 'x.com', 'youtube.com']);
  });
  it('normalizes and dedupes', () => {
    expect(effectiveBlockedDomains(['WWW.A.com', 'a.com'], [], NOW)).toEqual(['a.com']);
  });
});

describe('desiredStateFromConfig', () => {
  it('blocks nothing when the shield is off', () => {
    const cfg = DesiredConfigSchema.parse({ blockedDomains: ['a.com'], shieldActive: false });
    expect(desiredStateFromConfig(cfg, NOW)).toEqual({ shieldActive: false, blockedDomains: [] });
  });
});

describe('hosts section', () => {
  const state = { shieldActive: true, blockedDomains: ['reddit.com', 'youtube.com'] };

  it('round-trips the base domains through the section', () => {
    const section = renderHostsSection(state, '2026-01-01T00:00:00.000Z');
    const content = replaceManagedSection('127.0.0.1 localhost\n', section);
    expect(extractManagedSection(content)).toBe(section);
    expect(parseManagedDomains(content)).toEqual(['reddit.com', 'youtube.com']);
    expect(content).toContain('0.0.0.0 www.youtube.com');
    expect(content).toContain(':: old.reddit.com');
  });

  it('reports unknown previous state for a missing or old-format section', () => {
    expect(parseManagedDomains('127.0.0.1 localhost\n')).toBeNull();
    const oldFormat = `${MARKER_START}\n# Generated: x\n0.0.0.0 a.com\n:: a.com\n${MARKER_END}\n`;
    expect(parseManagedDomains('x\n' + oldFormat)).toBeNull();
  });

  it('treats sections that differ only by timestamp as equivalent', () => {
    const a = renderHostsSection(state, '2026-01-01T00:00:00.000Z');
    const b = renderHostsSection(state, '2026-02-02T00:00:00.000Z');
    expect(a).not.toBe(b);
    expect(sectionEquivalent(a, b)).toBe(true);
    const c = renderHostsSection({ ...state, blockedDomains: ['reddit.com'] }, '2026-02-02T00:00:00.000Z');
    expect(sectionEquivalent(a, c)).toBe(false);
  });

  it('replaces an existing section and can remove it', () => {
    const first = replaceManagedSection('127.0.0.1 localhost\n', renderHostsSection(state, 't1'));
    const second = replaceManagedSection(first, renderHostsSection({ shieldActive: true, blockedDomains: ['a.com'] }, 't2'));
    expect(second.split(MARKER_START).length).toBe(2);
    expect(second).not.toContain('youtube.com');
    expect(second).toContain('0.0.0.0 a.com');
    const removed = replaceManagedSection(second, '');
    expect(removed).toBe('127.0.0.1 localhost\n');
  });

  it('records an empty blocklist as a known state when nothing is blocked', () => {
    for (const state of [{ shieldActive: true, blockedDomains: [] }, { shieldActive: false, blockedDomains: ['a.com'] }]) {
      const content = replaceManagedSection('127.0.0.1 localhost\n', renderHostsSection(state, 't'));
      expect(parseManagedDomains(content)).toEqual([]);
      expect(content).not.toMatch(/^(0\.0\.0\.0|::) /m);
    }
  });
});

describe('diffDomains', () => {
  it('reports added and removed', () => {
    expect(diffDomains(['a.com', 'b.com'], ['b.com', 'c.com'])).toEqual({ added: ['c.com'], removed: ['a.com'] });
  });
});

describe('hostsBlocks', () => {
  const managed = renderHostsSection({ shieldActive: true, blockedDomains: ['reddit.com'] }, 't');
  const legacy = `${LEGACY_MARKER_START}\n0.0.0.0 youtube.com\n0.0.0.0 www.youtube.com\n${LEGACY_MARKER_END}\n`;
  const content = `127.0.0.1 localhost\n${legacy}\n${managed}`;

  it('finds managed, legacy, and none', () => {
    expect(hostsBlocks(content, 'reddit.com')).toBe('managed');
    expect(hostsBlocks(content, 'www.reddit.com')).toBe('managed');
    expect(hostsBlocks(content, 'YouTube.com')).toBe('legacy');
    expect(hostsBlocks(content, 'example.com')).toBeNull();
  });

  it('reports foreign entries as other', () => {
    expect(hostsBlocks('0.0.0.0 foo.com\n' + content, 'foo.com')).toBe('other');
  });

  it('reads entries with inline comments, several hostnames, or leading whitespace', () => {
    const foreign = [
      '0.0.0.0 commented.com # blocked',
      '0.0.0.0\tone.com two.com  three.com',
      '  :: indented.com',
      '# 0.0.0.0 disabled.com',
      '10.0.0.1 internal.com',
    ].join('\n') + '\n';
    const index = buildHostsIndex(foreign + content);
    for (const d of ['commented.com', 'one.com', 'two.com', 'three.com', 'indented.com']) {
      expect(index.lookup(d)).toBe('other');
    }
    expect(index.lookup('disabled.com')).toBeNull();
    expect(index.lookup('internal.com')).toBeNull();
    expect(index.lookup('blocked')).toBeNull();
  });

  it('indexes once and answers lookups without rescanning', () => {
    const index = buildHostsIndex(content);
    expect(index.size).toBeGreaterThan(0);
    expect(index.lookup('reddit.com')).toBe('managed');
    expect(index.lookup('youtube.com')).toBe('legacy');
    expect(index.lookup('nope.com')).toBeNull();
  });

  it('lets a legacy entry override a managed one for the same host', () => {
    const both = `${LEGACY_MARKER_START}\n0.0.0.0 reddit.com\n${LEGACY_MARKER_END}\n${managed}`;
    expect(buildHostsIndex(both).lookup('reddit.com')).toBe('legacy');
  });

  it('handles a large file quickly', () => {
    const big = Array.from({ length: 250_000 }, (_, i) => `0.0.0.0 h${i}.example`).join('\n') + '\n' + managed;
    const t0 = performance.now();
    const index = buildHostsIndex(big);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(index.lookup('h123.example')).toBe('other');
    expect(index.lookup('reddit.com')).toBe('managed');
  });
});

describe('invalid config entries', () => {
  it('drops non-hostnames from the effective blocklist and ignores invalid allowances', () => {
    expect(effectiveBlockedDomains(['a.com', 'a.com\n0.0.0.0 b.com', '10.0.0.1', 'com'], [{ domain: 'a.com ', expiresAt: NOW + 1 }], NOW))
      .toEqual(['a.com']);
  });
  it('lists them for the daemon log', () => {
    const cfg = DesiredConfigSchema.parse({ blockedDomains: ['a.com', 'x y.com'], allowances: [{ domain: '', expiresAt: 1 }] });
    expect(invalidConfigDomains(cfg)).toEqual(['x y.com', '']);
  });
});
