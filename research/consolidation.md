# Consolidation: potential-mac + monastic-agent + amber-focus

## What Exists Today

```
MENU BAR
┌──────────────┐  ┌──────────────┐
│ potential-mac │  │monastic-agent│
│  (hexagon)   │  │    (◉)       │
└──────┬───────┘  └──────┬───────┘
       │                 │
    Dashboard         Overlays
    (passive)         (active)
    reads data        receives cmds

BACKGROUND
┌──────────────┐  ┌──────────────┐
│ amber-focus  │  │amber-focus   │
│ server:8053  │  │ daemon(root) │
│  (Node.js)   │  │  (Node.js)   │
└──────────────┘  └──────────────┘
    REST/MCP          pf, hosts,
    store             DNS, tabs
```

### Three apps, different roles:

```
┌─────────────────────────────────────────────────────────┐
│ potential-mac (Swift, menu bar popover)                  │
│                                                         │
│ DATA DASHBOARD — passive, read-only                     │
│ • Screen Time (knowledgeC.db)                           │
│ • Calendar (Calendar.sqlitedb)                          │
│ • Activity (keystrokes, mouse, cursor, app switches)    │
│ • Music (MediaRemote + Spotify API)                     │
│ • Oura (sleep, readiness, HRV)                          │
│ • Weather + Location                                    │
│ • Browser history (Safari + Chrome)                     │
│ • Check-ins (mood, energy)                              │
│ • Affordances (context-filtered shortcuts)              │
│ • Practices (morning/evening rituals)                   │
│ • "Chat with Claude" → delegates to monastic-agent      │
│                                                         │
│ ALSO: notch-triggered "Today" overlay panel             │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ monastic-agent (Swift, single file, menu bar daemon)    │
│                                                         │
│ COMMAND EXECUTOR — active, receives instructions        │
│ • Fullscreen overlays (text, choices, brain dump)       │
│ • Chat mode (conversational overlay → /api/chat)        │
│ • Action execution (lock, open, spotify, osascript)     │
│ • Hotkey: Ctrl+` (check-in overlay)                     │
│ • Polls monastic-os worker every 10s                    │
│ • Local IPC via /tmp/monastic-agent/commands/           │
│ • Multi-screen (fills all displays)                     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ amber-focus server (Node.js, port 8053)                 │
│                                                         │
│ FOCUS BLOCKER — enforces distraction blocking           │
│ • 308 domains in 11 categories + 75k adult bulk         │
│ • Grants with vigilant mode (screenshot → AI eval)      │
│ • Cooldowns, hard lockouts, allowances                  │
│ • MCP endpoint for Claude Web/Code                      │
│ • Commands root daemon (pf, hosts, DNS, tabs)           │
│ • MITM proxy for path-level blocking                    │
└─────────────────────────────────────────────────────────┘
```

## What's Wrong

1. **Crowded menu bar** — two icons, unclear which does what
2. **potential-mac is too big** — tries to be everything in one scroll
3. **Chat splits across systems** — potential-mac delegates to monastic-agent
4. **Focus has no UI** — amber-focus is headless (REST/MCP only)
5. **Duplicate data** — screen time in potential-mac AND potential-mcp
6. **No focus integration** — dashboard shows activity but doesn't ACT on it

## Current potential-mac UI (from screenshot)

```
┌──────────────────────────────────┐
│ 12:47              afternoon     │
│ ☁ Lindenthal · 10°C light drzzl │
│ 2h 34m screen time               │
├──────────────────────────────────┤
│ [      hourly graph      ]       │  ← remove (noise, unreadable)
│                                  │
│ How are you feeling?             │  ← remove (noise, rarely used)
│ [calm] [focu] [rest] [anxi]     │
├──────────────────────────────────┤
│ Music          Nothing playing   │
│ Connect Spotify              🔗  │
├──────────────────────────────────┤
│ Calendar                         │
│ No events today                  │
├──────────────────────────────────┤
│ Screen Time              2h 34m  │
│ Ghostty            1h 25m        │
│ Figma                23m         │
│ Chrome               18m         │
├──────────────────────────────────┤
│ Activity           170/hr scat.  │
│ ⌨ 39,782 🖱 16,224 📏 2.8km     │  ← better labeling needed
│ ☰ ~4.6kw                        │
├──────────────────────────────────┤
│ Browsing            10 sites     │
│ localhost               15       │
│ accounts.google.com      8       │
│ figma.com                7       │
├──────────────────────────────────┤
│ Actions             afternoon    │
│ [▶ Play] [⏭ Skip] [🔒 Lock]    │
│ [    💬 Chat with Claude     ]   │
│ ⚙ C5 + One Taste                │
│ 🌙 Yoga Nidra                   │
│ ✏ Journal                       │
│ ♪ Nils Frahm                    │
│ 🎧 Lo-fi                        │
│ 🚶 Walk                         │
│ 📖 Read                         │
├──────────────────────────────────┤
│            🔄  Quit              │
└──────────────────────────────────┘
```

## Proposed: Tabbed Menu Bar App

One icon. Three tabs. Clean separation.

```
┌──────────────────────────────────┐
│ [Activity]  [Focus]  [Actions]   │  ← tab bar
├──────────────────────────────────┤
```

### Tab 1: Activity (today's data)

```
┌──────────────────────────────────┐
│ [•Activity]  [Focus]  [Actions]  │
├──────────────────────────────────┤
│ Saturday afternoon   12:47       │
│ ☁ Lindenthal · 10°C             │
├──────────────────────────────────┤
│ Screen Time              2h 34m  │
│                                  │
│ Ghostty                  1h 25m  │
│ ████████████████████░░░░  55%    │
│ Figma                      23m   │
│ █████░░░░░░░░░░░░░░░░░░░  15%   │
│ Chrome                     18m   │
│ ████░░░░░░░░░░░░░░░░░░░░  12%   │
├──────────────────────────────────┤
│ Focus                            │
│ 12 switches/hr         focused   │  ← clearer label
│                                  │
│ Today: 23 app switches           │
│ Avg session: 6m 37s              │
├──────────────────────────────────┤
│ Input                            │
│ 39,782 keystrokes  ~4.6k words   │
│ 16,224 clicks      2.8km cursor  │
├──────────────────────────────────┤
│ Browsing             10 sites    │
│ localhost               15       │
│ figma.com                7       │
│ duckduckgo               7       │
├──────────────────────────────────┤
│ Calendar                         │
│ No events today                  │
├──────────────────────────────────┤
│       [Today]  [7 days]          │  ← toggle for weekly view
└──────────────────────────────────┘
```

### Tab 2: Focus (amber-focus status + controls)

```
┌──────────────────────────────────┐
│  [Activity]  [•Focus]  [Actions] │
├──────────────────────────────────┤
│ Shield                    active │
│ ◉ 75,800+ domains blocked       │
│ 10 categories on                 │
├──────────────────────────────────┤
│ Active Grants                    │
│ (none right now)                 │
│                                  │
│ or:                              │
│ reddit.com         12m left      │
│ ████████████░░░░░░  vigilant ◉   │
│ Intent: "check r/rust async"     │
├──────────────────────────────────┤
│ Cooldowns                        │
│ twitter.com          6h wait     │
│ youtube.com          6h wait     │
├──────────────────────────────────┤
│ Today's Grants                   │
│ 0 granted · 0 revoked           │
│                                  │
│ This Week                        │
│ 3 granted · 1 auto-revoked      │
│ Avg duration: 14m                │
├──────────────────────────────────┤
│ [  Ask for access (→ Claude)  ]  │
│                                  │
│ Vigilant: on  Eval: local/qwen   │
└──────────────────────────────────┘
```

### Tab 3: Actions (affordances + routines)

```
┌──────────────────────────────────┐
│  [Activity]  [Focus]  [•Actions] │
├──────────────────────────────────┤
│ Music          Nothing playing   │
│ [▶ Play]  [⏭ Skip]              │
├──────────────────────────────────┤
│ Afternoon                        │
│ ⚙ C5 + One Taste                │
│ ✏ Journal                       │
│ ♪ Nils Frahm                    │
│ 🎧 Lo-fi                        │
│ 📖 Read                         │
├──────────────────────────────────┤
│ Evening                          │
│ 🌙 Yoga Nidra                   │
│ 🚶 Walk                         │
│ 🔒 Lock screen                  │
├──────────────────────────────────┤
│ [  💬 Chat with Claude  ]       │
│ Ctrl+` for quick check-in       │
├──────────────────────────────────┤
│ Check-in                         │
│ Last: 11:30 — focused, energy 4  │
│ [Update]                         │
└──────────────────────────────────┘
```

