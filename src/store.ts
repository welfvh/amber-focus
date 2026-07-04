/**
 * Persistent storage for Amber Focus (standalone, no Electron).
 * Uses a simple JSON file for persistence.
 *
 * Sole owner of application state: blocked domains, allowances,
 * delay sessions, hard lockouts, etc. The server reads from here
 * and tells the daemon what to enforce.
 */

import fs from 'fs';
import path from 'path';
import { normalizeDomain, matchesDomain } from './shared/domains.js';

const CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.config', 'amber-focus');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

interface Allowance {
  domain: string;
  expiresAt: number;
  reason: string;
  grantedMinutes: number;
}

interface DelaySession {
  domain: string;
  lastAccess: number;
  accessCount: number;
  lastResetDate: string;
}

interface HardLockout {
  domain: string;
  until: string; // ISO date string, e.g. "2026-03-01"
}

interface UserProfile {
  triggers: string[];
  pain: string;
  purpose: string;
  completedAt: string; // ISO timestamp
}

interface CooldownConfig {
  id: string;       // e.g. "twitter"
  domains: string;  // e.g. "twitter.com, x.com"
  duration: string; // e.g. "6h"
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
  blockedDomains: string[];
  delayedDomains: string[];
  blockedPaths: Record<string, string[]>; // { domain: [path patterns] }
  allowances: Allowance[];
  delaySessions: DelaySession[];
  hardLockouts: HardLockout[];
  enabledCategories: string[]; // which block categories are active
  profile: UserProfile | null;
  exceptions: string[];  // domains exempted during onboarding
  cooldowns: CooldownConfig[];
  onboardingComplete: boolean;
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

const DEFAULT_DELAYED: string[] = ['gmail.com', 'mail.google.com', 'are.na'];

const DEFAULTS: StoreSchema = {
  blockedDomains: domainsForCategories(DEFAULT_CATEGORIES),
  delayedDomains: DEFAULT_DELAYED,
  blockedPaths: {},
  allowances: [],
  delaySessions: [],
  hardLockouts: [],
  enabledCategories: DEFAULT_CATEGORIES,
  profile: null,
  exceptions: [],
  cooldowns: [],
  onboardingComplete: false,
  retreat: {
    enabled: false,
    endDate: '',
    windows: [],
    allowlist: [],
    blocklist: [],
  },
};

// In-memory cache
let data: StoreSchema = { ...DEFAULTS };

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function load(): void {
  ensureConfigDir();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      data = { ...DEFAULTS, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.error('Failed to load config:', e);
    data = { ...DEFAULTS };
  }
}

function save(): void {
  ensureConfigDir();
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

// Initialize on module load
load();

// Store-like interface
export const store = {
  get<K extends keyof StoreSchema>(key: K, defaultValue?: StoreSchema[K]): StoreSchema[K] {
    return data[key] ?? defaultValue ?? DEFAULTS[key];
  },
  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void {
    data[key] = value;
    save();
  },
};

// Exported functions

export function isDomainBlocked(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  const blocked = store.get('blockedDomains', []);
  const isInBlocklist = blocked.some(b => {
    const nb = normalizeDomain(b);
    return normalized === nb || normalized.endsWith('.' + nb);
  });
  if (!isInBlocklist) return false;

  const allowances = store.get('allowances', []);
  const now = Date.now();
  const hasAllowance = allowances.some(
    a => matchesDomain(normalized, a.domain) && a.expiresAt > now
  );
  return !hasAllowance;
}

export function grantAllowance(domain: string, minutes: number, reason: string): Allowance {
  const normalized = normalizeDomain(domain);
  const allowances = store.get('allowances', []);
  const filtered = allowances.filter(a => a.domain !== normalized);
  const allowance: Allowance = {
    domain: normalized,
    expiresAt: Date.now() + minutes * 60 * 1000,
    reason,
    grantedMinutes: minutes,
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

// Returns blocked domains minus those with active allowances (what should actually be in /etc/hosts)
export function getEffectivelyBlockedDomains(): string[] {
  const blocked = store.get('blockedDomains', []);
  const allowances = store.get('allowances', []);
  const now = Date.now();

  // Get domains with active allowances
  const allowedDomains = new Set(
    allowances
      .filter(a => a.expiresAt > now)
      .map(a => normalizeDomain(a.domain))
  );

  // Filter out allowed domains and their subdomains
  return blocked.filter(domain => {
    const normalized = normalizeDomain(domain);
    // Check if this domain or its parent has an allowance
    for (const allowed of allowedDomains) {
      if (normalized === allowed || normalized.endsWith('.' + allowed)) {
        return false;
      }
    }
    return true;
  });
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
  const allowances = store.get('allowances', []);
  const now = Date.now();
  const active = allowances.filter(a => a.expiresAt > now);
  if (active.length !== allowances.length) {
    store.set('allowances', active);
  }
  return active;
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

export function isDomainDelayed(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  const delayed = store.get('delayedDomains', []);
  return delayed.some(d => matchesDomain(normalized, d));
}

export function getDelaySeconds(domain: string): number {
  const normalized = normalizeDomain(domain);
  const sessions = store.get('delaySessions', []);
  const today = new Date().toISOString().split('T')[0];
  let session = sessions.find(s => s.domain === normalized);
  if (session && session.lastResetDate !== today) {
    session.accessCount = 0;
    session.lastResetDate = today;
  }
  const count = session?.accessCount || 0;
  return Math.min(10 * Math.pow(2, count), 160);
}

export function recordDelayAccess(domain: string): void {
  const normalized = normalizeDomain(domain);
  const sessions = store.get('delaySessions', []);
  const today = new Date().toISOString().split('T')[0];
  const now = Date.now();
  const existingIndex = sessions.findIndex(s => s.domain === normalized);

  if (existingIndex >= 0) {
    const session = sessions[existingIndex];
    if (session.lastResetDate !== today) {
      session.accessCount = 1;
      session.lastResetDate = today;
    } else {
      session.accessCount += 1;
    }
    session.lastAccess = now;
    sessions[existingIndex] = session;
  } else {
    sessions.push({
      domain: normalized,
      lastAccess: now,
      accessCount: 1,
      lastResetDate: today,
    });
  }
  store.set('delaySessions', sessions);
}

export function isInActiveSession(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  const sessions = store.get('delaySessions', []);
  const now = Date.now();
  const SESSION_DURATION = 15 * 60 * 1000;
  const session = sessions.find(s => s.domain === normalized);
  if (!session) return false;
  return (now - session.lastAccess) < SESSION_DURATION;
}

export function updateSessionAccess(domain: string): void {
  const normalized = normalizeDomain(domain);
  const sessions = store.get('delaySessions', []);
  const session = sessions.find(s => s.domain === normalized);
  if (session) {
    session.lastAccess = Date.now();
    store.set('delaySessions', sessions);
  }
}

export function getDelayedDomains(): string[] {
  return store.get('delayedDomains', []);
}

export function addDelayedDomain(domain: string): void {
  const normalized = normalizeDomain(domain);
  const delayed = store.get('delayedDomains', []);
  if (!delayed.includes(normalized)) {
    store.set('delayedDomains', [...delayed, normalized]);
  }
}

export function removeDelayedDomain(domain: string): void {
  const normalized = normalizeDomain(domain);
  const delayed = store.get('delayedDomains', []);
  store.set('delayedDomains', delayed.filter(d => d !== normalized));
}

// Path blocking functions

export function getBlockedPaths(): Record<string, string[]> {
  return store.get('blockedPaths', {});
}

export function addBlockedPath(domain: string, pathPattern: string): void {
  const normalized = normalizeDomain(domain);
  const paths = store.get('blockedPaths', {});
  if (!paths[normalized]) {
    paths[normalized] = [];
  }
  if (!paths[normalized].includes(pathPattern)) {
    paths[normalized].push(pathPattern);
  }
  store.set('blockedPaths', paths);
}

export function removeBlockedPath(domain: string, pathPattern: string): void {
  const normalized = normalizeDomain(domain);
  const paths = store.get('blockedPaths', {});
  if (paths[normalized]) {
    paths[normalized] = paths[normalized].filter((p: string) => p !== pathPattern);
    if (paths[normalized].length === 0) {
      delete paths[normalized];
    }
    store.set('blockedPaths', paths);
  }
}

// Hard lockout functions — config-driven domain locks with expiry dates.
// Replaces hardcoded LOCKED_DOMAINS in server.ts and mcp.ts.

export function getHardLockouts(): HardLockout[] {
  return store.get('hardLockouts', []);
}

export function addHardLockout(domain: string, until: string): void {
  const normalized = normalizeDomain(domain);
  const lockouts = store.get('hardLockouts', []);
  const filtered = lockouts.filter(l => normalizeDomain(l.domain) !== normalized);
  store.set('hardLockouts', [...filtered, { domain: normalized, until }]);
}

export function removeHardLockout(domain: string): void {
  const normalized = normalizeDomain(domain);
  const lockouts = store.get('hardLockouts', []);
  store.set('hardLockouts', lockouts.filter(l => normalizeDomain(l.domain) !== normalized));
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

/** Get enabled category names. */
export function getEnabledCategories(): string[] {
  return store.get('enabledCategories', DEFAULT_CATEGORIES);
}

// Setup / onboarding functions — used by the native macOS app during first run.

export function getProfile(): UserProfile | null {
  return store.get('profile', null);
}

export function setProfile(profile: UserProfile): void {
  store.set('profile', profile);
}

export function getExceptions(): string[] {
  return store.get('exceptions', []);
}

export function setExceptions(exceptions: string[]): void {
  store.set('exceptions', exceptions);
}

export function getCooldowns(): CooldownConfig[] {
  return store.get('cooldowns', []);
}

export function setCooldowns(cooldowns: CooldownConfig[]): void {
  store.set('cooldowns', cooldowns);
}

export function isOnboardingComplete(): boolean {
  return store.get('onboardingComplete', false);
}

export function setOnboardingComplete(complete: boolean): void {
  store.set('onboardingComplete', complete);
}

/** Configure enabled categories and rebuild the blocklist accordingly. */
export function setEnabledCategories(categories: string[], exceptions: string[] = []): void {
  store.set('enabledCategories', categories);
  store.set('exceptions', exceptions);

  // Rebuild blocklist from categories minus exceptions
  const domains = domainsForCategories(categories);
  const normalized = exceptions.map(e => normalizeDomain(e));
  const filtered = domains.filter(d => !normalized.includes(normalizeDomain(d)));
  store.set('blockedDomains', filtered);
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
