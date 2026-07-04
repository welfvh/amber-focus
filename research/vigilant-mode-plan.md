# Vigilant Mode — Plan

## Problem

Timed grants ("20 min on Reddit to check r/swift") routinely devolve. The user starts with good intent but drifts to the feed, Explore tab, unrelated rabbit holes. The timer expires but damage is done — 20 minutes of dopamine scrolling, not the targeted task.

The existing system grants time but has no mechanism to verify the user is actually doing what they said they'd do.

## Concept

When requesting access, the user declares a specific intent. During the grant window, the system takes periodic screenshots and an AI model evaluates whether the user is on-task or drifting. If drift is detected, the system escalates: warn → re-warn → revoke.

## User Flow

1. User asks Claude to unlock reddit.com
2. Claude (per existing protocol) asks: "What specifically will you do?"
3. User: "Check the top post in r/swift about the new concurrency API"
4. Claude grants access via `focus_grant` with the intent stored
5. **Vigilant mode activates**: screenshots begin every ~10 seconds
6. Each screenshot is evaluated against the declared intent
7. If on-task: continue silently
8. If drifting: escalate (see Escalation below)
9. When grant expires or task is complete: vigilant mode ends

## Architecture

### Where Screenshots Happen

**monastic-os agent** (Swift, runs locally, already has screen access).

The agent already manages fullscreen overlays and executes actions. Adding screenshot capture is natural — it has the permissions (Screen Recording) and the polling loop.

### Where Evaluation Happens

**monastic-os worker** (Cloudflare Worker, already calls Claude API for syntheses).

Flow:
```
Agent (Mac)                          Worker (CF)
  │                                      │
  ├── screencapture → JPEG ──────────────┤
  │   (every ~10s, compressed)           │
  │                                      ├── Claude vision API call
  │                                      │   "Is user doing X? Screenshot:"
  │                                      │
  │   ◄── {on_task: bool, note: "..."}───┤
  │                                      │
  ├── if off-task: show warning overlay  │
  │                                      │
```

### Screenshot Mechanics

```swift
// In monastic-os agent
func captureScreen() -> Data? {
    let image = CGDisplayCreateImage(CGMainDisplayID())
    // Resize to ~720p, JPEG quality 0.5 (~50-100KB per shot)
    // Strip to just the active window if possible
    return jpegData
}
```

- Capture the **main display** only (or the focused window via `CGWindowListCreateImage`)
- Resize to 720p and compress to JPEG — keep each screenshot under 100KB
- Privacy: screenshots are ephemeral. Send to worker, evaluate, discard. Never stored on disk or in D1.

### Evaluation Prompt

```
You are monitoring a user's screen during a timed unlock.

DECLARED INTENT: "{intent}"
DOMAIN UNLOCKED: "{domain}"
GRANT DURATION: {minutes} minutes
TIME ELAPSED: {elapsed} minutes

Look at this screenshot. Is the user doing what they declared?

Respond with JSON:
{
  "on_task": true/false,
  "confidence": 0.0-1.0,
  "observation": "brief description of what you see",
  "drift_type": null | "feed_scrolling" | "unrelated_content" | "different_site" | "idle"
}
```

Model: Haiku 4.5 (fast, cheap, vision-capable). ~$0.001 per screenshot evaluation.

### Escalation Ladder

| Stage | Trigger | Action |
|-------|---------|--------|
| 0 | On task | Silent. No overlay. |
| 1 | 1 off-task screenshot | Log but don't act (could be transient — loading page, switching tabs briefly). |
| 2 | 2 consecutive off-task | **Gentle overlay**: "Hey — you said you'd [intent]. Looks like you might be drifting. Back on track?" with choices: "I'm on it" / "Done, re-block" |
| 3 | 3 consecutive off-task (or 1 after warning dismissed) | **Firm overlay**: "You've been off-task for 30+ seconds. Revoking access in 60 seconds unless you return to [intent]." |
| 4 | 4+ consecutive off-task | **Revoke**: call `/api/grant/{domain}` DELETE (revoke), which triggers daemon kill connections + close tabs. Show overlay: "Access revoked. [intent] didn't happen." |

