import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { hostOf, hostMatches, SCRIPT } from './browser.js';

describe('hostOf', () => {
  it('extracts the hostname of http(s) URLs only', () => {
    expect(hostOf('https://www.YouTube.com/watch?v=1')).toBe('www.youtube.com');
    expect(hostOf('http://a.com:8080/x')).toBe('a.com');
    expect(hostOf('https://user:pw@b.com/')).toBe('b.com');
    expect(hostOf('https://a.com./')).toBe('a.com');
    expect(hostOf('chrome://newtab/')).toBeNull();
    expect(hostOf('file:///Users/x')).toBeNull();
  });
});

describe('hostMatches', () => {
  it('matches by hostname, never by substring', () => {
    expect(hostMatches('m.youtube.com', ['youtube.com'])).toBe(true);
    expect(hostMatches('youtube.com', ['youtube.com'])).toBe(true);
    expect(hostMatches('dropbox.com', ['x.com'])).toBe(false);
    expect(hostMatches('notyoutube.com', ['youtube.com'])).toBe(false);
  });
});

describe.runIf(process.platform === 'darwin')('JXA script', () => {
  it('compiles and runs in osascript (no browser touched)', () => {
    const out = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, JSON.stringify({ op: 'list', browsers: [] })]);
    expect(JSON.parse(out.toString())).toEqual({ tabs: [], count: 0, errors: [] });
  });
  it('treats a hostile domain as data', () => {
    const req = { op: 'close', browsers: [], domains: ['"); do shell script "touch /tmp/pwn'] };
    const out = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, JSON.stringify(req)]);
    expect(JSON.parse(out.toString()).count).toBe(0);
  });
});
