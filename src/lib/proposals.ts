// The Claude desktop app's session proposal cards a session waits on the user to start (docs/design.md "The "?" for
// sessions waiting on you"). Doesn't depend on UI components or Tauri
import type { TurnProposals } from "./transcript";

/** A session linked to the one that proposed, as unstartedProposals sees it */
export interface ProposalChild {
  /** When its process started (sessions/<pid>.json), epoch ms */
  startedAt?: number;
  /** Its desktop app id (sessions/<pid>.json) */
  hostSessionId?: string;
  /** Its first prompt was written by the app for a session another session started (startedBySession in
   * lib/watching.ts, without whether the user typed in it since) */
  startedBySession: boolean;
}

/**
 * The proposal cards of the last turn the user hasn't started yet. A session started from a card is linked to the
 * session that proposed it from its first prompt (the starter's notes folder; docs/design.md "Watching"), but nothing
 * says which card it came from. So each linked session that was started by another session, started (its process) at or
 * after the turn's first card, and isn't one the turn's start_session calls started itself, counts as one card started,
 * oldest card first. Empty when the turn left no card or every card was started
 */
export function unstartedProposals(
  turn: TurnProposals | undefined,
  children: readonly ProposalChild[],
): TurnProposals["proposals"] {
  if (!turn || turn.proposals.length === 0) return [];
  const firstAt = Math.min(...turn.proposals.map((p) => p.at));
  const started = children.filter(
    (c) =>
      c.startedBySession &&
      c.startedAt !== undefined &&
      c.startedAt >= firstAt &&
      !(c.hostSessionId !== undefined && turn.startedHostIds.includes(c.hostSessionId)),
  ).length;
  return turn.proposals.slice(started);
}

/** The bubble's text and the concierge's question for a wait on proposal cards: their titles */
export function proposalQuestion(proposals: TurnProposals["proposals"]): string | undefined {
  const titles = proposals.map((p) => p.title).filter((t): t is string => !!t);
  return titles.length > 0 ? titles.join(" / ") : undefined;
}
