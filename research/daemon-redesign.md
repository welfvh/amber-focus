# Daemon Architecture Redesign

Research report for cc-focus daemon (`daemon/daemon.cjs`) rewrite.
Compiled 2026-02-12.

---

## Table of Contents

1. [Current State Summary](#1-current-state-summary)
2. [State Architecture](#2-state-architecture)
3. [Async Operations](#3-async-operations)
4. [TypeScript Rewrite](#4-typescript-rewrite)
5. [IPC Protocol](#5-ipc-protocol)
6. [Process Supervision & Crash Recovery](#6-process-supervision--crash-recovery)
7. [Testing Strategy](#7-testing-strategy)
8. [Minimal Privilege](#8-minimal-privilege)
9. [Proposed New Structure](#9-proposed-new-structure)
10. [Migration Plan](#10-migration-plan)

---

## 1. Current State Summary

### What the daemon does

The daemon (`daemon/daemon.cjs`, 636 lines) is a root-privileged HTTP server on a Unix socket (`/tmp/focusshield.sock`). It handles:

- `/etc/hosts` management (read/write with marker-delimited block sections)
- Static pf firewall rules (hardcoded IP ranges for Twitter, Meta, TikTok, Netflix)
- Dynamic pf rules (DNS resolution via `dig` for ~30 priority domains)
- DNS cache flushing (`dscacheutil`, `mDNSResponder`)
- Connection killing (`pfctl -k`)
- Browser tab closing (AppleScript for Safari, Arc, Chrome)
- Allowance tracking (timed grants with 30s expiry check interval)

### Identified problems

| Problem | Impact | Severity |
|---------|--------|----------|
| Dual state (server config.json + daemon state.json) | Race conditions between server and daemon allowance trackers | High |
| `execSync` everywhere (dig, pfctl, osascript) | HTTP handler blocks for 5+ seconds during `refreshDynamicPfRules()` | High |
| CJS in a TypeScript project | Only .cjs file; no types, no IDE support, no shared code | Medium |
| Raw HTTP over Unix socket, no validation | No typed messages, no error codes, silent failures | Medium |
| Zero test coverage | Cannot verify behavior, regressions go unnoticed | Medium |
| Domain variant expansion duplicated | `collectAllDomainsWithVariants()` exists in daemon; similar logic in server's store | Low |

---

## 2. State Architecture

### Current: Dual state with sync

```
Server (user)                    Daemon (root)
~/.config/cc-focus/config.json   /Library/Application Support/FocusShield/state.json
├── blockedDomains               ├── blockedDomains (synced via POST /blocklist)
├── allowances                   ├── allowances (synced via POST /grant)
├── delayedDomains               ├── shieldActive
├── hardLockouts                 └── lastUpdated
├── delaySessions
└── enabledCategories
```

Both processes track allowances independently. Both run 30s expiry checkers. The server calls `enableBlocking()` on expiry AND the daemon runs `checkAllowanceExpiry()` on its own — they can fire at different times, causing double operations or missed expirations if one is slightly ahead.

### Option A: Stateless daemon (recommended)

The server is the sole source of truth. The daemon stores nothing. On every state change, the server pushes the full desired state to the daemon.

**How it works:**
- Server sends `POST /apply` with the complete desired state: `{ blockedDomains: [...], allowances: [...], shieldActive: true }`
- Daemon computes the diff from current system state and applies changes
- Daemon has NO persistent state file — it derives everything from system state on startup
- Allowance expiry is tracked ONLY by the server. When an allowance expires, the server sends a new `/apply` with the domain removed from allowances

**Advantages:**
- No state sync bugs — one source of truth
- Daemon can crash and restart without losing state (server re-pushes on reconnect)
- Daemon becomes a pure "system state actuator" — simpler, more testable
- Server already has all the state management code (store.ts is 436 lines of well-typed state management)

**Disadvantages:**
- If the server is down, the daemon can't independently track expiry (mitigation: daemon reads system state on startup and maintains blocking — it just can't grant/revoke without the server)
- Larger IPC payloads (full blocklist on every change — 75K+ domains)

**Mitigation for large payloads:** The server already sends the full blocklist via `POST /blocklist`. At 75K domains averaging ~15 chars each, that's ~1.1MB of JSON. Over a Unix socket, this transfers in <10ms. Not a concern.

**Mitigation for server downtime:** The daemon should have a "last known good" state that it applies on startup if the server hasn't pushed within N seconds. This is just the system state itself — if `/etc/hosts` has blocks and pf rules are loaded, the daemon doesn't need to do anything. Blocking persists at the OS level regardless of daemon state.

### Option B: Daemon as source of truth

The daemon owns all state. The server queries the daemon for everything.

**Why this is worse:** The server needs rich state for MCP tools, delay sessions, hard lockouts, path blocking, categories — none of which the daemon cares about. Making the daemon store all this puts user-facing concerns in a root process. The principle of least privilege says the root process should only know what it needs.

### Option C: Shared SQLite with WAL mode

Both processes read/write a shared SQLite database using `better-sqlite3` in WAL mode.

**How WAL helps:** WAL (Write-Ahead Logging) allows concurrent readers and a single writer without blocking. One process can read while the other writes. This eliminates the need for explicit IPC for state queries.

**Why this is overkill:** The state is small (a few KB of JSON), changes are infrequent (a few times per hour), and the processes already communicate via IPC. Adding SQLite introduces a native dependency (`better-sqlite3` requires compilation), schema management, and migration logic — all for a problem that Option A solves more simply.

**When SQLite would make sense:** If cc-focus grew to track historical data (grant history, usage patterns, audit logs), SQLite would be the right backing store. For current needs, it's not justified.

### How SelfControl handles state

SelfControl uses a root-owned plist at `/usr/local/etc/.<sha1hash>.plist`. The daemon (root) writes it; the app (user) reads it. Cross-process sync uses `NSDistributedNotificationCenter` for real-time updates, plus periodic disk sync every 30 seconds.

This is effectively Option B — daemon as source of truth — but SelfControl's daemon has much simpler state (just block end time + blocklist). It doesn't manage config, delays, categories, or MCP tools.

### Recommendation: Option A (stateless daemon)

The daemon should be a pure actuator:

```typescript
// The only "state" the daemon has is what it reads from the OS
interface SystemState {
  hostsBlocked: string[];     // parsed from /etc/hosts markers
  pfRulesLoaded: boolean;     // pfctl -sr check
  pfAnchorRules: string;      // current anchor content
}

// The server tells the daemon what the system should look like
interface DesiredState {
  blockedDomains: string[];   // domains to block in /etc/hosts
  pfEnabled: boolean;         // whether pf rules should be active
  priorityDomains: string[];  // domains needing IP-level pf blocking
}
```

---

## 3. Async Operations

### Current: Everything is `execSync`

The daemon uses `execSync` for all external operations:

| Operation | Current | Blocking time | Frequency |
|-----------|---------|--------------|-----------|
| `dig +short domain @8.8.8.8` | `execSync` | ~100ms each, ~5s for 50 domains | Every `refreshBlocking()` call |
| `pfctl -f /etc/pf.conf` | `execSync` | ~50ms | Every rule change |
| `pfctl -k 0.0.0.0/0 -k <IP>` | `execSync` | ~20ms each | Per-IP on block enforcement |
| `osascript -e '...'` | `execSync` | ~200-500ms per browser | On grant expiry / revoke |
| `dscacheutil -flushcache` | `execSync` | ~50ms | Every state change |
| `killall -HUP mDNSResponder` | `execSync` | ~50ms | Every state change |

The worst case is `refreshDynamicPfRules()`: 50 sequential `dig` calls = ~5 seconds of total blocking. During this time, the Unix socket HTTP server cannot process any requests.

### Replacement plan

**DNS resolution: Replace `dig` with `dns.resolve()`**

Node.js has built-in async DNS resolution via `dns.promises.resolve()`. No subprocess needed.

```typescript
import dns from 'dns/promises';

async function resolveDomainIPs(domain: string): Promise<string[]> {
  try {
    // Use external DNS server to avoid hitting our own /etc/hosts block
    const resolver = new dns.Resolver();
    resolver.setServers(['8.8.8.8', '1.1.1.1']);
    const addresses = await resolver.resolve4(domain);
    return addresses;
  } catch {
    return [];
  }
}
```

For bulk resolution, use `Promise.allSettled()` to resolve all priority domains in parallel:

```typescript
async function resolveAllPriorityDomains(domains: string[]): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>();
  const tasks = domains.map(async (domain) => {
    const ips = await resolveDomainIPs(domain);
    results.set(domain, ips);
  });
  await Promise.allSettled(tasks);
  return results;
}
```

This turns 5 seconds of sequential `dig` into ~200ms of parallel DNS resolution. The Node.js DNS resolver uses the system's c-ares library — no subprocess spawning.

**Note on `dns.Resolver.setServers()`**: Critical that we use an external DNS server (8.8.8.8), not the system resolver. If we use the system resolver, it reads `/etc/hosts` — which has our blocks — and returns 0.0.0.0 for blocked domains. We need the real IPs for pf rules.

**System commands: Replace `execSync` with `execFile` (async)**

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function reloadPf(): Promise<void> {
  await execFileAsync('/sbin/pfctl', ['-f', '/etc/pf.conf']);
}

async function killConnections(ip: string): Promise<void> {
  await execFileAsync('/sbin/pfctl', ['-k', '0.0.0.0/0', '-k', ip]);
}

async function flushDns(): Promise<void> {
  await Promise.all([
    execFileAsync('/usr/bin/dscacheutil', ['-flushcache']),
    execFileAsync('/usr/bin/killall', ['-HUP', 'mDNSResponder']),
  ]);
}
```

Using `execFile` instead of `exec`/`execSync` also avoids shell injection (no shell interpolation of arguments).

**AppleScript: Use `execFile` async with JXA**

AppleScript via `osascript` is the slowest operation (~200-500ms per browser). Two improvements:

1. Run browser tab closing in parallel across browsers (not sequentially)
2. Use JXA (JavaScript for Automation) instead of AppleScript for easier string handling

```typescript
async function closeBrowserTabs(domain: string): Promise<void> {
  const browsers = [
    { name: 'Safari', script: safariCloseScript(domain) },
    { name: 'Arc', script: arcCloseScript(domain) },
    { name: 'Google Chrome', script: chromeCloseScript(domain) },
  ];

  // Close tabs in all browsers simultaneously
  await Promise.allSettled(
    browsers.map(({ script }) =>
      execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script])
        .catch(() => {}) // Ignore errors (browser not running, etc.)
    )
  );
}

function safariCloseScript(domain: string): string {
  // JXA — safer string handling than AppleScript
  return `
    const safari = Application("Safari");
    try {
      safari.windows().forEach(w => {
        w.tabs().forEach(t => {
          if (t.url().includes("${domain}")) t.close();
        });
      });
    } catch(e) {}
  `;
}
```

### Operation ordering with an async queue

Some operations must happen in order (update pf rules THEN kill connections). Others can be parallel (flush DNS AND close tabs simultaneously).

A simple operation queue pattern:

```typescript
type Operation = () => Promise<void>;

class OperationQueue {
  private queue: Operation[] = [];
  private running = false;

  async enqueue(op: Operation): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await op();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      if (!this.running) this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const op = this.queue.shift()!;
      await op();
    }
    this.running = false;
  }
}

// Usage: ensures pf operations are serialized
const pfQueue = new OperationQueue();

async function enforceBlock(domain: string): Promise<void> {
  await pfQueue.enqueue(async () => {
    // These must be sequential: write rules → reload → kill connections
    await writeDynamicPfRules(domain);
    await reloadPf();
    const ips = await resolveDomainIPs(domain);
    for (const ip of ips) {
      await killConnections(ip);
    }
  });

  // These can happen in parallel with pf, and with each other
  await Promise.all([
    flushDns(),
    closeBrowserTabs(domain),
  ]);
}
```

This prevents two concurrent `/grant` or `/revoke` requests from interleaving pf rule writes, while still allowing DNS flush and tab closing to happen in parallel.

---

## 4. TypeScript Rewrite

### The problem

The daemon is the only `.cjs` file in a TypeScript project. It can't import from `src/` (different module system), can't share types, and doesn't get IDE support. The server and daemon independently define domain variant logic, blocking concepts, and state structures.

### Options for running TypeScript as a LaunchDaemon

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **tsc → node dist/daemon.js** | Same as current server build, consistent | Needs `node_modules` at runtime (Express in server, but daemon has no deps beyond Node built-ins) | Good if daemon stays dependency-free |
| **esbuild → single CJS bundle** | Zero runtime deps, single file, fast build | Adds build step, CJS output (but that's fine for Node) | **Recommended** |
| **tsx at runtime** | Zero build step, instant TypeScript | Adds `tsx` as runtime dependency in root process, slower startup | Bad for daemon |
| **Bun** | Native TS, fast startup, single binary | Different runtime (compatibility risk), not proven for root daemons | Risky |

### Recommendation: esbuild to single file

Bundle the daemon TypeScript source to a single `.cjs` file with esbuild. The daemon has zero npm dependencies (only Node built-ins: `http`, `fs`, `child_process`, `dns`, `path`), so the bundle is just our code — small and self-contained.

```bash
# Build command
npx esbuild src/daemon/index.ts \
  --bundle \
  --platform=node \
  --target=node18 \
  --format=cjs \
  --outfile=daemon/daemon.cjs
```

Add to package.json scripts:

```json
{
  "scripts": {
    "build": "tsc && npm run build:daemon",
    "build:daemon": "esbuild src/daemon/index.ts --bundle --platform=node --target=node18 --format=cjs --outfile=daemon/daemon.cjs"
  }
}
```

The LaunchDaemon plist still points to `daemon/daemon.cjs` — no change to the deployment path. But the source lives in `src/daemon/` as TypeScript, with full type checking and shared types.

### Source file structure

```
src/
  daemon/
    index.ts          # Entry point: create server, load state, start
    hosts.ts          # /etc/hosts read/write with markers
    pf.ts             # pf anchor management, pfctl operations
    dns.ts            # Async DNS resolution via dns.Resolver
    browser.ts        # Browser tab closing (JXA/AppleScript)
    types.ts          # Shared types (DesiredState, SystemState, IPC messages)
    queue.ts          # Operation queue for serializing pf operations
  server.ts           # (existing)
  store.ts            # (existing)
  blocker.ts          # (existing, becomes IPC client)
  shared/
    domains.ts        # Domain normalization, variant expansion (shared between daemon and server)
    types.ts          # Shared IPC message types
```

### Shared code between server and daemon

The domain variant expansion logic (`collectAllDomainsWithVariants`, `normalizeDomain`) should live in `src/shared/domains.ts` and be imported by both the server and daemon source. esbuild will bundle it into the daemon output; tsc will include it in the server output.

### Root-owned paths and permissions

The daemon runs as root. The TypeScript source and built output live in the project directory, which is user-owned. This is fine — launchd runs the specified binary as root regardless of file ownership. The plist just needs to point to the right path.

The only root-owned artifacts are:
- `/Library/LaunchDaemons/com.focusshield.daemon.plist` (installed by `install.sh` with `sudo cp`)
- `/Library/Application Support/FocusShield/` (state, removed in new design)
- `/etc/hosts`, `/etc/pf.conf`, `/etc/pf.anchors/` (system files the daemon modifies)
- `/var/log/cc-focus-daemon.log` (log file)
- `/tmp/focusshield.sock` (Unix socket, chmod 666 for user access)

None of these are affected by using TypeScript source.

---

## 5. IPC Protocol

### Current: Raw HTTP over Unix socket

The daemon is a `http.createServer()` listening on `/tmp/focusshield.sock`. Endpoints:

```
GET  /status
POST /hosts
POST /pf         { rules }
POST /blocklist  { domains }
POST /grant      { domain, minutes, reason }
POST /revoke     { domain }
POST /enforce-block { domain }
POST /enable
POST /disable
POST /flush-dns
POST /clear
```

No request validation. No typed responses. No error codes beyond HTTP status. No versioning.

### Evaluated options

| Option | Type safety | Dependencies | Complexity | Bidirectional | Verdict |
|--------|------------|-------------|-----------|--------------|---------|
| **Typed JSON-RPC 2.0 over Unix socket** | Good (with zod) | None (implement ourselves) | Low | No (request-response only) | **Recommended** |
| **gRPC over Unix socket** | Excellent (protobuf) | Heavy (@grpc/grpc-js, protobuf) | High | Yes | Overkill |
| **tRPC** | Excellent | Medium (tRPC + adapter) | Medium | No | Would work, but adds framework |
| **Custom typed HTTP (current + zod)** | Good | None | Low | No | Viable, minimal change |
| **XPC (Apple native)** | N/A | Requires Swift/ObjC | High | Yes | Wrong language ecosystem |
| **D-Bus** | N/A | Not native on macOS | N/A | Yes | Non-starter |

### Recommendation: JSON-RPC 2.0 with zod schemas

JSON-RPC 2.0 is a lightweight, well-specified RPC protocol. It defines request/response format, error codes, and batch calls. Combined with zod (already a project dependency), we get typed IPC with zero new dependencies.

**Why JSON-RPC over custom HTTP endpoints:**
- Standard protocol — any JSON-RPC client can talk to the daemon
- Structured error codes (not just HTTP status)
- Method names are explicit (not overloaded URL paths)
- Batch requests supported (apply multiple changes atomically)
- The protocol is simple enough to implement in ~50 lines

**Implementation:**

```typescript
// src/shared/ipc.ts — shared between server and daemon

import { z } from 'zod';

// JSON-RPC 2.0 envelope
const JsonRpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
  id: z.union([z.string(), z.number()]),
});

// Method definitions — daemon side validates, server side constructs
export const DaemonMethods = {
  'apply': z.object({
    blockedDomains: z.array(z.string()),
    shieldActive: z.boolean(),
    priorityDomains: z.array(z.string()).optional(),
  }),

  'grant': z.object({
    domain: z.string(),
    minutes: z.number(),
  }),

  'revoke': z.object({
    domain: z.string(),
  }),

  'enforce': z.object({
    domain: z.string(),
  }),

  'status': z.object({}),

  'flush_dns': z.object({}),
} as const;

export type DaemonMethod = keyof typeof DaemonMethods;

// Response types
export interface DaemonStatus {
  running: true;
  pid: number;
  shieldActive: boolean;
  hostsBlockedCount: number;
  pfEnabled: boolean;
  uptime: number;
}

// Error codes (JSON-RPC standard + custom)
export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom
  PF_RELOAD_FAILED: -32001,
  HOSTS_WRITE_FAILED: -32002,
  DNS_FLUSH_FAILED: -32003,
} as const;
```

**Daemon-side handler:**

```typescript
// src/daemon/server.ts

async function handleRpcRequest(raw: unknown): Promise<JsonRpcResponse> {
  const parsed = JsonRpcRequest.safeParse(raw);
  if (!parsed.success) {
    return { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null };
  }

  const { method, params, id } = parsed.data;
  const schema = DaemonMethods[method as DaemonMethod];
  if (!schema) {
    return { jsonrpc: '2.0', error: { code: -32601, message: `Unknown method: ${method}` }, id };
  }

  const validated = schema.safeParse(params);
  if (!validated.success) {
    return {
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Invalid params', data: validated.error.issues },
      id,
    };
  }

  try {
    const result = await dispatch(method as DaemonMethod, validated.data);
    return { jsonrpc: '2.0', result, id };
  } catch (e) {
    return {
      jsonrpc: '2.0',
      error: { code: -32603, message: (e as Error).message },
      id,
    };
  }
}
```

**Server-side client (replaces `blocker.ts` `daemonRequest()`):**

```typescript
// src/daemon-client.ts

import { DaemonMethods, DaemonMethod, ErrorCodes } from './shared/ipc';

let requestId = 0;

async function rpc<M extends DaemonMethod>(
  method: M,
  params: z.infer<typeof DaemonMethods[M]>
): Promise<unknown> {
  const id = ++requestId;
  const request = { jsonrpc: '2.0', method, params, id };

  // Send over Unix socket (same as current daemonRequest, but simpler)
  const response = await sendToSocket(DAEMON_SOCKET, JSON.stringify(request));
  const parsed = JSON.parse(response);

  if (parsed.error) {
    throw new DaemonError(parsed.error.code, parsed.error.message, parsed.error.data);
  }

  return parsed.result;
}

// Typed wrapper functions
export async function applyState(state: ApplyParams): Promise<void> {
  await rpc('apply', state);
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  return await rpc('status', {}) as DaemonStatus;
}
```

### What about bidirectional communication?

The current architecture is purely request-response: server talks to daemon, daemon responds. The daemon never initiates communication to the server.

If we wanted daemon-initiated events (e.g., "allowance expired, notifying server"), we could:
- Use JSON-RPC 2.0 notifications (no `id` field, one-way)
- Have the daemon connect to the server's HTTP port
- Use a second Unix socket in the reverse direction

For now, this isn't needed. The server polls daemon status and manages its own expiry timer. If we move to Option A (stateless daemon), expiry is entirely server-side, so there's nothing the daemon needs to tell the server proactively.

---

## 6. Process Supervision & Crash Recovery

### Current supervision

The daemon runs as a LaunchDaemon with `KeepAlive: true`. If it crashes, launchd restarts it. On restart, it:

1. Loads state from `/Library/Application Support/FocusShield/state.json`
2. If `shieldActive && blockedDomains.length > 0`, calls `refreshBlocking()` — writes hosts, generates pf rules, resolves IPs

This is mostly correct but has gaps.

### Gap 1: Crash during pf rule write

If the daemon crashes between writing `/etc/pf.anchors/com.welf.focusshield.dynamic` and running `pfctl -f /etc/pf.conf`:
- The anchor file has new content but pf hasn't loaded it
- Blocking is partially applied

**Fix:** Startup reconciliation should always reload pf rules, not just when state says "active":

```typescript
async function reconcileOnStartup(): Promise<void> {
  // Always check what pf thinks is loaded
  const pfLoaded = await isPfEnabled();
  const hostsHaveBlocks = await hostsHaveMarkers();

  if (pfLoaded || hostsHaveBlocks) {
    // System has blocking artifacts — ensure they're consistent
    log('Reconciling system state on startup...');
    await reloadPf();
  }
}
```

### Gap 2: Crash during /etc/hosts write

If the daemon crashes mid-write of `/etc/hosts`, the file could be truncated or corrupted. This would break ALL DNS resolution on the system, not just blocked domains.

**Fix:** Atomic file writes. Write to a temp file, then rename:

```typescript
async function writeHostsFile(content: string): Promise<void> {
  const tmpPath = '/etc/hosts.ccfocus.tmp';
  await fs.promises.writeFile(tmpPath, content);
  await fs.promises.rename(tmpPath, '/etc/hosts');
}
```

`rename()` is atomic on most filesystems (HFS+, APFS). If the daemon crashes after `writeFile` but before `rename`, the original `/etc/hosts` is untouched.

### Gap 3: Orphaned pf rules after uninstall/upgrade

If cc-focus is uninstalled or the daemon is removed, pf rules and hosts entries persist. There's no cleanup.

**Fix:** The `uninstall.sh` script already handles this (it clears hosts markers and pf anchors). But the daemon should also have a graceful shutdown handler:

```typescript
process.on('SIGTERM', async () => {
  log('Shutting down...');
  // Do NOT clear blocking on shutdown — that would let sites through on daemon restart
  // Just clean up the socket
  server.close();
  try { await fs.promises.unlink(SOCKET_PATH); } catch {}
  process.exit(0);
});
```

The current daemon already does this correctly. Blocking state should persist across daemon restarts — the whole point is that blocking survives process death. Only explicit `/disable` or `/clear` should remove blocks.

### Gap 4: pf state inconsistency after reboot

macOS loads `/etc/pf.conf` on boot but does NOT automatically enable pf. The daemon needs to:

1. Check if pf is enabled (`pfctl -s info`)
2. If not, enable it (`pfctl -e`)
3. Reload rules (`pfctl -f /etc/pf.conf`)

Current daemon does step 3 but not steps 1-2. If `enable-pf.sh` wasn't run, pf blocking silently doesn't work.

**Fix:** Add to startup reconciliation:

```typescript
async function ensurePfEnabled(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('/sbin/pfctl', ['-s', 'info']);
    if (stdout.includes('Status: Disabled')) {
      await execFileAsync('/sbin/pfctl', ['-e']);
      log('pf enabled');
    }
  } catch {
    log('Could not check/enable pf');
  }
}
```

### Startup reconciliation sequence

On daemon start (or restart after crash):

```
1. Read system state:
   - Parse /etc/hosts for FOCUS SHIELD BLOCK markers → know what's currently blocked
   - Check pfctl -s info → know if pf is enabled
   - Read pf anchor files → know what IP rules exist

2. Ensure pf is enabled (if we have blocking rules)

3. Reload pf rules (ensures anchors are loaded)

4. Wait for server to push desired state via /apply
   (If server is also starting up, there may be a few seconds delay)

5. If no /apply received within 30s, log warning but keep current system state
   (Existing blocks persist — fail-safe)
```

### Should the daemon write a transaction log?

No. The operations are idempotent. Writing hosts + reloading pf can be repeated safely. If the daemon crashes and restarts, it just re-applies the current desired state (pushed by the server). A transaction log adds complexity for no benefit in this context.

---

## 7. Testing Strategy

### Challenge: Root operations

The daemon modifies `/etc/hosts`, runs `pfctl`, and executes `osascript`. Testing requires either:
1. Actually running as root (integration tests — slow, destructive)
2. Mocking the system calls (unit tests — fast, safe)

### Approach: Dependency injection for system operations

Extract all system interactions behind an interface. The daemon uses the real implementations; tests use mocks.

```typescript
// src/daemon/system.ts

export interface SystemOperations {
  // File operations
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;

  // pf operations
  pfReload(): Promise<void>;
  pfKillConnections(ip: string): Promise<void>;
  pfIsEnabled(): Promise<boolean>;
  pfEnable(): Promise<void>;

  // DNS operations
  resolve4(domain: string): Promise<string[]>;
  flushDnsCache(): Promise<void>;

  // Browser operations
  closeBrowserTabs(domain: string): Promise<void>;
}

// Real implementation
export class MacOSSystem implements SystemOperations {
  async readFile(path: string): Promise<string> {
    return fs.promises.readFile(path, 'utf8');
  }

  async pfReload(): Promise<void> {
    await execFileAsync('/sbin/pfctl', ['-f', '/etc/pf.conf']);
  }

  async resolve4(domain: string): Promise<string[]> {
    const resolver = new dns.Resolver();
    resolver.setServers(['8.8.8.8']);
    return resolver.resolve4(domain);
  }
  // ...
}

// Test mock
export class MockSystem implements SystemOperations {
  hostsContent = '';
  pfRules = '';
  resolvedIPs = new Map<string, string[]>();
  closedTabs: string[] = [];

  async readFile(path: string): Promise<string> {
    if (path === '/etc/hosts') return this.hostsContent;
    if (path.includes('pf.anchors')) return this.pfRules;
    return '';
  }

  async pfReload(): Promise<void> { /* no-op */ }

  async resolve4(domain: string): Promise<string[]> {
    return this.resolvedIPs.get(domain) || [];
  }

  async closeBrowserTabs(domain: string): Promise<void> {
    this.closedTabs.push(domain);
  }
  // ...
}
```

### Unit tests (no root needed)

These test the daemon's logic without touching the system:

```typescript
// tests/daemon/hosts.test.ts

import { HostsManager } from '../src/daemon/hosts';
import { MockSystem } from '../src/daemon/system';

test('adds blocked domains between markers', async () => {
  const sys = new MockSystem();
  sys.hostsContent = '127.0.0.1 localhost\n';

  const hosts = new HostsManager(sys);
  await hosts.updateBlocked(['twitter.com', 'reddit.com']);

  expect(sys.hostsContent).toContain('# BEGIN FOCUS SHIELD BLOCK');
  expect(sys.hostsContent).toContain('0.0.0.0 twitter.com');
  expect(sys.hostsContent).toContain('0.0.0.0 www.twitter.com');
  expect(sys.hostsContent).toContain(':: twitter.com');
  expect(sys.hostsContent).toContain('# END FOCUS SHIELD BLOCK');
  // Original content preserved
  expect(sys.hostsContent).toContain('127.0.0.1 localhost');
});

test('does not duplicate entries on re-apply', async () => {
  const sys = new MockSystem();
  sys.hostsContent = '127.0.0.1 localhost\n';

  const hosts = new HostsManager(sys);
  await hosts.updateBlocked(['twitter.com']);
  await hosts.updateBlocked(['twitter.com']); // apply again

  const matches = (sys.hostsContent.match(/0\.0\.0\.0 twitter\.com/g) || []).length;
  expect(matches).toBe(1); // not duplicated
});
```

```typescript
// tests/daemon/variants.test.ts

import { collectAllDomainsWithVariants } from '../src/shared/domains';

test('adds www. prefix', () => {
  const result = collectAllDomainsWithVariants(['reddit.com']);
  expect(result).toContain('reddit.com');
  expect(result).toContain('www.reddit.com');
});

test('adds YouTube variants', () => {
  const result = collectAllDomainsWithVariants(['youtube.com']);
  expect(result).toContain('m.youtube.com');
  expect(result).toContain('music.youtube.com');
  expect(result).toContain('youtu.be');
});

test('does not add www. if already prefixed', () => {
  const result = collectAllDomainsWithVariants(['www.reddit.com']);
  expect(result).toContain('www.reddit.com');
  // Should not have www.www.reddit.com
  expect(result).not.toContain('www.www.reddit.com');
});
```

```typescript
// tests/daemon/pf.test.ts

import { PfManager } from '../src/daemon/pf';
import { MockSystem } from '../src/daemon/system';

test('generates block return rules for resolved IPs', async () => {
  const sys = new MockSystem();
  sys.resolvedIPs.set('twitter.com', ['104.244.42.1', '104.244.42.2']);

  const pf = new PfManager(sys);
  const rules = await pf.generateDynamicRules(['twitter.com']);

  expect(rules).toContain('block return out quick proto tcp to 104.244.42.1');
  expect(rules).toContain('block return out quick proto udp to 104.244.42.1 port 443');
});

test('excludes granted domains from dynamic rules', async () => {
  const sys = new MockSystem();
  sys.resolvedIPs.set('twitter.com', ['104.244.42.1']);
  sys.resolvedIPs.set('reddit.com', ['151.101.1.140']);

  const pf = new PfManager(sys);
  // Block twitter, grant reddit
  const rules = await pf.generateDynamicRules(['twitter.com']); // reddit not in list

  expect(rules).toContain('104.244.42.1');
  expect(rules).not.toContain('151.101.1.140');
});
```

### Integration tests (requires root, run manually)

For actual system verification, a separate test script that:
- Uses a test pf anchor (`com.welf.focusshield.test`) to avoid interfering with production rules
- Writes to a temp copy of hosts (or uses a test prefix/suffix in markers)
- Must be run with `sudo`

```bash
#!/bin/bash
# tests/integration/test-blocking.sh
# Run with: sudo bash tests/integration/test-blocking.sh

TEST_ANCHOR="com.welf.focusshield.test"
TEST_ANCHOR_FILE="/etc/pf.anchors/$TEST_ANCHOR"

# Test 1: pf rule generation
echo "block return out quick proto tcp to 93.184.216.34 # example.com" > "$TEST_ANCHOR_FILE"
pfctl -f /etc/pf.conf
pfctl -a "$TEST_ANCHOR" -sr | grep -q "93.184.216.34" && echo "PASS: pf rules loaded" || echo "FAIL"

# Test 2: Connection killing
pfctl -k 0.0.0.0/0 -k 93.184.216.34 && echo "PASS: connection kill" || echo "FAIL"

# Cleanup
echo "" > "$TEST_ANCHOR_FILE"
pfctl -f /etc/pf.conf
rm "$TEST_ANCHOR_FILE"
```

### Test runner

Use Node's built-in test runner (available since Node 18) to avoid adding a test framework dependency:

```json
{
  "scripts": {
    "test": "node --experimental-strip-types --test tests/**/*.test.ts",
    "test:integration": "sudo bash tests/integration/test-blocking.sh"
  }
}
```

Or, if the project already uses or wants `vitest`:

```json
{
  "scripts": {
    "test": "vitest run"
  }
}
```

---

## 8. Minimal Privilege

### What actually needs root?

| Operation | Why root? | Can avoid? |
|-----------|-----------|-----------|
| Write `/etc/hosts` | Owned by root | No |
| `pfctl` commands | Requires root | No |
| `dscacheutil -flushcache` | Actually works without root | Yes, but inconsistent |
| `killall -HUP mDNSResponder` | Requires root to signal system processes | No |
| `osascript` (browser tabs) | Requires Accessibility permissions, not root | Partially |
| Read `/etc/hosts` | World-readable | Yes |
| Write pf anchor files | `/etc/pf.anchors/` is root-owned | No |

**Result:** The daemon genuinely needs root for its core operations. There's no meaningful privilege reduction available for `/etc/hosts` and `pfctl`.

### Can browser tab closing run as user?

AppleScript/JXA browser automation requires the calling process to have Accessibility permissions (System Settings > Privacy & Security > Accessibility). When the daemon runs as root, it inherits universal access. If tab closing ran as the user process (the server), it would need explicit Accessibility permission for Node.js.

**Current approach is fine:** The daemon already runs as root and has implicit accessibility. Moving tab closing to the server would require granting Accessibility to Node.js, which is more fragile.

### SMJobBless / SMAppService pattern

SelfControl uses `SMJobBless` (now superseded by `SMAppService` in macOS 13+) to install its privileged helper. This is Apple's sanctioned mechanism for:
1. App prompts user for admin credentials (one time)
2. Privileged helper is installed to `/Library/PrivilegedHelperTools/`
3. Helper runs as root, managed by launchd

**This only makes sense for native macOS apps.** SMJobBless/SMAppService requires:
- A signed macOS app bundle (.app)
- Code signing with Developer ID
- The helper must be a compiled binary (Mach-O), not a script
- XPC for communication between app and helper

For cc-focus (Node.js, no .app bundle, no code signing), the current LaunchDaemon approach is correct. SMJobBless would only become relevant if cc-focus were rewritten as a native Swift app — which would be a separate project entirely.

### macOS Authorization Services

`AuthorizationServices` can provide temporary root for specific operations without a persistent daemon:

```
User process → AuthorizationCreate() → admin password prompt → AuthorizationExecuteWithPrivileges() → runs command as root
```

This is deprecated (Apple removed `AuthorizationExecuteWithPrivileges` in recent SDKs) and was always considered a stopgap. The LaunchDaemon approach is the correct long-term solution for persistent privileged services.

### Recommendation: Keep LaunchDaemon, keep root

The daemon needs root for its core job. The LaunchDaemon approach is the correct macOS mechanism. No changes needed here.

---

## 9. Proposed New Structure

### Architecture overview

```
┌─────────────────────────────────────────────────────┐
│  Server (user process, port 8053)                   │
│  ├── REST API (/api/*)                              │
│  ├── MCP endpoint (/mcp)                            │
│  ├── Store (config.json — sole source of truth)     │
│  ├── Proxy (port 8080, optional MITM)               │
│  └── Allowance expiry checker (30s interval)        │
│       │                                             │
│       │  JSON-RPC 2.0 over Unix socket              │
│       │  /tmp/focusshield.sock                      │
│       ▼                                             │
│  ┌─────────────────────────────────────────────┐    │
│  │  Daemon (root process, stateless)           │    │
│  │  ├── Hosts manager (atomic writes)          │    │
│  │  ├── PF manager (static + dynamic rules)    │    │
│  │  ├── DNS resolver (async, parallel)         │    │
│  │  ├── Browser controller (JXA, parallel)     │    │
│  │  ├── Operation queue (serializes pf ops)    │    │
│  │  └── Startup reconciliation                 │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### Daemon IPC methods (JSON-RPC 2.0)

| Method | Params | Description |
|--------|--------|-------------|
| `apply` | `{ blockedDomains, shieldActive, priorityDomains? }` | Push full desired state. Daemon diffs and applies. |
| `enforce` | `{ domain }` | Aggressive block: resolve IPs, add pf rules, kill connections, close tabs. |
| `unblock_domain` | `{ domain }` | Remove pf rules for domain, flush DNS. |
| `flush_dns` | `{}` | Flush system DNS cache. |
| `status` | `{}` | Return daemon health, pid, uptime, system state. |

Note: no more `/grant`, `/revoke`, `/blocklist`, `/enable`, `/disable`, `/pf`, `/hosts`, `/clear`. These are all replaced by `apply` (which takes the full desired state) and `enforce`/`unblock_domain` (for targeted operations).

The server computes what should be blocked (based on its own allowance tracking, hard lockouts, etc.) and tells the daemon the result. The daemon doesn't need to know about allowances, lockouts, or categories.

### File-by-file plan

| File | What it does | Approx lines |
|------|-------------|-------------|
| `src/daemon/index.ts` | Entry point: JSON-RPC server on Unix socket, startup reconciliation, signal handlers | ~80 |
| `src/daemon/hosts.ts` | Read/write `/etc/hosts` with atomic writes, marker parsing | ~80 |
| `src/daemon/pf.ts` | Static rules, dynamic rules, anchor management, pfctl operations | ~120 |
| `src/daemon/dns.ts` | Async DNS resolution via `dns.Resolver`, parallel batch resolution | ~40 |
| `src/daemon/browser.ts` | JXA scripts for tab closing, parallel across browsers | ~60 |
| `src/daemon/queue.ts` | Simple async operation queue | ~30 |
| `src/daemon/rpc.ts` | JSON-RPC 2.0 request parsing, dispatch, response formatting | ~60 |
| `src/shared/domains.ts` | `collectAllDomainsWithVariants()`, `normalizeDomain()` | ~40 |
| `src/shared/ipc-types.ts` | Zod schemas for IPC methods, error codes | ~50 |
| `src/daemon-client.ts` | Replaces `blocker.ts`. Typed JSON-RPC client for server→daemon calls | ~80 |

**Total:** ~640 lines of TypeScript (vs. 636 lines of CJS), but structured, typed, testable.

### What stays the same

- Unix socket path: `/tmp/focusshield.sock` (chmod 666)
- LaunchDaemon plist: same location, same config, still points to `daemon/daemon.cjs`
- Build output: `daemon/daemon.cjs` (now produced by esbuild instead of handwritten)
- `/etc/hosts` marker format: `# BEGIN FOCUS SHIELD BLOCK` / `# END FOCUS SHIELD BLOCK`
- pf anchor names: `com.welf.focusshield` (static), `com.welf.focusshield.dynamic`
- Logging to stdout (captured by launchd to `/var/log/cc-focus-daemon.log`)

### What changes

| Before | After |
|--------|-------|
| Daemon has its own state.json | Daemon is stateless (server pushes via `apply`) |
| `execSync` for everything | `execFile` async + `dns.Resolver` |
| Sequential DNS resolution (5s) | Parallel resolution (~200ms) |
| Sequential browser tab closing | Parallel across browsers |
| Raw HTTP endpoints | JSON-RPC 2.0 with zod validation |
| Handwritten CJS | TypeScript compiled via esbuild |
| Domain variants duplicated | Shared `src/shared/domains.ts` |
| No tests | Unit tests with MockSystem |
| Crash may leave partial hosts file | Atomic file writes (write-then-rename) |
| No startup pf verification | Full startup reconciliation |

---

## 10. Migration Plan

### Phase 1: Extract shared code (no daemon changes)

Move domain variant logic from `daemon.cjs` to `src/shared/domains.ts`. Import in `store.ts`. Update `daemon.cjs` to still work (it won't import from shared — that comes in Phase 2).

**Risk:** None. Server-side only.

### Phase 2: Write daemon TypeScript source

Create `src/daemon/` directory with all the new modules. Build with esbuild to `daemon/daemon.cjs`. Test locally with `sudo node daemon/daemon.cjs`. The output replaces the handwritten CJS file — behavior should be identical.

**Risk:** Medium. The daemon is the privileged component. Test thoroughly before deploying.

**Validation:**
1. Build and run locally: `npm run build:daemon && sudo node daemon/daemon.cjs`
2. Verify all current endpoints still work (backwards compatibility during transition)
3. Test grant→expire→reblock cycle
4. Test daemon restart (kill -9, verify state recovery)
5. Check /var/log/cc-focus-daemon.log for errors

### Phase 3: Switch IPC to JSON-RPC

Update `src/daemon-client.ts` (formerly `blocker.ts`) to use JSON-RPC. Update daemon to handle JSON-RPC. Both should run the new protocol simultaneously with the old HTTP endpoints for backwards compatibility during transition.

**Risk:** Low. Both processes restart together (install.sh).

### Phase 4: Make daemon stateless

Remove state.json persistence from daemon. Update server to push full state via `apply` on startup and on every change. Remove daemon's allowance tracking.

**Risk:** Low-medium. The server must reliably push state. If it crashes between startup and pushing, the daemon has no state — but blocking persists at the OS level (hosts + pf rules are still in place).

### Phase 5: Add tests

Write unit tests using MockSystem. Add to CI/build process. Target critical paths first: hosts file writing, pf rule generation, domain variants.

**Risk:** None.

### Phase 6: Clean up

Remove legacy HTTP endpoint support from daemon. Remove state.json handling. Remove old `blocker.ts`. Update install.sh if any paths changed. Update README/CLAUDE.md.

---

## References

- [SelfControl source code analysis](selfcontrol-analysis.md) — privileged daemon architecture, XPC, integrity monitoring
- [Blocking approaches comparison](blocking-approaches.md) — hosts, pf, NE, proxy tradeoffs
- [DNS cache bug](dns-cache-bug.md) — why async DNS resolution matters
- [esbuild Node.js bundling](https://www.totaltypescript.com/build-a-node-app-with-typescript-and-esbuild)
- [SQLite WAL mode](https://sqlite.org/wal.html) — multi-process concurrent access
- [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification)
- [json-ipc-lib](https://www.npmjs.com/package/json-ipc-lib) — JSON-RPC 2.0 over Unix domain sockets
- [better-sqlite3 concurrency](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md)
- [SMAppService](https://github.com/alienator88/HelperToolApp) — modern replacement for SMJobBless
- [LuLu firewall](https://github.com/objective-see/LuLu) — NEFilterDataProvider reference implementation
