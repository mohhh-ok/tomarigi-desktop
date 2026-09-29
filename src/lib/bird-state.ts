// Machine state of a bird (BirdState) from its transcript tail
import type { TailInfo } from "./transcript";
import type { BirdState, ChickView } from "./session-types";

const WRITING_MS = 6_000; // recent write = working
const DOZE_MS = 5 * 60_000; // dozing once this long has passed since done
// Idle time before a chick's assistant_text tail is treated as done, as a fallback when the parent ledger
// (chickSignals) has no signal. The harmless pauses observed in real data ("wrote only text for a moment
// while working") were 36 seconds, and could exceed 60 seconds with long thinking, so we use 2 minutes, well
// above that (with a signal, done is set immediately without going through this value; see deriveState).
// If it still stays false (no notification, the chick died silently), eventually the existing
// CHICK_ABANDONED_MS (10 minutes, releases suppression in deriveDoneEvent) applies separately and treats it
// as an abandoned chick
const CHICK_TEXT_DONE_MS = 2 * 60_000;

// Urgency order of BirdState (smaller = more urgent). Both the views sort (end of scanSessions) and
// escalateWithChicks (parent escalation) use the same order, so it is defined once here and shared
export const STATE_URGENCY: Record<BirdState, number> = { waiting: 0, working: 1, done: 2, dozing: 3 };

/**
 * Escalates the parent's display state to the most urgent of the parent's own state and its chicks' states.
 * A parent with a running chick is not put to sleep (it keeps its awake sprite), and
 * a parent whose chick just finished is woken up to done (actual problem: parent shown dozing next to a chick
 * done 10 seconds ago). Only dozing chicks are excluded — chicks themselves also fall from done → dozing when
 * left alone, so this gives a natural decay: "the parent wakes up only right after completion, and goes back
 * to sleep if left alone".
 */
export function escalateWithChicks(state: BirdState, chicks: ChickView[]): BirdState {
  let escalated = state;
  for (const chick of chicks) {
    if (chick.state === "dozing") continue;
    if (STATE_URGENCY[chick.state] < STATE_URGENCY[escalated]) escalated = chick.state;
  }
  return escalated;
}

export function isWaitingTool(toolName: string | undefined): boolean {
  return (
    toolName === "AskUserQuestion" ||
    toolName === "ExitPlanMode" ||
    toolName === "request_user_input"
  );
}

/**
 * chickDoneSignalAt: a chick's done/dozing check treats the parent ledger (chickSignals taken from
 * queue-operation/tool_result in the parent transcript, resolved by resolveChickDoneSignalAt in the caller
 * scanChicks) as the source of truth, not the tail's appearance (kind). This is the fix for an actual problem:
 * at the moment a chick briefly writes only text without a tool_use in between, tail.kind looks like
 * "assistant_text" while the work is actually still continuing, and trusting that appearance as input for
 * releasing the parent's done suppression would release it wrongly. The parent itself avoids this ambiguity by
 * looking ahead at the next event in deriveSessionEvents, but a chick's tail has no such mechanism, so the
 * "definite signal observed by the parent" is used as the source instead. Only when there is no signal
 * (notification not yet arrived, harness notification bug, the chick died silently) is done estimated from
 * the tail's appearance via the CHICK_TEXT_DONE_MS fallback below.
 */
