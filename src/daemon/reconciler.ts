/**
 * Reconciler — converges the OS to the desired state derived from config.json.
 *
 * Runs on a timer, on config changes, and on request. Every pass is idempotent:
 * it reads config.json and /etc/hosts, computes what the managed hosts section
 * must contain, rewrites it only when it differs, refreshes pf on change, and
 * applies the side effects of the diff between what was blocked before and
 * what is blocked now (kill connections to newly blocked domains, flush the
 * browser DNS cache for newly allowed ones). Browser tabs are the server's job:
 * it runs as the user, and root never drives a browser.
 *
 * The diff base is the state the last complete pass applied. A pass that fails
 * partway (after the hosts write, before pf or a side effect) leaves that base
 * as it was, so the next pass retries pf and the side effects. After a daemon
 * restart, the base is read back from the hosts file itself.
 *
 * Failure policy: on any error the pass stops, the OS keeps its current state
 * (blocked stays blocked), and `lastError` reports it.
 */

import { flushDnsCache } from './dns.js';
import type { SystemOperations } from './system.js';
import type { PfManager } from './pf.js';
import type { BrowserManager } from './browser.js';
import {
  DesiredConfigSchema,
  desiredStateFromConfig,
  activeAllowanceDomains,
  renderHostsSection,
  extractManagedSection,
  parseManagedDomains,
  sectionEquivalent,
  replaceManagedSection,
  diffDomains,
  buildHostsIndex,
  invalidConfigDomains,
  type DesiredState,
  type HostsIndex,
} from '../shared/reconcile.js';
import type { ReconcileStatus } from '../shared/ipc-types.js';

/** Above this many newly blocked domains (a category change), skip per-domain enforcement. */
const MAX_INDIVIDUAL_ENFORCE = 25;
/** Chromium needs a moment to respawn its network service after a DNS-cache kill. */
const BROWSER_DNS_SETTLE_MS = 500;

