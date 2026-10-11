import { describe, it, expect } from 'vitest';
import { parseDomain, parseMinutes, parseText, MAX_GRANT_MINUTES } from './policy.js';

describe('parseDomain', () => {
  it('normalizes input', () => {
    expect(parseDomain(' WWW.YouTube.com. ')).toEqual({ ok: true, value: 'youtube.com' });
    expect(parseDomain('news.google.com')).toEqual({ ok: true, value: 'news.google.com' });
  });
  it('refuses public suffixes, IPs and malformed names', () => {
    for (const raw of ['com', 'co.uk', 'de.', '1.2.3.4', 'localhost', 'a.com\nb.com', 'a b.com', '', 7, null]) {
      expect(parseDomain(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });
});

describe('parseMinutes', () => {
  it(`accepts whole minutes from 1 to ${MAX_GRANT_MINUTES}`, () => {
    expect(parseMinutes(1)).toEqual({ ok: true, value: 1 });
    expect(parseMinutes('20')).toEqual({ ok: true, value: 20 });
    expect(parseMinutes(MAX_GRANT_MINUTES)).toEqual({ ok: true, value: MAX_GRANT_MINUTES });
  });
  it('refuses everything else', () => {
    for (const raw of [0, -5, 1.5, MAX_GRANT_MINUTES + 1, 43200, '10 min', NaN, Infinity, undefined, null, true]) {
      expect(parseMinutes(raw).ok, String(raw)).toBe(false);
    }
  });
});

describe('parseText', () => {
  it('trims, treats empty as absent, and caps length', () => {
    expect(parseText('  hi ', 'reason', 10)).toEqual({ ok: true, value: 'hi' });
    expect(parseText('', 'reason', 10)).toEqual({ ok: true, value: undefined });
    expect(parseText('x'.repeat(11), 'reason', 10).ok).toBe(false);
    expect(parseText({}, 'reason', 10).ok).toBe(false);
  });
});
