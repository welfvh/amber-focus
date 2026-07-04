# amber-focus — Setup Guide

You received this as a zip file. This guide gets you from zero to a running distraction shield.

## Prerequisites

- **macOS 14+** (Sonoma or later)
- **Node.js 18+** — install with `brew install node` (or [nodejs.org](https://nodejs.org))
- **Xcode Command Line Tools** — `xcode-select --install` (for Swift compiler)
- **Claude Code** — `npm install -g @anthropic-ai/claude-code`

## Step 1: Unzip to the right place

```bash
mkdir -p ~/dev
unzip amber-focus.zip -d ~/dev/amber-focus
```

The app expects to live at `~/dev/amber-focus/`. Don't put it elsewhere.

## Step 2: Build the setup app

```bash
cd ~/dev/amber-focus/app
make
```

This compiles `amber-focus.swift` into a native macOS binary (~2 seconds).

## Step 3: Run the setup app

```bash
./amber-focus
```

A dark onboarding window appears. Walk through the 5 screens:

1. **Welcome** — read the philosophy
2. **Your Why** — pick your triggers, name what it costs you, name what matters instead
3. **Categories** — choose which site categories to block (all on by default)
4. **Cooldowns** — add mandatory wait periods for your worst sites
5. **Activate** — hit the button. It will:
   - Build the Node.js server
   - Generate an MCP auth token
   - Install the root daemon (prompts for admin password)
   - Install the server as a LaunchAgent
   - Enable pf firewall rules (prompts for admin password again)
   - Wait for the server to come online
   - Configure your categories/cooldowns
   - Connect Claude Code's MCP
   - Install the `/cc-amber-focus` skill for Claude Code

All 9 steps should show green checkmarks. Hit "Done — go to menu bar."

## Step 4: Set up vigilant mode (optional but recommended)

Vigilant mode watches your screen during temporary access grants and auto-revokes if you drift off-task. It needs an Anthropic API key.

### Install cc-keys (API key manager)

```bash
git clone https://github.com/welfvh/cc-keys.git ~/dev/cc-keys
~/dev/cc-keys/install.sh
```

### Store your Anthropic API key

Get a key from [console.anthropic.com](https://console.anthropic.com/settings/keys), then:

```bash
security add-generic-password -s "cc/anthropic" -a "api_key" -w "sk-ant-your-key-here" -U
```

### Grant Screen Recording permission

System Settings > Privacy & Security > Screen Recording > enable your terminal app (Terminal, iTerm2, Ghostty, etc.)

Without this, vigilant mode can't capture screenshots.

## Step 5: Verify everything works

```bash
# Server running?
curl -s localhost:8053/status

# Blocking active?
curl -s localhost:8053/api/check/twitter.com

# Claude Code connected?
claude
> /cc-amber-focus
> check status
```

## Daily use

The shield runs 24/7 as a background service. No app needs to stay open. When you need something unblocked:

```
$ claude
> I need reddit for 15 min to check r/rust
```

Claude will:
1. Challenge your intent (why? can it wait? how long?)
2. Grant timed access with vigilant monitoring
3. Auto-revoke when time's up or you drift off-task

## The menu bar app

After setup, a shield icon lives in your menu bar. Click it to see:
- Shield status
- Screen time by app (today)
- Activity stats (keystrokes, clicks, cursor distance, app switches)
- Browsing data
- Active grants

## Troubleshooting

**Server not starting?**
```bash
tail -f ~/.config/amber-focus/server.log
launchctl list | grep amberfocus
```

**Sites still loading after blocking?**
Browsers cache DNS. Open a fresh tab or restart the browser. If still loading:
```bash
curl -X POST localhost:8053/api/flush-dns
```

**Vigilant mode failing?**
```bash
# Check API key is set
security find-generic-password -s "cc/anthropic" -a "api_key" -w
```

**Uninstall everything:**
```bash
cd ~/dev/amber-focus && ./uninstall.sh
```
