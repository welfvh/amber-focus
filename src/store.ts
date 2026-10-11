/**
 * Persistent storage for Amber Focus (standalone, no Electron).
 * Uses a simple JSON file for persistence.
 *
 * Sole owner of application state: blocked domains, allowances, hard
 * lockouts, shield and retreat settings. The daemon and the retreat enforcer
 * read config.json directly. Keys this module no longer knows are kept as
 * they are on every save.
 */

import fs from 'fs';
import path from 'path';
import { normalizeDomain, matchesDomain } from './shared/domains.js';
import { effectiveBlockedDomains } from './shared/reconcile.js';

const CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.config', 'amber-focus');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface Allowance {
  domain: string;
  expiresAt: number;
  reason: string;
  grantedMinutes: number;
  /** Set when the grant runs under vigilant monitoring; lets a restarted server resume the session. */
  vigilantIntent?: string;
}

interface HardLockout {
  domain: string;
  until: string; // ISO date string, e.g. "2026-03-01"
}

interface RetreatWindow {
  start: number; // minutes from midnight, inclusive
  end: number;   // minutes from midnight, exclusive; if end < start, wraps midnight
}

interface RetreatConfig {
  enabled: boolean;
  endDate: string;       // ISO date "YYYY-MM-DD" — retreat auto-disables on this day
  windows: RetreatWindow[];
  allowlist: string[];   // bundle IDs of apps that survive (allowlist mode: kill everything else)
  blocklist: string[];   // bundle IDs to kill (blocklist mode: kill only these; takes priority when non-empty)
}

interface StoreSchema {
  /** Desired shield state. The daemon reads this from config.json and converges the OS to it. */
  shieldActive: boolean;
  blockedDomains: string[];
  allowances: Allowance[];
  hardLockouts: HardLockout[];
  retreat: RetreatConfig;
}

