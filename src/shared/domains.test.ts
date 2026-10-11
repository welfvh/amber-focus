import { describe, it, expect } from 'vitest';
import { isValidHostname, matchesDomain } from './domains.js';

describe('isValidHostname', () => {
  it('accepts plain hostnames', () => {
    for (const h of ['a.com', 'news.google.com', 'xn--bcher-kva.de', 'mask-api.icloud.com', '4chan.org', 't.me']) {
      expect(isValidHostname(h), h).toBe(true);
    }
  });
  it('refuses anything that could inject into hosts, pf or a script', () => {
    for (const h of ['', 'com', 'localhost', 'a.com\n1.2.3.4 b.com', 'a.com ', 'a .com', 'A.com', 'a.com"', 'a.com\\',
      '1.2.3.4', '-a.com', 'a-.com', 'a..com', '.a.com', 'a.com.', 'a.com/x', `${'a'.repeat(64)}.com`]) {
      expect(isValidHostname(h), JSON.stringify(h)).toBe(false);
    }
  });
});

describe('matchesDomain', () => {
  it('matches the domain and its subdomains only', () => {
    expect(matchesDomain('m.x.com', 'x.com')).toBe(true);
    expect(matchesDomain('dropbox.com', 'x.com')).toBe(false);
  });
});