export interface ReconcilerDeps {
  sys: SystemOperations;
  pf: PfManager;
  browser: BrowserManager;
  log: (msg: string) => void;
  hostsPath?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class Reconciler {
  configPath: string | null = null;

  private readonly sys: SystemOperations;
  private readonly pf: PfManager;
  private readonly browser: BrowserManager;
  private readonly log: (msg: string) => void;
  private readonly hostsPath: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private chain: Promise<unknown> = Promise.resolve();
  private lastApplied: DesiredState | null = null;
  /** Index of the last hosts content seen; rebuilt only when the file changes. */
  private hostsIndex: { content: string; index: HostsIndex } | null = null;
  /** Invalid config entries last reported, so the log names each change once. */
  private lastInvalid = '';
  private status: ReconcileStatus = {
    configPath: null,
    shieldActive: false,
    domainsBlocked: 0,
    lastReconcileAt: null,
    lastChangeAt: null,
    lastReason: null,
    converged: false,
    lastError: null,
    legacyBlockedAllowed: [],
  };

  constructor(deps: ReconcilerDeps) {
    this.sys = deps.sys;
    this.pf = deps.pf;
    this.browser = deps.browser;
    this.log = deps.log;
    this.hostsPath = deps.hostsPath ?? '/etc/hosts';
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  }

  getStatus(): ReconcileStatus {
    return { ...this.status, configPath: this.configPath };
  }

  /** Run one pass. Passes are serialized; every caller gets a fresh pass. */
  tick(reason: string): Promise<ReconcileStatus> {
    const run = this.chain.then(() => this.pass(reason));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async pass(reason: string): Promise<ReconcileStatus> {
    const now = this.now();
    try {
      if (!this.configPath) throw new Error('config path unknown — no user logged in at the console');
      const raw = await this.sys.readFile(this.configPath);
      const parsed = DesiredConfigSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error(`config.json invalid: ${parsed.error.message}`);
      const cfg = parsed.data;
      const invalid = invalidConfigDomains(cfg);
      if (invalid.join(' ') !== this.lastInvalid) {
        this.lastInvalid = invalid.join(' ');
        if (invalid.length > 0) this.log(`ignoring ${invalid.length} invalid domain entries: ${JSON.stringify(invalid)}`);
      }
      const desired = desiredStateFromConfig(cfg, now);

      const before = await this.sys.readFile(this.hostsPath);
      const currentSection = extractManagedSection(before);
      const prevDomains = this.lastApplied ? this.lastApplied.blockedDomains : parseManagedDomains(before);
      const wantedSection = renderHostsSection(desired, new Date(now).toISOString());
      const hostsChanged = !sectionEquivalent(currentSection, wantedSection);

      if (hostsChanged) {
        await this.sys.writeFileAtomic(this.hostsPath, replaceManagedSection(before, wantedSection));
        await flushDnsCache(this.sys.exec.bind(this.sys), this.sys.execSilent.bind(this.sys));
        this.log(`hosts updated (${reason}): ${desired.blockedDomains.length} domains, shield=${desired.shieldActive}`);
      }

      // pf follows the last complete pass, not the hosts file: a failed pf
      // update after a hosts write is retried until it succeeds.
      if (hostsChanged || !this.lastApplied || !sameState(this.lastApplied, desired)) {
        await this.pf.updateStaticRules(desired.shieldActive);
        await this.pf.refreshDynamicRules(desired.blockedDomains, desired.shieldActive);
      }

      // Unknown previous state (fresh install, old section format, no complete
      // pass yet): converge hosts and pf only; no connection side effects to derive.
      const diff = prevDomains ? diffDomains(prevDomains, desired.blockedDomains) : { added: [], removed: [] };
      if (diff.added.length > 0) {
        if (diff.added.length <= MAX_INDIVIDUAL_ENFORCE) {
          for (const domain of diff.added) {
            const ips = await this.pf.blockDomain(domain);
            this.log(`enforced ${domain} (${ips.length} IPs)`);
          }
        }
        this.log(`newly blocked: ${diff.added.join(', ')}`);
      }
      if (diff.removed.length > 0) {
        await this.browser.flushBrowserDnsCache();
        await this.sleep(BROWSER_DNS_SETTLE_MS);
        this.log(`newly allowed: ${diff.removed.join(', ')}`);
      }

      const after = hostsChanged ? await this.sys.readFile(this.hostsPath) : before;
      const converged = sectionEquivalent(extractManagedSection(after), wantedSection);
      const allowed = activeAllowanceDomains(cfg, now);
      let legacyBlockedAllowed: string[] = [];
      if (allowed.length > 0) {
        if (!this.hostsIndex || this.hostsIndex.content !== after) {
          this.hostsIndex = { content: after, index: buildHostsIndex(after) };
        }
        const index = this.hostsIndex.index;
        legacyBlockedAllowed = allowed.filter(d => index.lookup(d) === 'legacy');
      }
      if (!converged) throw new Error('hosts verification failed after write');

      this.lastApplied = desired;
      this.status = {
        configPath: this.configPath,
        shieldActive: desired.shieldActive,
        domainsBlocked: desired.blockedDomains.length,
        lastReconcileAt: now,
        lastChangeAt: hostsChanged ? now : this.status.lastChangeAt,
        lastReason: reason,
        converged: true,
        lastError: null,
        legacyBlockedAllowed,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`reconcile failed (${reason}): ${message}`);
      this.status = {
        ...this.status,
        configPath: this.configPath,
        lastReconcileAt: now,
        lastReason: reason,
        converged: false,
        lastError: message,
      };
    }
    return this.getStatus();
  }
}

function sameState(a: DesiredState, b: DesiredState): boolean {
  return a.shieldActive === b.shieldActive && a.blockedDomains.join(' ') === b.blockedDomains.join(' ');
}
