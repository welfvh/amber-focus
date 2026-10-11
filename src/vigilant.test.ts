import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { createVigilant, judgeWithClaude, JUDGE_BATCH, MAX_FAILURES, NAV_LIMIT_MS, TICK_MS, type TabVerdict, type VigilantDeps } from './vigilant.js';
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
    closeErrors: [] as string[],
    judgeError: null as string | null,
    /** Most tabs one fake model call can answer; more stand in for truncated output. */
    judgeCapacity: Infinity,
    batches: [] as number[],
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
    closePages: async (pages) => {
      state.during.close?.();
      const hit = state.tabs.filter(t => pages.some(p => p.url === t.url && p.title === t.title));
      state.closed.push(...hit.map(t => t.url));
      state.tabs = state.tabs.filter(t => !hit.includes(t));
      return { closed: hit.map(t => ({ url: t.url, title: t.title })), errors: state.closeErrors };
    },
    judge: async (_d, _i, tabs) => {
      if (state.judgeError) throw new Error(state.judgeError);
      if (tabs.length > state.judgeCapacity) throw new Error('Failed to parse structured output: truncated');
      state.batches.push(tabs.length);
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

  it('closes only the tabs whose own page is off-task', async () => {
    const url = 'https://youtube.com/watch?v=cats';
    const { v, id, state } = world({ 'HUF HAUS tour': 'on_task' });
    state.tabs = [tab(url, 'Funny cats'), tab(url, 'HUF HAUS tour')];
    await v.tick(id);
    expect(state.closed).toEqual([url]);
    expect(state.tabs).toEqual([tab(url, 'HUF HAUS tour')]);
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

  it('judges many tabs in batches that fit one model reply', async () => {
    const urls = Array.from({ length: 25 }, (_, n) => `https://youtube.com/watch?v=huf${n}`);
    const { v, id, state } = world(Object.fromEntries(urls.map(u => [u, 'on_task' as const])));
    state.judgeCapacity = 10;
    state.tabs = urls.map(u => tab(u));
    for (let i = 0; i < MAX_FAILURES; i++) await v.tick(id);
    expect(state.ended).toEqual([]);
    expect(state.judged).toEqual(urls);
    expect(Math.max(...state.batches)).toBeLessThanOrEqual(JUDGE_BATCH);
    expect(v.status().sessions[0].consecutiveFailures).toBe(0);
    v.stop(id);
  });

  it('keeps the verdicts of earlier batches when a later batch fails', async () => {
    const urls = Array.from({ length: 15 }, (_, n) => `https://youtube.com/watch?v=huf${n}`);
    const { v, id, state } = world(Object.fromEntries(urls.map(u => [u, 'on_task' as const])));
    state.tabs = urls.map(u => tab(u));
    state.during.judge = () => { state.judgeError = 'Anthropic API error 529: overloaded'; };
    await v.tick(id);
    expect(state.judged).toHaveLength(JUDGE_BATCH);
    expect(v.status().sessions[0].consecutiveFailures).toBe(1);
    state.during.judge = undefined;
    state.judgeError = null;
    await v.tick(id);
    expect(state.judged).toEqual(urls);
    expect(v.status().sessions[0].consecutiveFailures).toBe(0);
    v.stop(id);
  });

  it('closes no tab whose title changed while the model judged', async () => {
    const url = 'https://youtube.com/watch?v=huf';
    const { v, id, state } = world({ 'HUF HAUS tour': 'on_task' });
    state.tabs = [tab(url, 'Funny cats')]; // the previous video's title, still shown
    state.during.judge = () => { state.tabs = [tab(url, 'HUF HAUS tour')]; };
    await v.tick(id);
    state.during.judge = undefined;
    await v.tick(id);
    expect(state.closed).toEqual([]);
    expect(state.tabs).toEqual([tab(url, 'HUF HAUS tour')]);
    expect(state.notes).toEqual([]);
    expect(v.status().sessions[0].strikes).toBe(0);
    v.stop(id);
  });

  it('counts no strike for a tab that closed while the model judged', async () => {
    const { v, id, state } = world({});
    state.tabs = [tab('https://youtube.com/watch?v=cats', 'Funny cats')];
    state.during.judge = () => { state.tabs = []; };
    await v.tick(id);
    expect(state.notes).toEqual([]);
    expect(v.status().sessions[0].strikes).toBe(0);
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
  it('counts a closed tab even when another browser fails to close', async () => {
    const { v, id, state } = world({});
    state.tabs = [tab('https://youtube.com/watch?v=cats', 'Funny cats')];
    state.closeErrors = ['Arc: Not authorized to send Apple events'];
    await v.tick(id);
    const session = v.status().sessions[0];
    expect(state.closed).toEqual(['https://youtube.com/watch?v=cats']);
    expect(session.strikes).toBe(1);
    expect(session.consecutiveFailures).toBe(1);
    v.stop(id);
  });

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

/** A real SDK client whose fetch returns one canned Messages API response and records the request. */
function fakeApi(status: number, body: unknown) {
  const requests: { url: string; body: any }[] = [];
  const client = new Anthropic({
    apiKey: 'test',
    maxRetries: 0,
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  });
  return { client, requests };
}

function message(text: string | null, stopReason = 'end_turn') {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
    content: text === null ? [] : [{ type: 'text', text }],
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function apiError(type: string) {
  return { type: 'error', error: { type, message: 'test' } };
}

describe('judgeWithClaude', () => {
  const tabs = [
    { url: 'https://youtube.com/watch?v=huf', title: 'HUF HAUS tour' },
    { url: 'https://youtube.com/watch?v=cats', title: 'Funny cats' },
  ];

  it('sends the tabs as indexed data with a structured output format', async () => {
    const verdicts = [{ index: 0, verdict: 'on_task', reason: 'a' }, { index: 1, verdict: 'off_task', reason: 'b' }];
    const { client, requests } = fakeApi(200, message(JSON.stringify({ verdicts })));
    await judgeWithClaude('youtube.com', 'huf haus tours', tabs, client);
    expect(requests).toHaveLength(1);
    const { url, body } = requests[0];
    expect(url).toMatch(/\/v1\/messages$/);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.max_tokens).toBe(1024);
    expect(body.system).toContain('"huf haus tours"');
    expect(body.messages[0].content).toContain(JSON.stringify(tabs.map((t, index) => ({ index, ...t }))));
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.properties.verdicts.items.required).toEqual(['index', 'verdict', 'reason']);
  });

  it('maps verdicts to tabs by index, in any order', async () => {
    const verdicts = [{ index: 1, verdict: 'off_task', reason: 'cats' }, { index: 0, verdict: 'on_task', reason: 'huf' }];
    const { client } = fakeApi(200, message(JSON.stringify({ verdicts })));
    expect(await judgeWithClaude('youtube.com', 'huf haus tours', tabs, client)).toEqual([
      { verdict: 'on_task', reason: 'huf' },
      { verdict: 'off_task', reason: 'cats' },
    ]);
  });

  it('throws when a tab has no verdict', async () => {
    const { client } = fakeApi(200, message(JSON.stringify({ verdicts: [{ index: 0, verdict: 'on_task', reason: 'a' }] })));
    await expect(judgeWithClaude('youtube.com', 'huf haus tours', tabs, client)).rejects.toThrow('no verdict for tab 1');
  });

  it('throws when the reply has no verdicts', async () => {
    const { client } = fakeApi(200, message(null, 'refusal'));
    await expect(judgeWithClaude('youtube.com', 'huf haus tours', tabs, client)).rejects.toThrow('no verdicts (stop_reason refusal)');
  });

  it('throws on a truncated or invalid reply', async () => {
    const truncated = fakeApi(200, message('{"verdicts": [{"index": 0', 'max_tokens'));
    await expect(judgeWithClaude('youtube.com', 'huf haus tours', tabs, truncated.client)).rejects.toThrow('Failed to parse structured output');
    const invalid = fakeApi(200, message(JSON.stringify({ verdicts: [{ index: 0, verdict: 'fine', reason: 'a' }] })));
    await expect(judgeWithClaude('youtube.com', 'huf haus tours', tabs, invalid.client)).rejects.toThrow('Failed to parse structured output');
  });

  it('names API errors', async () => {
    const cases: [number, string, string | RegExp][] = [
      [401, 'authentication_error', 'Anthropic API key rejected'],
      [429, 'rate_limit_error', 'Anthropic API rate limit'],
      [529, 'overloaded_error', /^Anthropic API error 529: /],
    ];
    for (const [status, type, expected] of cases) {
      const { client } = fakeApi(status, apiError(type));
      await expect(judgeWithClaude('youtube.com', 'huf haus tours', tabs, client)).rejects.toThrow(expected);
    }
  });
});
