# Amber Focus

Manage DNS-level distraction blocking via amber-focus.

## Project Location

`~/dev/amber-focus/`

## Architecture

- **Standalone Node.js server** (no Electron)
- **Daemon** (runs as root): manages /etc/hosts + pf firewall
- **API server**: localhost:8053
- **MITM Proxy**: localhost:8080 (for path blocking and delays)
- **Vigilant Mode**: AI screenshot monitoring via Anthropic API
- **Config**: `~/.config/amber-focus/config.json`

## First-Time Setup

One-line install:
```bash
curl -fsSL amber.computer/focus/install | bash
```

Or if already cloned:
```bash
cd ~/dev/amber-focus && ./install.sh
```

See `~/dev/amber-focus/CLAUDE.md` for full setup guide.

## Quick API Commands

### Check status
```bash
curl -s localhost:8053/status
```

### List blocked domains
```bash
curl -s localhost:8053/api/blocked | jq
```

### Add domain to blocklist
```bash
curl -X POST localhost:8053/api/block \
  -H "Content-Type: application/json" \
  -d '{"domain": "example.com"}'
```

This automatically:
1. Adds domain to blocklist
2. Updates /etc/hosts
3. Flushes DNS cache
4. Kills existing connections to that domain
5. **Closes browser tabs** (Safari, Arc, Chrome) containing the domain

### Remove domain from blocklist (USE THIS TO UNBLOCK - NO SUDO NEEDED)
```bash
curl -X DELETE localhost:8053/api/block/example.com
curl -X POST localhost:8053/api/flush-dns
```
**ALWAYS use the API to unblock - never edit /etc/hosts manually with sudo.**

### Grant temporary access
```bash
curl -X POST localhost:8053/api/grant \
  -H "Content-Type: application/json" \
  -d '{"domain": "reddit.com", "minutes": 10, "reason": "checking thread"}'
```

### Grant with vigilant monitoring
```bash
curl -X POST localhost:8053/api/grant \
  -H "Content-Type: application/json" \
  -d '{"domain": "reddit.com", "minutes": 15, "reason": "reading r/programming", "vigilant": true, "intent": "reading the specific thread about Rust async"}'
```

**MANDATORY: After every successful grant, open the site in the browser:**
```bash
open https://DOMAIN
```

### Check vigilant session status
```bash
curl -s localhost:8053/api/vigilant/status | jq
```

### Enable/disable shield
```bash
curl -X POST localhost:8053/api/shield/enable
curl -X POST localhost:8053/api/shield/disable
```

### Toggle shield (force refresh)
```bash
curl -X POST localhost:8053/api/shield/disable && curl -X POST localhost:8053/api/shield/enable
```

### List active allowances
```bash
curl -s localhost:8053/api/allowances | jq
```

### Check specific domain
```bash
curl -s localhost:8053/api/check/twitter.com
```

### Flush DNS cache
```bash
curl -X POST localhost:8053/api/flush-dns
```

## Vigilant Mode

When granting access with `vigilant: true` and an `intent` string:
- Screenshots captured every 10s
- Evaluated by Claude Haiku against declared intent
- **3 consecutive off-task evaluations → auto-revoke + full reblock**
- All evaluations logged to `~/.config/amber-focus/vigilant-log.json`

**Requires:** Anthropic API key in macOS Keychain (`cc/anthropic` / `api_key`).
If not set up, install [cc-keys](https://github.com/welfvh/cc-keys) and run:
```bash
# Install cc-keys (API key manager for Claude Code)
git clone https://github.com/welfvh/cc-keys.git ~/dev/cc-keys && ~/dev/cc-keys/install.sh

# Then store your Anthropic API key
security add-generic-password -s "cc/anthropic" -a "api_key" -w "YOUR_KEY_HERE" -U
```
Without this key, vigilant mode will fail. Basic blocking works fine without it.

**Use vigilant mode for:**
- High-risk sites (social media, video)
- Narrow intents ("read this specific thread", "check one DM")
- Situations where the user's track record is poor

**MCP tool:** `amber_vigilant_status` — check current monitoring session

## Logs

```bash
# Server log
tail -f ~/.config/amber-focus/server.log

# Daemon log (requires sudo)
sudo tail -f /var/log/amber-focus-daemon.log
```

## Uninstall

```bash
cd ~/dev/amber-focus && ./uninstall.sh
```

## HIGH-RISK SITES (EXTRA SCRUTINY)

Social media and video sites are high-risk — short grants easily stretch into hours.
Always use vigilant mode + short durations (max 15 min) for these sites.
Challenge intent hard. The enforced auto-reblock timer exists and works.

## TIMER SYSTEM STATUS: ENFORCED + VIGILANT

The grant system is aggressive:
- Server polls every 30s for expiry
- On expiry: updates /etc/hosts, kills connections via pf, closes browser tabs via AppleScript
- Vigilant mode adds AI monitoring on top

**MANDATORY: Never use DELETE for high-risk sites (Twitter, YouTube, Reddit, etc.)**

Always use the grant endpoint:
```bash
curl -X POST localhost:8053/api/grant \
  -H "Content-Type: application/json" \
  -d '{"domain": "reddit.com", "minutes": 10, "reason": "checking thread", "vigilant": true, "intent": "reading specific thread"}'
```

## CRITICAL: Unblock Request Protocol

When the user asks to unblock/grant access to a site, DO NOT just comply. Be rigorous:

### STEP 0: CHECK DATE AND TIME (MANDATORY - DO THIS FIRST, EVERY TIME)
Before responding to ANY unblock request:
1. Check the current date and time from environment info (today's date is in system context)
2. Check for any hard lockouts: `curl -s localhost:8053/api/locks | python3 -m json.tool`
3. If a lockout exists, check if it's expired (compare `until` date with today). If expired, it no longer applies — grant normally. If active, refuse.
- After 9pm = wind-down time, be EXTRA skeptical
- Late-night requests are almost always impulse

### Then proceed:
1. **Ask WHY** - What specific task requires this site?
2. **Challenge necessity** - Can you accomplish the goal without it?
3. **CLARIFY INTENTION (MANDATORY)** - Make the user name the SPECIFIC ACTION, not just the category. "I need Reddit for research" -> "What exactly are you researching? Which subreddit? How long?"
4. **Ask HOW LONG** - Get a specific duration (5, 10, 15, 30 min max).
5. **Enable vigilant mode** for high-risk sites with narrow intents.
6. **Auto-reblock** - Always use `minutes` param. Only permanent DELETE for genuine creation/work tools.
7. **Open the site** - After granting, ALWAYS `open https://DOMAIN`.

**Never grant more than 30 minutes without strong justification.**

## IP-Level Blocking (pf)

pf rules automatically applied by the daemon. To manually enable:
```bash
sudo ~/dev/amber-focus/enable-pf.sh
```

## MCP Connection

```bash
claude mcp add --transport http --scope user \
  --header "Authorization: Bearer $(cat ~/.config/amber-focus/mcp-token)" \
  amber-focus http://localhost:8053/mcp
```

## Troubleshooting

### Domain added but still accessible
1. Check API: `curl -s localhost:8053/api/blocked | jq '.domains[]' | grep -i domain`
2. Check /etc/hosts: `grep -i domain /etc/hosts`
3. Toggle shield: `curl -X POST localhost:8053/api/shield/disable && curl -X POST localhost:8053/api/shield/enable`
4. Check daemon: `sudo launchctl list | grep amberfocus`
5. Check hosts timestamp: `grep "Generated:" /etc/hosts`

### Flush DNS
```bash
curl -X POST localhost:8053/api/flush-dns
```