// Block categories — each is a named group of domains.
// Users select which categories to enable during install.
// Subdomain matching handles www/m/mobile variants automatically.
export const BLOCK_CATEGORIES: Record<string, string[]> = {

  // --- Social media: feeds, profiles, infinite scroll ---
  social: [
    // Global platforms
    'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'tiktok.com',
    'reddit.com', 'old.reddit.com', 'linkedin.com', 'discord.com',
    'threads.net', 'bsky.app', 'pinterest.com', 'tumblr.com', 'snapchat.com',
    'mastodon.social', 'mastodon.online', 'joinmastodon.org',
    'lemon8-app.com', 'truthsocial.com', 'gettr.com', 'parler.com',
    // Regional
    'vk.com', 'ok.ru',                           // Russia/CIS
    'weibo.com', 'xiaohongshu.com',               // China
    'naver.com', 'cafe.naver.com', 'band.us',     // South Korea
    'line.me',                                     // Japan/Taiwan/Thailand
    'taringa.net',                                 // Latin America
    // Forums & discussion
    'news.ycombinator.com', 'lobste.rs', 'slashdot.org',
    'quora.com', 'lemmy.world', 'lemmy.ml', 'kbin.social',
    '4chan.org', '4channel.org', '8kun.top',
    'neogaf.com', 'resetera.com', 'somethingawful.com',
    'polymarket.com',
  ],

  // --- Video & streaming: on-demand and live ---
  video: [
    'youtube.com', 'youtu.be', 'netflix.com', 'twitch.tv', 'kick.com',
    'dailymotion.com', 'vimeo.com', 'rumble.com', 'bitchute.com', 'odysee.com',
    'crunchyroll.com', 'funimation.com',
    'disneyplus.com', 'hulu.com', 'max.com', 'hbomax.com',
    'peacocktv.com', 'paramountplus.com', 'primevideo.com',
    'pluto.tv', 'tubi.tv',
    'nicovideo.jp',                                // Japan
    'bilibili.com', 'iqiyi.com', 'youku.com',     // China
  ],

  // --- News & media: scrolling, outrage, rabbit holes ---
  news: [
    // Aggregators & platforms
    'substack.com', 'medium.com', 'flipboard.com', 'digg.com',
    'msn.com', 'news.yahoo.com', 'news.google.com',
    // International
    'cnn.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'washingtonpost.com',
    'theguardian.com', 'foxnews.com', 'huffpost.com', 'vice.com', 'vox.com',
    'dailymail.co.uk', 'nypost.com', 'reuters.com', 'apnews.com',
    'aljazeera.com', 'rt.com',
    // German-language
    'bild.de', 'spiegel.de', 'zeit.de', 'faz.net', 'sueddeutsche.de',
    'welt.de', 'stern.de', 'focus.de', 'n-tv.de', 'tagesschau.de',
    't-online.de', 'web.de', 'gmx.net',
    'kicker.de', 'sport1.de', 'transfermarkt.de',
    // Austrian & Swiss
    'krone.at', 'orf.at', 'derstandard.at', 'kurier.at',
    '20min.ch', 'blick.ch', 'nzz.ch', 'watson.ch',
    // French, Spanish, Italian
    'lemonde.fr', 'lefigaro.fr', 'elpais.com', 'marca.com', 'as.com',
    'corriere.it', 'gazzetta.it',
    // Tech news (long-read rabbit holes)
    'techmeme.com', 'arstechnica.com', 'theverge.com', 'wired.com',
    'engadget.com', 'gizmodo.com', 'mashable.com', 'techcrunch.com',
    // Celebrity & gossip
    'tmz.com', 'buzzfeed.com', 'boredpanda.com', 'ranker.com',
    'people.com', 'popsugar.com',
  ],

  // --- Shopping: browsing, deals, impulse purchases ---
  shopping: [
    'amazon.com', 'amazon.de', 'amazon.co.uk',
    'ebay.com', 'ebay.de', 'kleinanzeigen.de',
    'temu.com', 'shein.com', 'aliexpress.com', 'wish.com',
    'etsy.com', 'otto.de', 'zalando.de', 'zalando.com',
    'asos.com', 'hm.com', 'zara.com', 'aboutyou.de',
    'idealo.de', 'galaxus.de', 'galaxus.ch',
    'mydealz.de', 'slickdeals.net', 'groupon.com',
    'taobao.com', 'jd.com', 'flipkart.com', 'mercadolibre.com',
  ],

  // --- Sports: scores, transfer news, compulsive checking ---
  sports: [
    'espn.com', 'goal.com', 'livescore.com', 'flashscore.com', 'sofascore.com',
    'skysports.com', 'bleacherreport.com', 'theathletic.com',
    'spox.com', 'ran.de', 'sport.de',
    'lequipe.fr',
  ],

  // --- Gaming: store browsing, news, browser games ---
  gaming: [
    'store.steampowered.com', 'epicgames.com',
    'ign.com', 'kotaku.com', 'polygon.com', 'gamespot.com', 'pcgamer.com',
    'eurogamer.net', 'roblox.com',
    'miniclip.com', 'crazygames.com', 'poki.com', 'newgrounds.com',
    'chess.com', 'lichess.org',
  ],

  // --- Memes & humor: viral content, image browsing ---
  memes: [
    '9gag.com', 'imgur.com', 'ifunny.co', 'memedroid.com',
    'knowyourmeme.com', 'funnyjunk.com', 'ebaumsworld.com',
    'cheezburger.com', 'thechive.com', 'cracked.com',
    'fandom.com', 'tvtropes.org',
  ],

  // --- Reading holes: fiction, manga, endless browsing ---
  reading: [
    'wattpad.com', 'royalroad.com', 'webnovel.com',
    'archiveofourown.org', 'fanfiction.net',
    'webtoons.com', 'tapas.io', 'mangadex.org',
    'mangakakalot.com', 'manganato.com', 'mangafire.to',
    'lezhin.com', 'tappytoon.com',
  ],

  // --- Dating: swiping, browsing profiles ---
  dating: [
    'tinder.com', 'bumble.com', 'hinge.co', 'match.com',
    'okcupid.com', 'badoo.com', 'grindr.com', 'lovoo.com', 'happn.com',
  ],

  // --- Gambling & betting ---
  gambling: [
    'bet365.com', 'draftkings.com', 'fanduel.com', 'bovada.lv',
    'pokerstars.com', 'betway.com', 'williamhill.com',
    'betfair.com', 'ladbrokes.com', 'paddypower.com', 'coral.co.uk',
    'betmgm.com', '888.com', 'unibet.com', 'bwin.com',
    'tipico.de', 'betsson.com', 'stake.com', 'caliente.mx',
  ],

  // --- Adult content (hardcoded list + bulk list in config) ---
  adult: [
    'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com',
    'youporn.com', 'tube8.com', 'spankbang.com', 'eporner.com', 'porntrex.com',
    'txxx.com', 'hqporner.com', 'beeg.com', 'porn.com', 'thumbzilla.com',
    'pornone.com', 'fuq.com', 'tnaflix.com', 'drtuber.com', 'porndig.com',
    'youjizz.com', 'motherless.com', 'heavy-r.com', 'efukt.com', 'ixxx.com',
    'hclips.com', 'pornhat.com', 'pornmd.com', 'nudevista.com', 'lobstertube.com',
    'freeones.com', 'cam4.com', 'chaturbate.com', 'bongacams.com', 'stripchat.com',
    'myfreecams.com', 'livejasmin.com', 'camsoda.com', 'flirt4free.com',
    'onlyfans.com', 'fansly.com', 'pornpics.com', 'imagefap.com', 'sex.com',
    'literotica.com', 'rule34.xxx', 'e621.net', 'gelbooru.com', 'nhentai.net',
    'hentaihaven.xxx', 'hanime.tv', 'fakku.net', 'tsumino.com', 'hitomi.la',
    '8muses.com', 'simpcity.su', 'coomer.su', 'kemono.su', 'fapello.com',
    'sxyprn.com', 'daftsex.com', 'javlibrary.com', 'missav.com',
  ],
};

