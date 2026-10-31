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
 * Whether the session's work goes on after its turn (a fact for the concierge). A watching session (a linked session
 * moves, or moved within the grace period) is continuing whatever its reply says; otherwise it is the turn verdict's
 * continuing, absent when there is none (docs/design.md "Turn verdicts")
 */
export function sessionContinuing(verdict: boolean | undefined, watching: number | undefined): boolean | undefined {
  return watching !== undefined ? true : verdict;
}

/** Whether to put the anger mark on the bird */
export function isAngry(s: SessionView): boolean {
  return s.angry === true;
}