"Consecutive" means without an on-task screenshot in between.

### New Data Structures

**Vigilant session** (in-memory on worker, or D1 if persistence needed):

```typescript
interface VigilantSession {
  id: string;
  domain: string;
  intent: string;
  grantId: string;          // links to the allowance
  startedAt: number;
  expiresAt: number;
  screenshotCount: number;
  offTaskCount: number;      // consecutive
  totalOffTask: number;
  escalationLevel: number;   // 0-4
  status: 'active' | 'completed' | 'revoked';
}
```

### New API Endpoints

**monastic-os worker:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/vigilant/start` | POST | Start a vigilant session. Body: `{domain, intent, grantExpiresAt}` |
| `/api/vigilant/screenshot` | POST | Submit screenshot for evaluation. Body: multipart with JPEG. Returns `{on_task, observation, escalation_level}` |
| `/api/vigilant/status` | GET | Current session status |
| `/api/vigilant/end` | POST | End session (user completed task or grant expired) |

**cc-focus server** (modification):
- `POST /api/grant` gains optional `vigilant: true` + `intent: string` fields
- When vigilant grant is created, server (or Claude) also calls monastic-os `/api/vigilant/start`

### New MCP Tool

Add to cc-focus MCP or monastic-os MCP:

```typescript
server.tool(
  'focus_vigilant_grant',
  `Grant time-limited access with vigilant monitoring. The user must declare their specific intent.
Screenshots will be taken every ~10 seconds and evaluated. Access will be revoked if the user
drifts from their stated intent.`,
  {
    domain: z.string(),
    minutes: z.number().min(1).max(30),
    intent: z.string().describe('What the user specifically intends to do'),
    reason: z.string(),
  },
  async ({ domain, minutes, intent, reason }) => {
    // 1. Grant access via cc-focus
    // 2. Start vigilant session via monastic-os
    // 3. Agent begins screenshot loop
  }
);
```

### Agent-Side Implementation

New command type for monastic-os agent:

```json
{
  "type": "vigilant",
  "action": "start",
  "session_id": "...",
  "domain": "reddit.com",
  "intent": "Check r/swift top post about concurrency API",
  "interval_seconds": 10,
  "expires_at": "2026-02-12T10:30:00Z"
}
```

Agent behavior:
1. On receiving `vigilant:start` — begin screenshot timer (every N seconds)
2. Each tick: capture screen → POST to `/api/vigilant/screenshot`
3. If response says `escalation_level >= 2`: show warning overlay (non-blocking, corner notification or brief fullscreen)
4. If response says `escalation_level >= 4`: show revocation overlay, stop capturing
5. On `vigilant:end` or grant expiry: stop capturing

### Cost Estimate

At 10-second intervals for a 20-minute grant:
- 120 screenshots
- Haiku 4.5 vision: ~$0.001/image → ~$0.12 per session
- Bandwidth: 100KB × 120 = ~12MB upload

Acceptable for the value provided.

### Privacy

- Screenshots are never stored. Sent to worker → Claude API → response → discarded.
- No image data in D1. Only text observations stored (if any).
- Could add a "vigilant mode active" indicator in menu bar so the user always knows they're being monitored.

## Implementation Order

1. **Agent**: screenshot capture + upload loop (new command type `vigilant`)
2. **Worker**: `/api/vigilant/*` endpoints + Claude vision evaluation
3. **MCP tool**: `focus_vigilant_grant` wiring cc-focus grant + monastic-os vigilant
4. **Escalation overlays**: reuse existing overlay system with new warning templates
5. **Revocation hook**: on escalation level 4, call cc-focus `/api/grant/{domain}` DELETE

## Open Questions

- Should the user be able to "extend" a vigilant session if they're on-task and need more time? (Auto-extend if consistently on-task?)
- Should there be a summary at the end? "You spent 18/20 minutes on-task. 2 brief drifts."
- How aggressive should the interval be? 10s might feel invasive. 30s might miss short drifts. Maybe start at 15s?
- Should vigilant mode be opt-in (user chooses) or mandatory for certain domains?
