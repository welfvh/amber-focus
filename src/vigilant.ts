/**
 * Vigilant Mode — AI-powered screenshot monitoring during timed grants.
 *
 * When a grant is issued with vigilant=true and an intent string, this module
 * takes screenshots every 10 seconds and evaluates them via Claude Haiku to
 * determine if the user is on-task. If the user drifts, access is auto-revoked.
 *
 * Flow:
 *   1. startSession() → spawns a monitoring loop
 *   2. Every 10s: screencapture → base64 → Anthropic API (claude-haiku-4-5)
 *   3. If off-task: increment strike counter
 *   4. After 3 consecutive off-task evaluations: call onViolation() → revoke grant
 *   5. Log each evaluation to ~/.config/amber-focus/vigilant-log.json
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

const SCREENSHOT_DIR = '/tmp/amber-focus-vigilant';
const CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.config', 'amber-focus');
const LOG_FILE = path.join(CONFIG_DIR, 'vigilant-log.json');
const EVAL_INTERVAL_MS = 10_000;
const MAX_STRIKES = 3;

interface VigilantSession {
  id: string;
  domain: string;
  intent: string;
  grantExpiresAt: number;
  startedAt: number;
  evaluations: Evaluation[];
  consecutiveOffTask: number;
  timer: ReturnType<typeof setInterval> | null;
  onViolation: () => Promise<void>;
}

interface Evaluation {
  timestamp: number;
  onTask: boolean;
  reason: string;
  screenshotPath: string;
}

// Active sessions keyed by session ID
const sessions = new Map<string, VigilantSession>();

// Anthropic API key — fetched once at module load from Keychain
let anthropicApiKey: string | null = null;

/** Fetch the Anthropic API key from macOS Keychain. */
async function getApiKey(): Promise<string> {
  if (anthropicApiKey) return anthropicApiKey;

  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password', '-s', 'cc/anthropic', '-a', 'api_key', '-w',
    ]);
    anthropicApiKey = stdout.trim();
    return anthropicApiKey;
  } catch (err) {
    throw new Error('Failed to retrieve Anthropic API key from Keychain (cc/anthropic)');
  }
}

