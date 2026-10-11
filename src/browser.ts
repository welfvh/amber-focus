/**
 * Browser tabs — read, close, reload — through JXA, as the logged-in user.
 *
 * The request goes to the script as a JSON argument and is never spliced into
 * its source, so no domain or URL can change what the script does. Only
 * browsers that are already running are touched: `Application(name).running()`
 * never launches one.
 *
 * The first call from the server triggers macOS's one-time Automation prompt
 * ("node" wants to control "Google Chrome"). Until it is allowed, every call
 * reports the denial in `errors`.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { isValidHostname } from './shared/domains.js';

const execFileAsync = promisify(execFile);

const OSASCRIPT = '/usr/bin/osascript';
const TIMEOUT_MS = 15_000;
export const BROWSERS = ['Google Chrome', 'Safari', 'Arc'] as const;

/** Lowercased hostname of an http(s) URL; null for anything else. Also runs inside JXA. */
export function hostOf(url: string): string | null {
  const m = /^https?:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url);
  return m ? m[1].toLowerCase().replace(/\.$/, '') : null;
}

/** True when `host` equals one of `domains` or is a subdomain of one. Also runs inside JXA. */
export function hostMatches(host: string, domains: string[]): boolean {
  for (const d of domains) {
    if (host === d || host.endsWith('.' + d)) return true;
  }
  return false;
}

export interface BrowserTab {
  browser: string;
  url: string;
  title: string;
  /** The selected tab of its window. */
  active: boolean;
  /** Its window is the browser's front window. */
  frontWindow: boolean;
  /** The browser is the frontmost app. */
  browserFrontmost: boolean;
}

/** What a tab shows: its URL and title. */
export type Page = Pick<BrowserTab, 'url' | 'title'>;

/**
 * The entry of `pages` that a tab on `url` shows, or null. `readTitle` runs at most once,
 * and only for a listed URL: each title read is one Apple event. Also runs inside JXA.
 */
export function shownPage(url: string, readTitle: () => string, pages: Page[]): Page | null {
  let title: string | null = null;
  for (const p of pages) {
    if (p.url !== url) continue;
    if (title === null) title = readTitle();
    if (p.title === title) return p;
  }
  return null;
}

interface ScriptResult {
  tabs: BrowserTab[];
  count: number;
  /** One entry per browser that could not be read (Automation denied, timeout, ...). */
  errors: string[];
}

type Op = 'list' | 'close' | 'reload' | 'closePages';

export const SCRIPT = `
${hostOf.toString()}
${hostMatches.toString()}
${shownPage.toString()}
function titleOf(t, safari) {
  try { return (safari ? t.name() : t.title()) || ''; } catch (e) { return ''; }
}
function run(argv) {
  var req = JSON.parse(argv[0]);
  var result = { tabs: [], count: 0, errors: [] };
  for (var b = 0; b < req.browsers.length; b++) {
    var name = req.browsers[b];
    var app;
    try {
      app = Application(name);
      if (!app.running()) continue;
    } catch (e) {
      continue; // not installed
    }
    try {
      var safari = name === 'Safari';
      var frontmost = app.frontmost();
      var windows = app.windows();
      for (var wi = 0; wi < windows.length; wi++) {
        var w = windows[wi];
        var activeIndex = -1;
        try { activeIndex = (safari ? w.currentTab().index() : w.activeTabIndex()) - 1; } catch (e) {}
        var tabs = w.tabs();
        for (var ti = tabs.length - 1; ti >= 0; ti--) {
          var t = tabs[ti];
          var url = '';
          try { url = t.url() || ''; } catch (e) { continue; }
          var hit;
          if (req.op === 'closePages') {
            hit = shownPage(url, function () { return titleOf(t, safari); }, req.pages || []) !== null;
          } else {
            var host = hostOf(url);
            hit = host !== null && hostMatches(host, req.domains || []);
          }
          if (req.op === 'list') {
            if (req.domains && !hit) continue;
            result.tabs.push({ browser: name, url: url, title: titleOf(t, safari), active: ti === activeIndex,
              frontWindow: wi === 0, browserFrontmost: frontmost });
          } else if (hit) {
            if (req.op === 'close' || req.op === 'closePages') t.close();
            else if (safari) t.url = url; // Safari tabs have no reload verb
            else t.reload();
            result.count++;
          }
        }
      }
    } catch (e) {
      result.errors.push(name + ': ' + e.message);
    }
  }
  return JSON.stringify(result);
}
`;

async function runScript(op: Op, domains?: string[], pages?: Page[]): Promise<ScriptResult> {
  const req = {
    op,
    browsers: BROWSERS,
    ...(domains ? { domains: domains.filter(isValidHostname) } : {}),
    ...(pages ? { pages: pages.filter(p => hostOf(p.url) !== null).map(p => ({ url: p.url, title: p.title })) } : {}),
  };
  try {
    const { stdout } = await execFileAsync(
      OSASCRIPT,
      ['-l', 'JavaScript', '-e', SCRIPT, JSON.stringify(req)],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as ScriptResult;
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return { tabs: [], count: 0, errors: [`osascript: ${message}`] };
  }
}

/** Open tabs; with `domains`, only tabs on those domains. */
export async function listTabs(domains?: string[]): Promise<{ tabs: BrowserTab[]; errors: string[] }> {
  const { tabs, errors } = await runScript('list', domains);
  return { tabs, errors };
}

/** Close every tab on `domains`. */
export async function closeTabs(domains: string[]): Promise<{ count: number; errors: string[] }> {
  if (domains.length === 0) return { count: 0, errors: [] };
  const { count, errors } = await runScript('close', domains);
  return { count, errors };
}

/**
 * Close every tab that still shows one of `pages`: the exact URL and title `listTabs` reported.
 * A tab whose title changed since then stays open.
 */
export async function closePages(pages: Page[]): Promise<{ count: number; errors: string[] }> {
  if (pages.length === 0) return { count: 0, errors: [] };
  const { count, errors } = await runScript('closePages', undefined, pages);
  return { count, errors };
}

/** Reload every tab on `domains` (after an unblock, so error pages load the site). */
export async function reloadTabs(domains: string[]): Promise<{ count: number; errors: string[] }> {
  if (domains.length === 0) return { count: 0, errors: [] };
  const { count, errors } = await runScript('reload', domains);
  return { count, errors };
}
