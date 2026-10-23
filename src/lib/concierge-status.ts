// The Concierge tab's bubble (docs/design.md "Concierge"): a line per session built by the app from facts it already has,
// rebuilt on every poll so it never goes out of date and costs no request, and the suggestions that come with the
// advice (askConcierge with suggestions), dimmed with their session's state now once it changed
import type { ConciergeSuggestion } from "./concierge";
import type { SessionView } from "./session-types";
import { needsAnswer } from "./turn-verdict";

// At most this many lines are shown; the rest is counted, and the ones cut are working ones first (Claude's own
// decision: the bubble stays readable in a 260px window)
export const MAX_STATUS_LINES = 6;

/** Where a session stands, from the app's facts: needs a reply, finished (done or dozing, and not continuing in the
    background), or working */
export type ConciergeStatus = "reply" | "done" | "working";

export function conciergeStatusOf(view: SessionView): ConciergeStatus {
  if (needsAnswer(view.state, view.ask)) return "reply";
  return (view.state === "done" || view.state === "dozing") && !view.continuing ? "done" : "working";
}

/** A line of the bubble: the session, its name, its text (absent when the app has none for it) and its state */
export interface StatusLine {
  sessionId: string;
  name: string;
  text?: string;
  status: ConciergeStatus;
}

/**
 * Every session's line, in order: needs a reply (the longest waiting first), then finished (the most recently finished
 * first), then working (in the order given). The text is the speech bubble's text (bubbleOf: the question for one that
 * waits on a question tool, the turn's summary line for a stopped one) for one that needs a reply or finished, and the
 * current tool for one working; a finished turn that goes on in the background (continuing) has no tool, so it shows its
 * line (Claude's own decision). At most MAX_STATUS_LINES; more is how many were cut
 */
export function conciergeStatusLines(
  views: SessionView[],
  bubbleOf: (view: SessionView) => string | undefined,
): { lines: StatusLine[]; more: number } {
  const place = (v: SessionView, status: ConciergeStatus): [number, number] =>
    status === "reply" ? [0, -v.sinceMs] : status === "done" ? [1, v.sinceMs] : [2, 0];
  const all = views.map((v) => {
    const status = conciergeStatusOf(v);
    const raw = status === "working" ? (v.toolName ?? bubbleOf(v)) : bubbleOf(v);
    const text = raw?.replace(/\s+/g, " ").trim();
    return { line: { sessionId: v.id, name: v.project, ...(text && { text }), status }, at: place(v, status) };
  });
  // Array.prototype.sort is stable, so working ones keep the order given
  all.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);
  return {
    lines: all.slice(0, MAX_STATUS_LINES).map((e) => e.line),
    more: Math.max(0, all.length - MAX_STATUS_LINES),
  };
}

/** Suggestions as kept until the next answer: each with its session's display name and state when it came */
export interface ShownSuggestion extends ConciergeSuggestion {
  name: string;
  status: ConciergeStatus;
}

/** Each session's state when an answer with suggestions came, to tell later whether they are still up to date */
export function statusesAt(views: SessionView[]): Map<string, ConciergeStatus> {
  return new Map(views.map((v) => [v.id, conciergeStatusOf(v)]));
}

/**
 * Whether the suggestions at hand need asking again when the Concierge tab is opened: none came yet (answeredAt
 * undefined), or a session changed state, came, or left since they came. Only the state counts, so a new tool line or
 * time passing doesn't (docs/design.md "Concierge")
 */
export function suggestionsOutdated(answeredAt: ReadonlyMap<string, ConciergeStatus> | undefined, views: SessionView[]) {
  if (!answeredAt) return true;
  if (answeredAt.size !== views.length) return true;
  return views.some((v) => answeredAt.get(v.id) !== conciergeStatusOf(v));
}

/** The suggestions of an answer with their sessions' states then. One whose session isn't on screen is left out */
export function suggestionsAt(suggestions: ConciergeSuggestion[], views: SessionView[]): ShownSuggestion[] {
  return suggestions.flatMap((s) => {
    const view = views.find((v) => v.id === s.sessionId);
    return view ? [{ ...s, name: view.project, status: conciergeStatusOf(view) }] : [];
  });
}

/** What a suggestion's session is now: null while it is as it was when the suggestion came, its state now when that
    changed, or gone when it left the screen. No new request is made for it */
export function suggestionNow(s: ShownSuggestion, views: SessionView[]): ConciergeStatus | "gone" | null {
  const view = views.find((v) => v.id === s.sessionId);
  if (!view) return "gone";
  const now = conciergeStatusOf(view);
  return now === s.status ? null : now;
}
