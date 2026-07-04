# Amber Focus — First-Time Onboarding UX

## Philosophy

**Inverse model**: Everything distracting is blocked by default. The question isn't "what do you want to block?" — it's "here's what I block, turn off anything you genuinely need."

This flips the psychology. Traditional blockers make you enumerate distractions (which means thinking about them). Amber starts with the shield up and makes you justify what deserves an opening.

Essential services (email, banking, maps, dev tools) are never touched.

## Design Principles

- **Minimal screens** — 5 steps, no more
- **First-person voice** — Amber speaks directly ("I block...", "I'll watch...")
- **Motivation capture** — ask about pain + purpose, store as fuel for later grant challenges
- **Aggressive defaults** — everything blocked, vigilant mode on
- **Quick to complete** — under 2 minutes

## Flow

### Screen 1: Welcome
Sets the tone. ASCII amber glyph.
"The distracting internet is off. Let's decide what stays on."

### Screen 2: Tell Me About It
Capture the user's relationship with distraction:
- "What pulls you in?" (tag selection: Twitter/X, YouTube, Reddit, etc.)
- "What do you lose when it does?" (free text)
- "What would you rather be doing?" (free text)

These answers fuel:
- Grant challenge questions ("You said you lose evenings to X. Is this worth it?")
- Vigilant mode prompts ("User wants to protect deep work time")
- Weekly reflection data

### Screen 3: Here's What I Block
Show all 11 categories, all ON by default (red toggles):
- Social media (44 domains), Video & streaming (25), News & media (68)
- Shopping (28), Sports/gaming/memes (39), Reading/dating/gambling (41)
- Adult (75,000+)

Note: "Email, banking, maps, dev tools — all untouched."
Custom domain exception input for anything the user needs for work.

### Screen 4: Cooldowns
For the sites that really get you. Not a permanent ban — just friction.

User selects which sites get cooldowns and picks a duration:
- 1h / 3h / 6h / 24h / 72h
- Pre-selected: Twitter/X (6h), YouTube (6h)

"You can still unlock it, but you have to wait first. Request access, then come back after the cooldown. If you still want it — it's yours."

### Screen 5: Activate
Summary: categories blocked, cooldowns set, exceptions.
Vigilant mode explainer: "When you get temporary access, I watch your screen."
Single button: "Activate shield" → calls POST /api/setup/activate

Shows the daily-use workflow:
```
$ claude
> /cc-amber-focus
> I need reddit for 15 min to check r/rust
```

## Technical Notes

- Onboarding served at `localhost:8053/setup` by Express
- REST endpoints: POST /api/setup/profile, /api/setup/categories, /api/setup/cooldowns, /api/setup/activate
- Motivation stored in `~/.config/amber-focus/config.json` for grant challenges
- No CC session needed — shield runs 24/7 via LaunchAgent
- CC is only for grant conversations (user opens Claude Code, runs /cc-amber-focus)

## Wireframes

HTML wireframes at `research/wireframes/onboarding.html`. Serve with:
```bash
python3 -m http.server 9123 -d research/wireframes
# open http://localhost:9123/onboarding.html
# per-screen: ?screen=1 through ?screen=5
```
