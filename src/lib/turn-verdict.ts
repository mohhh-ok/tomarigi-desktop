// The "?" and the anger mark on a bird, from the machine state and the turn verdict that comes with the speech bubble
// summary (docs/design.md "The "?" for sessions waiting on you", "Anger mark for abuse toward the AI", "Turn verdicts").
// The request itself is summarizeTurn in lib/summarize.ts
import type { AskJudgement, BirdState, SessionView } from "./session-types";

/** Whether to show the "?". When the machine state is waiting, or the turn verdict of a stopped (done / dozing) turn is asking */
export function needsAnswer(state: BirdState, ask: AskJudgement | undefined): boolean {
  if (state === "waiting") return true;
  return (state === "done" || state === "dozing") && ask?.status === "asking";
}

/**
 * Whether to put a "?" on the bird. Only birds actually asking (needsAnswer). Watching birds don't get one even if the other session is asking
 * (docs/design.md "Watching")
 */
export function hasQuestion(s: SessionView): boolean {
  return needsAnswer(s.state, s.ask);
}

/**
 * How long continuing from the reply's text holds after the session last wrote to its transcript. Past it the session
 * counts as finished, so the concierge can suggest checking its result (docs/design.md "Turn verdicts"; the user: 「30min」)
 */
export const TEXT_CONTINUING_EXPIRES_MS = 30 * 60_000;

/**
 * Whether the session's work goes on after its turn (a fact for the concierge). A watching session (a linked session
 * moves, or moved within the grace period) is continuing whatever its reply says; otherwise it is the turn verdict's
 * continuing, absent when there is none. continuing from the verdict (the reply's text) expires
 * TEXT_CONTINUING_EXPIRES_MS after the last write (sinceMs): then continuing is false and expired is true, so the app
 * log can tell it from a verdict of no (docs/design.md "Turn verdicts"). Rebuilt on every poll, so it expires as time
 * passes, without a new write
 */
export function sessionContinuing(
  verdict: boolean | undefined,
  watching: number | undefined,
  sinceMs: number,
): { continuing: boolean | undefined; expired: boolean } {
  if (watching !== undefined) return { continuing: true, expired: false };
  if (verdict === true && sinceMs >= TEXT_CONTINUING_EXPIRES_MS) return { continuing: false, expired: true };
  return { continuing: verdict, expired: false };
}

/** Whether to put the anger mark on the bird */
export function isAngry(s: SessionView): boolean {
  return s.angry === true;
}
