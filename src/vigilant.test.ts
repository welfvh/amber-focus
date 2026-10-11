import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVigilant, MAX_FAILURES, NAV_LIMIT_MS, TICK_MS, type TabVerdict, type VigilantDeps } from './vigilant.js';
import type { BrowserTab } from './browser.js';

function tab(url: string, title = url): BrowserTab {
  return { browser: 'Google Chrome', url, title, active: true, frontWindow: true, browserFrontmost: true };
}

/** Fake world: open tabs, scripted verdicts by title or URL, recorded side effects. */
function world(verdicts: Record<string, TabVerdict['verdict']>) {
  const state = {
    now: 1_000_000,
    tabs: [] as BrowserTab[],
    listErrors: [] as string[],
    judgeError: null as string | null,
    judged: [] as string[],
    closed: [] as string[],
    notes: [] as string[],
    ended: [] as string[],
    /** Runs inside a call, before it returns: stands in for events during the await. */
    during: {} as { list?: () => void; judge?: () => void; close?: () => void },
  };
  const deps: VigilantDeps = {
    listTabs: async () => {
      state.during.list?.();
      return { tabs: state.tabs, errors: state.listErrors };
    },
    closeUrls: async (urls) => {
      state.during.close?.();
      state.closed.push(...urls);
      state.tabs = state.tabs.filter(t => !urls.includes(t.url));
      return { count: urls.length, errors: [] };
    },
    judge: async (_d, _i, tabs) => {
      if (state.judgeError) throw new Error(state.judgeError);
      state.judged.push(...tabs.map(t => t.url));
      state.during.judge?.();
      return tabs.map(t => ({ verdict: verdicts[t.title] ?? verdicts[t.url] ?? 'off_task', reason: 'test' }));
    },
    notify: (title) => { state.notes.push(title); },
    log: () => {},
    now: () => state.now,
  };
  const v = createVigilant(deps);
  const id = v.start('youtube.com', 'huf haus tours', state.now + 20 * 60_000, async (reason) => { state.ended.push(reason); });
  return { v, id, state };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('vigilant tick', () => {
  it('keeps on-task tabs and judges each URL once', async () => {
    const { v, id, state } = world({ 'https://youtube.com/watch?v=huf': 'on_task' });
    state.tabs = [tab('https://youtube.com/watch?v=huf')];
    await v.tick(id);
    await v.tick(id);
    expect(state.judged).toEqual(['https://youtube.com/watch?v=huf']);
    expect(state.closed).toEqual([]);
    expect(v.status().sessions[0].strikes).toBe(0);
    v.stop(id);
  });

  it('closes an off-task tab at once and counts a strike', async () => {
    const { v, id, state } = world({});
    state.tabs = [tab('https://youtube.com/watch?v=cats', 'Funny cats')];
    await v.tick(id);
    expect(state.closed).toEqual(['https://youtube.com/watch?v=cats']);
    expect(state.notes).toEqual(['Closed off-intent tab (1/3)']);
    expect(v.status().sessions[0].strikes).toBe(1);
    v.stop(id);
  });

  it('ends the grant at the third strike', async () => {
    const { v, id, state } = world({});
    for (const n of [1, 2, 3]) {
      state.tabs = [tab(`https://youtube.com/watch?v=${n}`)];
      await v.tick(id);
    }
    expect(state.ended).toHaveLength(1);
    expect(v.status().active).toBe(false);
  });

  it('counts a reopened off-task URL again without asking the model again', async () => {
    const { v, id, state } = world({});
    state.tabs = [tab('https://youtube.com/watch?v=x')];
    await v.tick(id);
    state.tabs = [tab('https://youtube.com/watch?v=x')];
    await v.tick(id);
    expect(state.judged).toHaveLength(1);
    expect(v.status().sessions[0].strikes).toBe(2);
    v.stop(id);
  });

  it('allows a navigation page for NAV_LIMIT_MS, then closes it', async () => {
    const { v, id, state } = world({ 'https://youtube.com/': 'navigation' });
    state.tabs = [tab('https://youtube.com/')];
    await v.tick(id);
    for (let t = 0; t < NAV_LIMIT_MS - TICK_MS; t += TICK_MS) {
      state.now += TICK_MS;
      await v.tick(id);
    }
    expect(state.closed).toEqual([]);
    state.now += TICK_MS;
    await v.tick(id);
    expect(state.closed).toEqual(['https://youtube.com/']);
    expect(v.status().sessions[0].strikes).toBe(1);
    v.stop(id);
  });

  it('judges a URL again when its title changes', async () => {
    const url = 'https://youtube.com/watch?v=cats';
    const { v, id, state } = world({ 'HUF HAUS tour': 'on_task' });
    state.tabs = [tab(url, 'HUF HAUS tour')]; // a single-page app can show the previous title for a moment
    await v.tick(id);
    expect(state.closed).toEqual([]);
    state.tabs = [tab(url, 'Funny cats')];
    await v.tick(id);
    expect(state.judged).toEqual([url, url]);
    expect(state.closed).toEqual([url]);
    v.stop(id);
  });

  it('closes a URL when any of its tabs shows an off-task title', async () => {
    const url = 'https://youtube.com/watch?v=cats';
    const { v, id, state } = world({ 'HUF HAUS tour': 'on_task' });
    state.tabs = [tab(url, 'Funny cats'), tab(url, 'HUF HAUS tour')];
    await v.tick(id);
    expect(state.closed).toEqual([url]);
    expect(v.status().sessions[0].strikes).toBe(1);
    v.stop(id);
  });

  it('keeps the navigation clock of a URL across title changes', async () => {
    const { v, id, state } = world({ 'https://youtube.com/': 'navigation' });
    let n = 0;
    state.tabs = [tab('https://youtube.com/', `(${n}) YouTube`)];
    await v.tick(id);
    for (let t = 0; t < NAV_LIMIT_MS; t += TICK_MS) {
      state.now += TICK_MS;
      state.tabs = [tab('https://youtube.com/', `(${++n}) YouTube`)];
      await v.tick(id);
    }
    expect(state.closed).toEqual(['https://youtube.com/']);
    v.stop(id);
  });

  it('does nothing while no tab is open on the domain', async () => {
    const { v, id, state } = world({});
    await v.tick(id);
    expect(state.judged).toEqual([]);
    expect(v.status().sessions[0].consecutiveFailures).toBe(0);
    v.stop(id);
  });
});

describe('vigilant fails closed', () => {
  it('ends the grant after MAX_FAILURES ticks that cannot read tabs', async () => {
    const { v, id, state } = world({});
    state.listErrors = ['Google Chrome: Not authorized to send Apple events'];
    for (let i = 1; i < MAX_FAILURES; i++) await v.tick(id);
    expect(state.ended).toEqual([]);
    expect(v.status().degraded).toBe(true);
    await v.tick(id);
    expect(state.ended).toHaveLength(1);
    expect(state.ended[0]).toContain('Not authorized');
  });

  it('ends the grant after MAX_FAILURES ticks without verdicts', async () => {
    const { v, id, state } = world({});
    state.tabs = [tab('https://youtube.com/watch?v=x')];
    state.judgeError = 'Anthropic API error 529: overloaded';
    for (let i = 0; i < MAX_FAILURES; i++) await v.tick(id);
    expect(state.ended).toHaveLength(1);
    expect(state.closed).toEqual([]);
  });

  it('resets the failure count after a good tick', async () => {
    const { v, id, state } = world({});
    state.listErrors = ['osascript: timeout'];
    for (let i = 1; i < MAX_FAILURES; i++) await v.tick(id);
    state.listErrors = [];
    await v.tick(id);
    state.listErrors = ['osascript: timeout'];
    for (let i = 1; i < MAX_FAILURES; i++) await v.tick(id);
    expect(state.ended).toEqual([]);
    v.stop(id);
  });

  it('stops without ending the grant once the grant has expired', async () => {
    const { v, id, state } = world({});
    state.now += 21 * 60_000;
    await v.tick(id);
    expect(v.status().active).toBe(false);
    expect(state.ended).toEqual([]);
  });
});

describe('vigilant stopped during a tick', () => {
  it('acts on nothing once stopped while reading tabs', async () => {
    const { v, id, state } = world({});
    state.listErrors = ['osascript: timeout'];
    state.during.list = () => v.stop(id);
    await v.tick(id);
    expect(state.notes).toEqual([]);
    expect(state.ended).toEqual([]);
  });

  it('closes nothing once stopped while the model judges', async () => {
    const { v, id, state } = world({});
    state.tabs = [tab('https://youtube.com/watch?v=cats')];
    state.during.judge = () => v.stop(id);
    await v.tick(id);
    expect(state.closed).toEqual([]);
    expect(state.notes).toEqual([]);
  });

  it('cannot end a re-grant that replaced it while the model judges', async () => {
    const { v, id, state } = world({});
    for (const n of [1, 2]) {
      state.tabs = [tab(`https://youtube.com/watch?v=${n}`)];
      await v.tick(id);
    }
    state.tabs = [tab('https://youtube.com/watch?v=3')];
    let newId = '';
    state.during.judge = () => {
      newId = v.start('youtube.com', 'watch cat videos', state.now + 20 * 60_000, async (reason) => { state.ended.push(reason); });
    };
    await v.tick(id);
    expect(state.ended).toEqual([]);
    expect(state.closed).not.toContain('https://youtube.com/watch?v=3');
    expect(v.status().sessions.map(s => s.id)).toEqual([newId]);
    v.stop(newId);
  });

  it('counts no strike once stopped while closing tabs', async () => {
    const { v, id, state } = world({});
    for (const n of [1, 2]) {
      state.tabs = [tab(`https://youtube.com/watch?v=${n}`)];
      await v.tick(id);
    }
    state.tabs = [tab('https://youtube.com/watch?v=3')];
    state.during.close = () => v.stop(id);
    await v.tick(id);
    expect(state.ended).toEqual([]);
    expect(state.notes).toEqual(['Closed off-intent tab (1/3)', 'Closed off-intent tab (2/3)']);
  });
});