export function deriveState(
  tail: TailInfo,
  sinceMs: number,
  isChick: boolean,
  chickDoneSignalAt?: number,
): BirdState {
  // A session closed by /clear, interrupt, or shutdown. Checked before elapsed time so that a write right
  // after it doesn't make it look "working". The local fact that the chick's own transcript was closed is
  // stronger information than the parent ledger's (possibly stale) signal, so it takes priority
  if (tail.kind === "closed") return "dozing";
  // Stopped on a question tool for the user. Waiting for a reply regardless of recent writes
  if (!isChick && tail.kind === "tool_use" && isWaitingTool(tail.toolName)) return "waiting";
  // Chick-only priority check: if the parent ledger has a definite signal, return done/dozing regardless of
  // the tail's appearance (kind) (see the comment above). Checked before the sinceMs < WRITING_MS early return —
  // with a signal, the guess "there was a recent write, so it is working" no longer holds
  if (isChick && chickDoneSignalAt !== undefined) {
    return sinceMs >= DOZE_MS ? "dozing" : "done";
  }
  if (sinceMs < WRITING_MS) return "working";
  switch (tail.kind) {
    case "tool_use":
      // While a tool runs it is working regardless of how long it is idle (guessing a pending permission prompt was removed)
      return "working";
    case "assistant_text":
      if (isChick) {
        // Fallback when the parent ledger has no signal (see the comment above). The tail's appearance alone
        // can't tell "really finished" from "briefly wrote only text without a tool_use in between", so it is
        // done/dozing only when there has been no write for longer than CHICK_TEXT_DONE_MS, and until then it
        // stays working and suppression continues (this is the fix for the bug itself)
        return sinceMs >= CHICK_TEXT_DONE_MS ? (sinceMs >= DOZE_MS ? "dozing" : "done") : "working";
      }
      return sinceMs >= DOZE_MS ? "dozing" : "done";
    case "user":
    case "tool_result":
      // Waiting for the assistant's next output. Judging "stuck" by how long it waits produced only false
      // positives, so it was removed (formerly stalled). Always working
      return "working";
    default:
      // Of the TailKind variants, closed already returned early at the top of this function, and
      // tool_use/assistant_text/user/tool_result are handled by the cases above, so only "unknown" gets here
      // (the case where readTail's window, even widened to MAX_TAIL_BYTES, found no line with a timestamp;
      // see the MAX_TAIL_BYTES comment in lib/transcript.ts).
      // unknown has no basis for "finished" (it just couldn't be read), so it doesn't go through done —
      // that would be a source of false done events and chirps, so it stays working while writes are recent,
      // and returns only dozing once past DOZE_MS.
      // Note: for unknown, the caller's sinceMs comes from the mtime fallback (no lastEventAt). The mtime
      // dependency removed in 10f0aa5 remains only in this branch, but it is accepted because reaching it is
      // limited to the extreme case of "zero timestamp lines even in a 2MB window".
      return sinceMs >= DOZE_MS ? "dozing" : "working";
  }
}

/**
 * Dedicated state check for showing sessions started via the SDK (Claude Agent SDK) as "chicks".
 * deriveState(isChick=true) is not reused as-is, because of a difference in premises confirmed in real data:
 *
 * deriveState's isChick fallback (CHICK_TEXT_DONE_MS) only switches to the time basis when
 * tail.kind === "assistant_text", and always returns working when tail.kind is "user"/"tool_result".
 * This relies on the premise that "a real subagent started by the Task tool always ends with assistant_text
 * right before stopping, since Task's return value is the assistant's text".
 *
 * That premise doesn't hold for SDK sessions. The Claude Agent SDK has a pattern of ending the conversation
 * with a structured output tool, in which case the last classifiable line of the transcript stays stuck at
 * tool_result (confirmed in real data, 2026-08-08: the last classified line within the tail window of an SDK
 * session's transcript is tool_result).
 *
 * In addition, SDK chicks structurally have no completion signal from the parent ledger (chickSignals)
 * (chickDoneSignalAt is always undefined; it is a mechanism via queue-operation/tool_result on the parent
 * transcript side, so it doesn't appear in the SDK session's own tail). Using deriveState as-is with no signal
 * override would keep an SDK chick ending on tool_result stuck in working for as long as its process lives,
 * keep the parent looking working via escalateWithChicks, and also wrongly feed into
 * deriveDoneEvent's suppression check (CHICK_ABANDONED_MS=10 minutes).
 *
 * So every idle state other than a running tool_use (kind==="tool_use") is brought under the
 * CHICK_TEXT_DONE_MS fallback (assistant_text/user/tool_result treated alike). tool_use, closed, and unknown
 * (default) are handled the same as in deriveState.
 *
 * Also used for the state check of orphans (orphanSdkEntries, SDK sessions with no parent candidate that fell
 * back to adult display) (the withTail loop in scanSessions, isSdk branch). Orphans look like "adult birds" but
 * are actually SDK sessions, and the problem of getting stuck in working when ending on tool_result isn't
 * solved by deriveState, so this is used for adult display too.
 */
export function deriveSdkChickState(tail: TailInfo, sinceMs: number): BirdState {
  if (tail.kind === "closed") return "dozing";
  if (sinceMs < WRITING_MS) return "working";
  switch (tail.kind) {
    case "tool_use":
      return "working";
    case "assistant_text":
    case "user":
    case "tool_result":
      return sinceMs >= CHICK_TEXT_DONE_MS ? (sinceMs >= DOZE_MS ? "dozing" : "done") : "working";
    default:
      // Doesn't go through done, for the same reason as deriveState's default branch (unknown = the tail
      // window just couldn't be read; no basis for "finished"). See the MAX_TAIL_BYTES comment in
      // lib/transcript.ts and the comment on deriveState's default branch.
      return sinceMs >= DOZE_MS ? "dozing" : "working";
  }
}