/** Capture a screenshot and return the file path. */
async function captureScreenshot(): Promise<string> {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  const filename = `vigilant-${Date.now()}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);

  await execFileAsync('screencapture', ['-x', filepath]);
  return filepath;
}

/** Evaluate a screenshot against the declared intent using Claude Haiku. */
async function evaluateScreenshot(
  screenshotPath: string,
  domain: string,
  intent: string,
): Promise<{ onTask: boolean; reason: string }> {
  const apiKey = await getApiKey();
  const imageData = fs.readFileSync(screenshotPath).toString('base64');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: `You are a focus monitor. The user was granted temporary access to ${domain} for the purpose of: "${intent}". Evaluate the screenshot. Is the user actually doing what they said they would? Be strict — browsing the feed, watching unrelated content, or doomscrolling counts as off-task even if the site is the granted domain. Reply ONLY with JSON: {"on_task": true/false, "reason": "brief explanation"}`,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: imageData,
              },
            },
            {
              type: 'text',
              text: 'Is the user on-task? Reply with JSON only.',
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`[vigilant] API error ${response.status}: ${body}`);
    // On API failure, assume on-task (don't punish for API issues)
    return { onTask: true, reason: 'API error — defaulting to on-task' };
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content?.[0]?.text || '';

  try {
    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        onTask: Boolean(parsed.on_task),
        reason: String(parsed.reason || 'no reason given'),
      };
    }
  } catch {
    console.error(`[vigilant] Failed to parse response: ${text}`);
  }

  // Fallback: if we can't parse, assume on-task
  return { onTask: true, reason: 'Could not parse evaluation — defaulting to on-task' };
}

/** Append an evaluation to the persistent log. */
function logEvaluation(sessionId: string, evaluation: Evaluation & { sessionId: string; domain: string; intent: string }): void {
  try {
    let log: unknown[] = [];
    if (fs.existsSync(LOG_FILE)) {
      log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    }
    log.push(evaluation);
    // Keep only last 200 entries
    if (log.length > 200) log = log.slice(-200);
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error('[vigilant] Failed to write log:', err);
  }
}

/** Clean up old screenshots (keep last 10 minutes). */
function cleanupScreenshots(): void {
  try {
    if (!fs.existsSync(SCREENSHOT_DIR)) return;
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const file of fs.readdirSync(SCREENSHOT_DIR)) {
      const filepath = path.join(SCREENSHOT_DIR, file);
      const stat = fs.statSync(filepath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filepath);
      }
    }
  } catch {}
}

/** Start a vigilant monitoring session. */
export function startSession(
  domain: string,
  intent: string,
  grantExpiresAt: number,
  onViolation: () => Promise<void>,
): string {
  const id = randomUUID();

  const session: VigilantSession = {
    id,
    domain,
    intent,
    grantExpiresAt,
    startedAt: Date.now(),
    evaluations: [],
    consecutiveOffTask: 0,
    timer: null,
    onViolation,
  };

  sessions.set(id, session);

  console.log(`[vigilant] Session ${id} started for ${domain} (intent: "${intent}")`);

  // Start the monitoring loop
  session.timer = setInterval(async () => {
    // Stop if grant has expired (server handles reblock, we just stop monitoring)
    if (Date.now() >= session.grantExpiresAt) {
      stopSession(id);
      return;
    }

    try {
      const screenshotPath = await captureScreenshot();
      const result = await evaluateScreenshot(screenshotPath, domain, intent);

      const evaluation: Evaluation = {
        timestamp: Date.now(),
        onTask: result.onTask,
        reason: result.reason,
        screenshotPath,
      };

      session.evaluations.push(evaluation);

      // Log to persistent file
      logEvaluation(id, {
        ...evaluation,
        sessionId: id,
        domain,
        intent,
      });

      if (result.onTask) {
        session.consecutiveOffTask = 0;
        console.log(`[vigilant] ${id}: ON-TASK — ${result.reason}`);
      } else {
        session.consecutiveOffTask++;
        console.log(`[vigilant] ${id}: OFF-TASK (${session.consecutiveOffTask}/${MAX_STRIKES}) — ${result.reason}`);

        if (session.consecutiveOffTask >= MAX_STRIKES) {
          console.log(`[vigilant] ${id}: VIOLATION — revoking access to ${domain}`);
          stopSession(id);
          await session.onViolation();
        }
      }

      // Periodic cleanup
      cleanupScreenshots();
    } catch (err) {
      console.error(`[vigilant] ${id}: evaluation error:`, err);
    }
  }, EVAL_INTERVAL_MS);

  return id;
}

/** Stop a vigilant monitoring session. */
export function stopSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.timer) {
    clearInterval(session.timer);
    session.timer = null;
  }

  console.log(`[vigilant] Session ${sessionId} stopped (${session.evaluations.length} evaluations)`);
  sessions.delete(sessionId);
}

/** Stop all sessions for a given domain (used when grant is revoked). */
export function stopSessionsForDomain(domain: string): void {
  for (const [id, session] of sessions) {
    if (session.domain === domain) {
      stopSession(id);
    }
  }
}

/** Get status of the current vigilant session(s). */
export function getStatus(): {
  active: boolean;
  sessions: Array<{
    id: string;
    domain: string;
    intent: string;
    startedAt: number;
    evaluations: number;
    consecutiveOffTask: number;
    lastEvaluation: Evaluation | null;
  }>;
} {
  const sessionList = Array.from(sessions.values()).map(s => ({
    id: s.id,
    domain: s.domain,
    intent: s.intent,
    startedAt: s.startedAt,
    evaluations: s.evaluations.length,
    consecutiveOffTask: s.consecutiveOffTask,
    lastEvaluation: s.evaluations.length > 0 ? s.evaluations[s.evaluations.length - 1] : null,
  }));

  return {
    active: sessionList.length > 0,
    sessions: sessionList,
  };
}

/** Get recent evaluations from the persistent log. */
export function getRecentLog(count: number = 20): unknown[] {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    return Array.isArray(log) ? log.slice(-count) : [];
  } catch {
    return [];
  }
}
