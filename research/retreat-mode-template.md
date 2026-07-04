# Retreat-mode template

Reusable rule template for Welf's retreats — encodes how amber-focus + Claude should handle requests during retreat hours. Lifted verbatim from `~/.claude/CLAUDE.md` after the 2026-04-26 → 2026-05-01 retreat ended, so the next retreat doesn't need to reinvent the policy.

To activate: copy the section below into `~/.claude/CLAUDE.md` under `## House Rules`, fill in the actual dates, adjust hours/allowlist if needed, and add the expiry footer. Remove from CLAUDE.md when the retreat ends — keep this file as the canonical source.

---

## Retreat mode (active YYYY-MM-DD → YYYY-MM-DD)

Welf is on retreat. The following hours are **OFF LIMITS** for distractions, unblock requests, and non-essential engagement:

- **16:00–18:00** (4–6pm)
- **19:00–21:00** (7–9pm)
- **22:00–06:00** (10pm–6am)

Available windows: 06:00–16:00, 18:00–19:00, 21:00–22:00.

**The point of retreat blocking is to protect the retreat experience, not to be an arbitrary wall.** The rule below is calibrated to refuse impulse/distraction *and* allow the narrow retreat-supporting admin that actually keeps the retreat intact (canceling meetings, coordinating with people about retreat-affected commitments). Welf's phone is intentionally in airplane mode in another room during retreat, so "use your phone" is usually NOT a real alternative — suggesting it forces him to break retreat hygiene.

**During off-limits hours, classify the request before responding:**

**Always refuse (no negotiation):**
- Browsing-shaped surfaces: Twitter/X, Instagram, TikTok, YouTube, Reddit, news sites, shopping
- Anything described as "just check X", "quick look", "for a sec" without a named recipient or named output
- Any unblock for a category, not a specific destination ("social", "news", "the web")

**Grant a thin timed allowance (5–10 min auto-revoke), no negotiation:**
- One-shot message to a *named person* about a *specific thing* (e.g. "WhatsApp Sebi about tomorrow's meeting")
- Canceling / rescheduling a commitment because of the retreat
- Retreat logistics: joining the session Zoom, finding a meditation file, retrieving a link sent to him
- Single specific email/document the recipient is waiting on

**Always allowed (persistent allowlist, no grant flow needed):**
Ghostty, Zoom, Olo, Pliability, Claude Desktop, Spotify, QuickTime, Apple TV, Clock, Calendar (Apple + Notion), Contacts, Preview, iA Writer.

**Heuristics when in doubt:**
- Is there a named recipient or named target? → lean grant
- Could this turn into 30 min of scrolling? → refuse, even if the framing sounds legit
- Is the alternative "use your phone"? → it's not. Phone is in airplane mode by design.
- Is the alternative "wait until 06:00"? → only suggest if the thing genuinely doesn't matter for ~8 hours AND no other person is waiting

**Corporate (Teams) exception:** During the **16:00–18:00 window only** (corporate hours), Welf may request Teams if 1&1/corporate has urgent questions. Require a strong specific reason (actual pending message/meeting). Add `com.microsoft.teams2` to the retreat allowlist; remove at 18:00. Outside 16–18, Teams requests are impulse — refuse.

**Process for thin-grant exceptions:**
1. Add the bundle ID to the retreat allowlist via `POST /api/retreat`
2. Schedule a `nohup sleep N && curl -X POST .../api/retreat` to auto-revoke after the window
3. Don't lecture. Just grant and confirm the auto-revoke time.

**Expires YYYY-MM-DD.** Remove this section after that date.

---

## Notes from the 2026-04-26 → 2026-05-01 run

What worked:
- The three-tier classification (always refuse / thin-grant / always-allow) gave Claude a fast decision tree.
- The "retreat blocking exists to protect retreat, not to be a wall" framing prevented over-refusal of legitimate retreat-supporting admin.
- Persistent allowlist for meditation/calendar/text-editor apps removed friction for the actual retreat surface.

What to revisit next time:
- The Teams 16:00–18:00 carve-out is corporate-specific; drop it for non-1&1 retreats.
- Hours assumed Berlin time (Welf's locale); make explicit if traveling.
- The allowlist of named apps will drift — re-check before each retreat.
