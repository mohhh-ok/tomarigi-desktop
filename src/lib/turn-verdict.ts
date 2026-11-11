// The "?" and the anger mark on a bird, from the machine state and the turn verdict that comes with the speech bubble
// summary (docs/design.md "The "?" for sessions waiting on you", "Anger mark for abuse toward the AI", "Turn verdicts").
// The request itself is summarizeTurn in lib/summarize.ts
import type { AskJudgement, BirdState, SessionView } from "./session-types";

/**
 * Where a session's need for an answer comes from: the machine state waiting (a question tool, a permission prompt),
 * or the turn verdict of a stopped (done / dozing) turn asking. undefined when it needs none (docs/design.md
 * "Concierge")
 */
export function replyWaitSource(state: BirdState, ask: AskJudgement | undefined): "machine" | "verdict" | undefined {
  if (state === "waiting") return "machine";
  return (state === "done" || state === "dozing") && ask?.status === "asking" ? "verdict" : undefined;
}

/** Whether to show the "?". When the machine state is waiting, or the turn verdict of a stopped (done / dozing) turn is asking */
export function needsAnswer(state: BirdState, ask: AskJudgement | undefined): boolean {
  return replyWaitSource(state, ask) !== undefined;
}

/**
 * Whether a parent that takes the session over can answer its wait (docs/design.md "Watching", "Sessions started by
 * another session"): a reply that asks (verdict) or the desktop app's wrap_up ask (wrapUpAsk) reach the parent as the
 * session's report. A question tool or a permission prompt (machine) doesn't: only the user can answer it, in its pane
 */
export function parentCanAnswer(source: "machine" | "verdict", wrapUpAsk: boolean | undefined): boolean {
  return source === "verdict" || wrapUpAsk === true;
}

/**
 * Whether the session waits on the developer's reply, as the concierge and its tab count it: it needs an answer
 * (replyWaitSource), and no parent that takes it over (SessionView.parentTakesOver) can answer it (parentCanAnswer).
 * Its bird gets the "?" either way (hasQuestion)
 */
export function waitsOnDeveloper(s: Pick<SessionView, "state" | "ask" | "parentTakesOver" | "wrapUpAsk">): boolean {
  const source = replyWaitSource(s.state, s.ask);
  return source !== undefined && !(s.parentTakesOver && parentCanAnswer(source, s.wrapUpAsk));
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

/**
 * The session with its turn verdict attached: the "?" (ask), the speech bubble line, and continuing (sessionContinuing,
 * with continuingExpired when it expired). Only the verdict of the reply's turn is given (turn); what the source set
 * directly (mock) isn't overwritten, and continuing it wrote doesn't expire. Rebuilt on every poll
 */
export function withTurnVerdict(
  s: SessionView,
  turn: { ask?: AskJudgement; line?: string; continuing?: boolean } | undefined,
): SessionView {
  const derived =
    s.continuing !== undefined
      ? { continuing: s.continuing, expired: false }
      : sessionContinuing(turn?.continuing, s.watching, s.sinceMs);
  const { continuing } = derived;
  const expired = derived.expired ? { continuingExpired: true as const } : {};
  if (!s.reply) return continuing === undefined ? s : { ...s, continuing, ...expired };
  return {
    ...s,
    ask: s.ask ?? turn?.ask,
    summary: s.summary ?? turn?.line,
    continuing,
    ...expired,
  };
}

/** Whether to put the anger mark on the bird */
export function isAngry(s: SessionView): boolean {
  return s.angry === true;
}