// Default enabled categories for new installs.
// Everything distracting is on by default — user opts OUT of what they need.
const DEFAULT_CATEGORIES = [
  'social', 'video', 'news', 'sports',
  'gaming', 'memes', 'reading', 'dating', 'gambling', 'adult',
];

/** Merge selected category domains into a flat blocklist. */
export function domainsForCategories(categories: string[]): string[] {
  const all = new Set<string>();
  for (const cat of categories) {
    const domains = BLOCK_CATEGORIES[cat];
    if (domains) domains.forEach(d => all.add(d));
  }
  return [...all];
}

const DEFAULTS: StoreSchema = {
  shieldActive: true,
  blockedDomains: domainsForCategories(DEFAULT_CATEGORIES),
  allowances: [],
  hardLockouts: [],
  retreat: {
    enabled: false,
    endDate: '',
    windows: [],
    allowlist: [],
    blocklist: [],
  },
};

// In-memory cache. Null until config.json has been read: a file that cannot
// be read is retried on every store access and never overwritten.
let data: StoreSchema | null = null;

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function load(): StoreSchema {
  ensureConfigDir();
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`cannot read ${CONFIG_FILE} (${e instanceof Error ? e.message : e}); nothing is saved until it is readable`);
    }
    // First start: the daemon converges from this file and applies nothing without it.
    const defaults = { ...DEFAULTS };
    save(defaults);
    console.log(`No config.json: wrote the defaults to ${CONFIG_FILE}`);
    return defaults;
  }
  try {
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) {
    // Keep the unreadable file before the next save replaces it with defaults.
    const copy = `${CONFIG_FILE}.corrupt-${Date.now()}`;
    fs.copyFileSync(CONFIG_FILE, copy);
    console.error(`config.json is not valid JSON (${e instanceof Error ? e.message : e}); saved a copy to ${copy} and started from defaults`);
    return { ...DEFAULTS };
  }
}

/** The config in memory, read on first use. A failed read throws; the next access tries again. */
function current(): StoreSchema {
  data ??= load();
  return data;
}

/**
 * Write-then-rename: the daemon polls this file and must never see a
 * half-written one. Throws on failure: the daemon converges from this file,
 * so a change that is not on disk has not happened.
 */
