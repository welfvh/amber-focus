# Amber Focus

**Research Preview by [amber.computer](https://amber.computer)**

A distraction blocker for macOS that blocks the distracting internet by default and makes you justify every exception. When temporary access is granted, AI-powered vigilant mode watches your screen and auto-revokes if you drift off-task.

308 domains across 11 categories. DNS + firewall + browser tab enforcement. Runs 24/7 as a background service — no app needs to stay open.

## Philosophy

Most blockers are toggles. Focus is a gate.

Everything is blocked by default. When you need access, you explain yourself to Claude — not to a timer, not to a toggle, but to an intelligence that asks follow-up questions. This creates a gap between impulse and action. Not control — reflection.

## How it works

```
You ──Claude Code──> focus-grant ──> Server (127.0.0.1:8053) ──> config.json ──> Daemon (root)
                                       │                                          │
                                     grants, locks, vigilant mode            /etc/hosts
                                     browser tabs (close, reload)            pf firewall
                                                                             DNS flush, connection kill
```

**Server** (user-space, `127.0.0.1:8053`) — edits the desired state in `config.json`, handles browser tabs, runs vigilant mode. It serves local command-line clients only: no web page can call it.

**Daemon** (root) — reads `config.json` and converges the OS to it every 10 seconds. Grants expire on time even when the server is down.

**You talk to Claude, Claude runs `focus-grant`, the daemon does the blocking.**

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
- Allow **Automation** when macOS asks whether `node` may control your browser (the tab sweep and vigilant mode read and close tabs)

## Install

One command. Takes about 2 minutes.

```bash
curl -fsSL amber.computer/focus/install | bash
```

This clones the repo to `~/dev/amber-focus`, builds it, asks which categories to block, enables the pf firewall, and installs the daemon and the server as background services. The firewall and the daemon need your password.

**Prerequisites:** macOS 14+, Node.js 18+ (`brew install node`), [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`).

**Already cloned?** Run directly:
```bash
cd ~/dev/amber-focus && ./install-services.sh
```

**Verify it's running:**
```bash
curl localhost:8053/status
```

## Grant access

```bash
bin/focus-grant reddit 15 "checking r/rust async patterns"          # reddit.de + reddit.com, 15 min
bin/focus-grant youtube 20 tours --vigilant "watching house tours"  # with vigilant mode
```

Grants last 1 to 60 minutes and re-block on their own. Public suffixes (`com`, `co.uk`) and hard-locked domains are refused.

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
| Adult | 63 | Pornhub, OnlyFans, Chaturbate |

Email, banking, maps, dev tools — never touched.

## Blocking layers

1. **DNS** — `/etc/hosts` entries (0.0.0.0 for domain + www/mobile variants)
2. **Firewall** — `pf` rules blocking IP ranges + dynamically resolved IPs
3. **Connection kill** — `pfctl -k` terminates existing TCP connections immediately
4. **Browser tabs** — every 10 seconds the server closes tabs on blocked sites in Chrome, Safari and Arc, even when the browser bypassed DNS
5. **QUIC** — UDP port 443 blocked to prevent HTTP/3 fallback

## Vigilant mode

When a grant is active with vigilant mode:

1. Screenshots captured every 10s via `screencapture -x`
2. Evaluated by Claude Haiku against the user's declared intent
3. 3 consecutive off-task evaluations → auto-revoke + full reblock
4. All evaluations logged locally to `~/.config/amber-focus/vigilant-log.json`

API key from macOS Keychain via [cc-keys](https://github.com/welfvh/cc-keys): `cc/anthropic` / `api_key`.

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
