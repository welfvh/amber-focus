# Amber Focus — Full User Flow (from nothing to active shield)

## Reality Check

Some things I need to be honest about:

1. **`-p` (print mode) exits after one response.** It's for piping, not interactive sessions. So `claude -p "Start Amber Focus"` would print one message and quit — useless as a guardian.
2. **`--dangerously-skip-permissions`** is only needed for sudo (daemon install, pf rules). Daily use doesn't need it — the server handles everything via REST/MCP.
3. **No `--prefill` flag exists.** We can't pre-type a message.
4. **The skill is just a markdown file.** It's installed by copying to `~/.claude/commands/`. Once there, any CC session can use `/cc-amber-focus`.
5. **The MCP server runs independently.** Claude talks to it over HTTP. No continuous CC session required.

## The Flow

### Phase 1: Download

```
Option A (GitHub):
  git clone https://github.com/welfvh/amber-focus.git && cd amber-focus

Option B (Stripe → download link):
  curl -L https://amber.computer/download/<token> -o amber-focus.tar.gz
  tar xzf amber-focus.tar.gz && cd amber-focus
```

### Phase 2: Setup (one command)

```bash
./setup
```

This single script does everything:

```
1. Check prerequisites (node, claude CLI)
2. npm install && npm run build
3. Ask for sudo password (one time)
4. Install LaunchDaemon (root — pf, /etc/hosts)
5. Install LaunchAgent (user — server on port 8053)
6. Run enable-pf.sh (pf anchor setup)
7. Start server
8. Copy skill file → ~/.claude/commands/cc-amber-focus.md
9. Register MCP: claude mcp add amber-focus http://localhost:8053/mcp ...
10. Open http://localhost:8053/setup in browser
11. Print: "Onboarding open in your browser. Come back when done."
12. Wait for onboarding completion (poll /api/setup/status)
13. Print: "Shield active. 308 domains blocked across 11 categories."
14. Print: "Run /cc-amber-focus in Claude Code when you need me."
```

### Phase 3: Onboarding (browser — the 5 screens)

Server serves the onboarding UI at `localhost:8053/setup`.
Each screen writes to the server via REST:

```
Screen 1 (Welcome)     → no API call, just intro
Screen 2 (Your Why)    → POST /api/setup/profile { triggers, pain, purpose }
Screen 3 (Categories)  → POST /api/setup/categories { enabled: [...], exceptions: [...] }
Screen 4 (Cooldowns)   → POST /api/setup/cooldowns { twitter: "6h", youtube: "6h" }
Screen 5 (Activate)    → POST /api/setup/activate
```

The activate endpoint:
1. Writes final config to config.json
2. Enables shield (sends domain list to daemon)
3. Flushes DNS
4. Returns { success: true, blocked: 75800, categories: 11 }

Screen 5 then shows:

```
◉ Shield active

75,800+ domains blocked across 11 categories.
Twitter: 6h cooldown. YouTube: 6h cooldown.
Vigilant mode: always on.

When you need something unblocked, open Claude Code:
  $ claude
  > /cc-amber-focus

I'll challenge your intent, start a timer,
and watch your screen. When time's up, I reblock.
```

### Phase 4: Daily Use

No special session needed. User opens Claude Code for any project:

```bash
claude                     # normal interactive session
> /cc-amber-focus          # loads the skill context
> I need reddit for 15 min to check r/rust
```

Claude (with skill context + MCP tools) then:
1. Challenges: "What specifically on r/rust? Can you find it via search instead?"
2. If legitimate: calls `amber_grant` MCP tool (15 min, vigilant mode, stated intent)
3. Vigilant mode monitors screen every 10s
4. After 15 min (or 3 off-task strikes): auto-revoke, reblock, close tabs

The server runs 24/7 via LaunchAgent. No CC session needs to be open for blocking to work.

## What Needs Building

### New files:
- `setup` — single entry point script (replaces install.sh for first-time)
- `src/setup-routes.ts` — REST endpoints for onboarding (/api/setup/*)
- `public/setup.html` — the onboarding UI (our wireframes, served by Express)

### Modified files:
- `src/server.ts` — mount setup routes, serve static files from public/
- `src/store.ts` — add profile storage (triggers, pain, purpose for grant challenges)
- `src/mcp.ts` — use profile data in grant challenge prompts

### Not needed:
- `--dangerously-skip-permissions` in daily use
- Continuous CC terminal session
- `--prefill` or any CC launch magic
- Separate Electron/GUI app

## Distribution Options

### GitHub (free/open):
```
git clone → ./setup → done
```

### Stripe (paid):
```
Purchase → email with download link → unzip → ./setup → done
```

### Homebrew (future):
```
brew install amber-focus → amber-focus setup → done
```

## Open Questions

1. Should `setup` also handle updates? (`./setup --update`)
2. Profile data in grant challenges — how much context to give Claude?
   - Full text of "what do you lose" → powerful but verbose
   - Just the trigger domains → targeted but shallow
   - Both, summarized → probably right
3. Cooldown mechanic needs building — currently we have "hard lockouts" (absolute)
   and "grants" (timed access). Cooldowns are a new concept: "you can grant,
   but only after waiting N hours." This is a store.ts + server.ts change.
4. Should the onboarding be re-runnable? (`localhost:8053/setup` always accessible
   vs. redirect to status page after first setup)
