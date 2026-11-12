// The Claude desktop app's session proposal cards a session waits on the user to start (docs/design.md "The "?" for
// sessions waiting on you"). Doesn't depend on UI components or Tauri
import type { TurnProposals } from "./transcript";

/** How a started card is remembered: the proposing session (its view id) and the card's task id */
export function cardKey(viewId: string, taskId: string): string {
  return `${viewId}\n${taskId}`;
}

/**
 * The proposal cards of the last turn the user hasn't started yet. A card is started when the desktop app's record of
 * a session says it was started from it (`spawnedFrom`: the proposing session's id and the card's task id; read by
 * desktop_started_cards in src-tauri, remembered as cardKey in started). The record stays after that session ends and
 * across restarts of this app. viewId: the proposing session
 */
export function unstartedProposals(
  turn: TurnProposals | undefined,
  viewId: string,
  started: ReadonlySet<string>,
): TurnProposals["proposals"] {
  if (!turn) return [];
  return turn.proposals.filter((p) => !started.has(cardKey(viewId, p.taskId)));
}

/** The bubble's text and the concierge's question for a wait on proposal cards: their titles */
export function proposalQuestion(proposals: TurnProposals["proposals"]): string | undefined {
  const titles = proposals.map((p) => p.title).filter((t): t is string => !!t);
  return titles.length > 0 ? titles.join(" / ") : undefined;
}