## What Goes Away

- "How are you feeling?" chips at the top — moved to Actions tab as "Check-in"
- Hourly rhythm strip graph — unreadable at this size, save for a full window
- Weather + screen time in the header — redundant with Activity tab
- Oura section — keep in Activity tab only if connected, otherwise hide
- Browsing section bloated — top 5, not top 10

## What's New

- **Focus tab** — amber-focus finally has a UI
- **Tab structure** — no more infinite scroll
- **Weekly view toggle** — "Today" vs "7 days" in Activity
- **Grant history** — see how many grants you've used this week
- **Vigilant status** — see if monitoring is active, what model

## Technical: One App or Two?

### Option A: One Swift app (consolidate everything)
```
potential-mac absorbs:
  + amber-focus Focus tab (reads REST from localhost:8053)
  + monastic-agent overlays (build into same binary)
  + monastic-agent hotkey (Ctrl+`)

amber-focus server stays Node.js (blocking infra)
amber-focus daemon stays Node.js (root, pf/hosts)
```

**Pros**: One menu bar icon. One codebase. Shared data.
**Cons**: Big refactor. Monastic-agent is a separate concern.

### Option B: Two apps (potential + overlays)
```
potential-mac (menu bar dashboard):
  Activity + Focus + Actions tabs
  Reads amber-focus via REST

monastic-agent (invisible daemon):
  Overlays only (no menu bar icon needed?)
  Hotkey: Ctrl+`
  IPC from potential-mac for "Chat with Claude"
```

**Pros**: Clean separation. Agent stays simple.
**Cons**: Still two processes. IPC complexity.

### Option C: One app, overlay as a feature
```
potential-mac absorbs monastic-agent:
  Tab UI in popover
  Overlays as NSPanel from same app
  Hotkey from same app
  One process, one icon

amber-focus stays as Node.js server + daemon
  → potential-mac reads its REST API for Focus tab
```

**Recommended.** Monastic-agent is only 1035 lines. Its overlay rendering
and action execution can be absorbed into potential-mac. The agent's
worker-polling can become a background task in DataEngine.

## Immediate Next Steps

1. Ship amber-focus as-is (onboarding, expanded blocklist, docs)
2. Add Focus tab to potential-mac (reads amber-focus REST)
3. Remove "How are you feeling?" + hourly graph from potential-mac
4. Add tab bar (Activity / Focus / Actions)
5. Consider absorbing monastic-agent later (bigger refactor)
