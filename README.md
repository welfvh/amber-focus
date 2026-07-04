# Amber Focus

**Research Preview by [amber.computer](https://amber.computer)**

A distraction blocker for macOS that blocks the distracting internet by default and makes you justify every exception. When temporary access is granted, AI-powered vigilant mode watches your screen and auto-revokes if you drift off-task.

308 domains across 11 categories. DNS + firewall + browser tab enforcement. Runs 24/7 as a background service — no app needs to stay open.

## Philosophy

Most blockers are toggles. Focus is a gate.

Everything is blocked by default. When you need access, you explain yourself to Claude — not to a timer, not to a toggle, but to an intelligence that asks follow-up questions. This creates a gap between impulse and action. Not control — reflection.

## How it works

```
You ──Claude Code──> Server (:8053) ──JSON-RPC──> Daemon (root)
                       │                              │
                    state/config                 /etc/hosts
                    grants/cooldowns             pf firewall
                    vigilant mode                DNS flush
                       │                         tab close
                    REST API + MCP               connection kill
```

**Server** (port 8053, user-space) — owns all state. REST API for local use, MCP endpoint for Claude.

**Daemon** (root, Unix socket) — stateless, applies blocking to the OS. Restarts freely; server re-pushes state.

**You talk to Claude, Claude talks to the server, the server tells the daemon what to block.**

## Prerequisites

- macOS 14+
- Node.js 18+ (`brew install node`)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`)

**For vigilant mode** (AI screenshot monitoring):
- Anthropic API key stored in macOS Keychain — install [cc-keys](https://github.com/welfvh/cc-keys) then:
  ```bash
  /cc-keys add anthropic            # register the service
  /cc-keys set anthropic api_key sk-ant-your-key-here
  ```
- Grant **Screen Recording** permission to your terminal app (System Settings > Privacy & Security > Screen Recording)

## Install

One command. Takes about 2 minutes.

```bash
curl -fsSL amber.computer/focus/install | bash
```

This clones the repo, builds the server and onboarding app, then launches a 4-screen setup wizard that installs the daemon, server, firewall rules, connects Claude Code, and drops you into your first session.

**Prerequisites:** macOS 14+, Node.js 18+ (`brew install node`), [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`).

**Already cloned?** Run directly:
```bash
cd ~/dev/amber-focus && ./install.sh
```

**Verify it's running:**
```bash
curl localhost:8053/status
```

## CLI

```bash
amber-focus status          # shield state, blocked count, active grants
amber-focus x 5             # grant Twitter/X for 5 minutes with vigilant mode
amber-focus grant reddit.com 15 "checking r/rust"   # grant with reason
amber-focus block example.com                        # add to blocklist
amber-focus unblock example.com                      # remove from blocklist
```

## Daily use

The shield runs 24/7. When you need something unblocked:

```
$ claude
> /amber-focus
> I need reddit for 15 min to check r/rust async patterns
```

Claude will challenge your intent, then grant timed access with vigilant mode watching your screen. When time's up (or you drift off-task 3 times), access is revoked and the domain is re-blocked.

## What gets blocked

| Category | Domains | Examples |
|----------|---------|---------|
| Social media | 44 | Twitter/X, Facebook, Instagram, Reddit, TikTok, Discord, Mastodon |
| Video & streaming | 25 | YouTube, Netflix, Twitch, Disney+, Bilibili, Kick |
| News & media | 68 | Substack, Medium, CNN, BBC, TechCrunch, Hacker News |
| Shopping | 28 | Amazon, Temu, Shein, Zalando, eBay |
| Sports | 12 | ESPN, LiveScore, Kicker, Sky Sports |
| Gaming | 15 | Steam, IGN, Chess.com, Kongregate |
| Memes | 12 | 9gag, Imgur, TVTropes, Fandom, KnowYourMeme |
| Reading | 13 | Wattpad, FanFiction, Manga, Webtoons |
| Dating | 9 | Tinder, Bumble, Hinge, Badoo |
| Gambling | 19 | bet365, DraftKings, PokerStars |
| Adult | 75,000+ | Comprehensive blocklist |

Email, banking, maps, dev tools — never touched.

## Blocking layers

1. **DNS** — `/etc/hosts` entries (0.0.0.0 for domain + www/mobile variants)
2. **Firewall** — `pf` rules blocking IP ranges + dynamically resolved IPs
3. **Connection kill** — `pfctl -k` terminates existing TCP connections immediately
4. **Browser tabs** — AppleScript closes matching tabs in Safari, Arc, Chrome
5. **QUIC** — UDP port 443 blocked to prevent HTTP/3 fallback

## Vigilant mode

When a grant is active with vigilant mode:

1. Screenshots captured every 10s via `screencapture -x`
2. Evaluated by Claude Haiku against the user's declared intent
3. 3 consecutive off-task evaluations → auto-revoke + full reblock
4. All evaluations logged locally to `~/.config/amber-focus/vigilant-log.json`

API key from macOS Keychain via [cc-keys](https://github.com/welfvh/cc-keys): `cc/anthropic` / `api_key`.

## MCP tools

9 tools at `/mcp` (Bearer token auth):

| Tool | Purpose |
|------|---------|
| `amber_status` | Shield state, daemon health, blocked count |
| `amber_blocked_list` | All blocked domains |
| `amber_check_domain` | Check if a domain is blocked/granted/locked |
| `amber_allowances` | Active grants with expiry times |
| `amber_delayed_list` | Delayed domains |
| `amber_grant` | Grant timed access (optional vigilant mode) |
| `amber_block` | Block a domain |
| `amber_unblock` | Permanently unblock (refuses hard-locked) |
| `amber_vigilant_status` | Current monitoring session |

## Logs

```bash
tail -f ~/.config/amber-focus/server.log           # server
sudo tail -f /var/log/amber-focus-daemon.log       # daemon
```

## Troubleshooting

```bash
# Check if services are running
launchctl list | grep amberfocus

# Test server health
curl localhost:8053/status

# Check if a specific domain is blocked
curl localhost:8053/api/check/twitter.com

# Port 8053 already in use?
lsof -i :8053

# Daemon socket stale?
ls -la /tmp/amberfocus.sock
```

**Vigilant mode fails silently?** Check that your Anthropic API key is set:
```bash
security find-generic-password -s "cc/anthropic" -a "api_key" -w
```
If it returns an error, set it up via [cc-keys](https://github.com/welfvh/cc-keys).

**Sites still loading after blocking?** Browsers cache DNS internally. Open a fresh tab, or restart the browser. If still loading, make sure you ran `sudo ./enable-pf.sh`.

## Uninstall

```bash
./uninstall.sh
```