function save(next: StoreSchema): void {
  ensureConfigDir();
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

// Read on module load. An unreadable file must not stop the server: report it
// here; every store access retries and throws until the file is readable.
try {
  current();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
}

// Store-like interface
export const store = {
  get<K extends keyof StoreSchema>(key: K, defaultValue?: StoreSchema[K]): StoreSchema[K] {
    return current()[key] ?? defaultValue ?? DEFAULTS[key];
  },
  /** Persist first, then update memory: a failed write throws and changes nothing. */
  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void {
    const next = { ...current() };
    next[key] = value;
    save(next);
    data = next;
  },
};

// Exported functions

/** True when the domain (or a parent of it) is on the blocklist, allowances aside. */
export function isOnBlocklist(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  return store.get('blockedDomains', []).some(b => matchesDomain(normalized, b));
}

/** Desired state for one domain: covered by an entry of the effective blocklist (the daemon's view). */
export function isDomainBlocked(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  const effective = effectiveBlockedDomains(store.get('blockedDomains', []), store.get('allowances', []), Date.now());
  return effective.some(b => matchesDomain(normalized, b));
}

/**
 * The blocklist entry that blocks `domain` as one of its subdomains, if any.
 * A grant cannot open such a domain: the parent's block covers it.
 */
export function blockingParent(domain: string): string | null {
  const normalized = normalizeDomain(domain);
  return store.get('blockedDomains', [])
    .map(normalizeDomain)
    .find(b => normalized.endsWith('.' + b)) ?? null;
}

export function grantAllowance(
  domain: string,
  minutes: number,
  reason: string,
  vigilantIntent?: string,
): Allowance {
  const normalized = normalizeDomain(domain);
  const allowances = store.get('allowances', []);
  const filtered = allowances.filter(a => a.domain !== normalized);
  const allowance: Allowance = {
    domain: normalized,
    expiresAt: Date.now() + minutes * 60 * 1000,
    reason,
    grantedMinutes: minutes,
    ...(vigilantIntent ? { vigilantIntent } : {}),
  };
  store.set('allowances', [...filtered, allowance]);
  return allowance;
}

export function revokeAllowance(domain: string): void {
  const normalized = normalizeDomain(domain);
  const allowances = store.get('allowances', []);
  store.set('allowances', allowances.filter(a => a.domain !== normalized));
}

export function getBlockedDomains(): string[] {
  return store.get('blockedDomains', []);
}

/** Blocked domains minus those covered by an active allowance — what the daemon converges to. */
export function getEffectivelyBlockedDomains(): string[] {
  return effectiveBlockedDomains(store.get('blockedDomains', []), store.get('allowances', []), Date.now());
}

export function isShieldActive(): boolean {
  return store.get('shieldActive', true);
}

export function setShieldActive(active: boolean): void {
  store.set('shieldActive', active);
}

export function addBlockedDomain(domain: string): void {
  const normalized = normalizeDomain(domain);
  const blocked = store.get('blockedDomains', []);
  if (!blocked.includes(normalized)) {
    store.set('blockedDomains', [...blocked, normalized]);
  }
}

export function removeBlockedDomain(domain: string): void {
  const normalized = normalizeDomain(domain);
  const blocked = store.get('blockedDomains', []);
  store.set('blockedDomains', blocked.filter(d => d !== normalized));
}

export function getActiveAllowances(): Allowance[] {
  const now = Date.now();
  return store.get('allowances', []).filter(a => a.expiresAt > now);
}

/** Drop expired allowances from the store. Returns the ones that expired. */
export function pruneExpiredAllowances(): Allowance[] {
  const allowances = store.get('allowances', []);
  const now = Date.now();
  const expired = allowances.filter(a => a.expiresAt <= now);
  if (expired.length > 0) {
    store.set('allowances', allowances.filter(a => a.expiresAt > now));
  }
  return expired;
}

export function getAllowanceRemaining(domain: string): number {
  const normalized = normalizeDomain(domain);
  const allowances = store.get('allowances', []);
  const now = Date.now();
  const allowance = allowances.find(
    a => matchesDomain(normalized, a.domain) && a.expiresAt > now
  );
  if (!allowance) return 0;
  return Math.ceil((allowance.expiresAt - now) / 60000);
}

// Hard lockout functions — config-driven domain locks with expiry dates.

export function getHardLockouts(): HardLockout[] {
  return store.get('hardLockouts', []);
}

export function addHardLockout(domain: string, until: string): void {
  const normalized = normalizeDomain(domain);
  const lockouts = store.get('hardLockouts', []);
  const filtered = lockouts.filter(l => normalizeDomain(l.domain) !== normalized);
  store.set('hardLockouts', [...filtered, { domain: normalized, until }]);
}

/** Check if a domain is hard-locked (locked and lockout period hasn't expired). */
export function isHardLocked(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  const lockouts = store.get('hardLockouts', []);
  const now = new Date();
  return lockouts.some(l => {
    const lockDomain = normalizeDomain(l.domain);
    const matches = normalized === lockDomain || normalized.endsWith('.' + lockDomain);
    if (!matches) return false;
    return now < new Date(l.until);
  });
}

/**
 * The active lockout a grant for `domain` would touch: one on the domain or a
 * parent of it, or one on a subdomain the grant would also open
 * (a grant for google.com covers a locked news.google.com).
 */
export function lockoutCoveredBy(domain: string): HardLockout | null {
  const normalized = normalizeDomain(domain);
  const now = new Date();
  return store.get('hardLockouts', []).find(l => {
    const lockDomain = normalizeDomain(l.domain);
    const overlaps = matchesDomain(normalized, lockDomain) || matchesDomain(lockDomain, normalized);
    return overlaps && now < new Date(l.until);
  }) ?? null;
}

/** Get the lockout expiry date for a domain, or null if not locked. */
export function getHardLockoutUntil(domain: string): string | null {
  const normalized = normalizeDomain(domain);
  const lockouts = store.get('hardLockouts', []);
  const now = new Date();
  const lockout = lockouts.find(l => {
    const lockDomain = normalizeDomain(l.domain);
    const matches = normalized === lockDomain || normalized.endsWith('.' + lockDomain);
    return matches && now < new Date(l.until);
  });
  return lockout?.until ?? null;
}

/** Get all currently active hard lockouts (not expired). */
export function getActiveHardLockouts(): HardLockout[] {
  const lockouts = store.get('hardLockouts', []);
  const now = new Date();
  return lockouts.filter(l => now < new Date(l.until));
}

// Retreat mode — Mac app allowlist enforced during scheduled windows.
// The retreat-enforcer Swift daemon reads this directly from config.json.

export function getRetreat(): RetreatConfig {
  return store.get('retreat', DEFAULTS.retreat);
}

export function setRetreat(cfg: RetreatConfig): void {
  store.set('retreat', cfg);
}

export function disableRetreat(): void {
  const cur = getRetreat();
  store.set('retreat', { ...cur, enabled: false });
}
