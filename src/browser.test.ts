import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { hostOf, hostMatches, shownPage, SCRIPT } from './browser.js';

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

describe('shownPage', () => {
  const pages = [
    { url: 'https://youtube.com/watch?v=cats', title: 'Funny cats' },
    { url: 'https://youtube.com/watch?v=dogs', title: 'Dogs' },
  ];

  it('matches a tab only while it shows the same URL and title', () => {
    expect(shownPage('https://youtube.com/watch?v=cats', () => 'Funny cats', pages)).toEqual(pages[0]);
    expect(shownPage('https://youtube.com/watch?v=cats', () => 'HUF HAUS tour', pages)).toBeNull();
    expect(shownPage('https://youtube.com/watch?v=huf', () => 'Funny cats', pages)).toBeNull();
  });

  it('reads the title only for a listed URL, and at most once', () => {
    let reads = 0;
    const readTitle = () => { reads++; return 'other'; };
    shownPage('https://youtube.com/watch?v=huf', readTitle, pages);
    expect(reads).toBe(0);
    shownPage('https://youtube.com/watch?v=cats', readTitle, [...pages, { url: 'https://youtube.com/watch?v=cats', title: 'x' }]);
    expect(reads).toBe(1);
  });
});

describe.runIf(process.platform === 'darwin')('JXA script', () => {
  it('compiles and runs in osascript (no browser touched)', () => {
    const out = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, JSON.stringify({ op: 'list', browsers: [] })]);
    expect(JSON.parse(out.toString())).toEqual({ tabs: [], count: 0, errors: [] });
  });
  it('runs a closePages request (no browser touched)', () => {
    const req = { op: 'closePages', browsers: [], pages: [{ url: 'https://youtube.com/watch?v=x', title: '"); do shell script "touch /tmp/pwn' }] };
    const out = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, JSON.stringify(req)]);
    expect(JSON.parse(out.toString())).toEqual({ tabs: [], count: 0, errors: [] });
  });
  it('runs shownPage in JXA', () => {
    const script = `${shownPage.toString()}\nfunction run(argv) { var r = JSON.parse(argv[0]); return JSON.stringify(shownPage(r.url, function () { return r.title; }, r.pages)); }`;
    const page = { url: 'https://youtube.com/watch?v=x', title: 'Funny cats' };
    const run = (title: string) => JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, JSON.stringify({ url: page.url, title, pages: [page] })]).toString());
    expect(run('Funny cats')).toEqual(page);
    expect(run('HUF HAUS tour')).toBeNull();
  });
  it('treats a hostile domain as data', () => {
    const req = { op: 'close', browsers: [], domains: ['"); do shell script "touch /tmp/pwn'] };
    const out = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, JSON.stringify(req)]);
    expect(JSON.parse(out.toString()).count).toBe(0);
  });
});
