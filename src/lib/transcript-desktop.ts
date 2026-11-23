import type { ProposalTrace, TailEvent } from "./transcript";
import { TEXT_FIELD_LIMIT, toolResultText, type Block } from "./transcript-entry";
// The Claude desktop app's records in a transcript: the question a turn ends on and the session proposal cards
// (docs/design.md "The "?" for sessions waiting on you")

/** A text shown on one line (a wrap_up's ask, a card's title): whitespace folded, first TEXT_FIELD_LIMIT characters */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TEXT_FIELD_LIMIT);
}

/** The tool with which a Claude desktop app session ends its turn: the app shows its `recap`, and its `ask` (the one
    question it leaves the user, with buttons) in a box; `blocked` says the work stops until the user answers */
export const DESKTOP_WRAP_UP_TOOL = "mcp__ccd_turn__wrap_up";

/**
 * Whether a tool call asks the user to decide before the session goes on (docs/design.md "The "?" for sessions
 * waiting on you"): the desktop app's wrap_up with an `ask` that isn't blank, or with `blocked: true`. The desktop app
 * puts its question there, not in the reply's text. question is the `ask`, first 500 characters
 */
export function desktopAskOf(toolName: string | undefined, input: unknown): { question?: string } | undefined {
  if (toolName !== DESKTOP_WRAP_UP_TOOL || typeof input !== "object" || input === null) return undefined;
  const { ask, blocked } = input as { ask?: unknown; blocked?: unknown };
  const question = typeof ask === "string" ? oneLine(ask) : "";
  if (!question && blocked !== true) return undefined;
  return question ? { question } : {};
}

/**
 * The ask the session's last turn ended on, while nothing has moved since: the newest tool call that asks
 * (desktopAskOf), with only the reply's text and tool results after it. A message (from the user or anything else that
 * starts a turn), a closing, or another tool call after it means the session went on
 */
export function pendingAskOf(events: readonly TailEvent[]): { question?: string; at: number } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "assistant_text" || e.kind === "tool_result") continue;
    return e.kind === "tool_use" && e.ask ? { ...e.ask, at: e.at } : undefined;
  }
  return undefined;
}

/** The desktop app's tools that start a session and withdraw a proposal */
export const START_SESSION_TOOL = "mcp__ccd_session__start_session";
const DISMISS_TASK_TOOL = "mcp__ccd_session__dismiss_task";
// The text of start_session's result for a proposal card: `Proposed "<title>" (task_id: task_…)`
const PROPOSED_CARD = /^Proposed "([\s\S]*?)" \(task_id: (task_[0-9A-Za-z]+)\)/;

/** The proposal a tool call settles: dismiss_task withdraws its task_id; start_session with a proposal_id starts it */
export function settledProposalOf(toolName: string | undefined, input: unknown): string[] {
  const { task_id, proposal_id } = (typeof input === "object" && input !== null ? input : {}) as {
    task_id?: unknown;
    proposal_id?: unknown;
  };
  if (toolName === DISMISS_TASK_TOOL && typeof task_id === "string" && task_id) return [task_id];
  if (toolName === START_SESSION_TOOL && typeof proposal_id === "string" && proposal_id) return [proposal_id];
  return [];
}

/** The proposal cards the start_session results in one line show (ProposalTrace's proposed) */
export function proposalResultsOf(blocks: Block[], startSessionCalls: ReadonlySet<string>): ProposalTrace | undefined {
  const proposed: { taskId: string; title?: string }[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_result" || !block.tool_use_id || !startSessionCalls.has(block.tool_use_id)) continue;
    const card = toolResultText(block).match(PROPOSED_CARD);
    if (!card) continue;
    const title = oneLine(card[1]);
    proposed.push({ taskId: card[2], ...(title && { title }) });
  }
  return proposed.length > 0 ? { proposed } : undefined;
}

/** The desktop app's proposal cards the last turn left, not yet settled within it (pendingProposalsOf) */
export interface TurnProposals {
  proposals: { taskId: string; title?: string; at: number }[];
}

/**
 * The proposal cards (docs/design.md "The "?" for sessions waiting on you") the last turn made and didn't withdraw or
 * start itself. A turn starts at a prompt (kind user, from the user or anything else) or
 * a closing; only what came after the last one counts. undefined when it left none
 */
export function pendingProposalsOf(events: readonly TailEvent[]): TurnProposals | undefined {
  let turnStart = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "user" || events[i].kind === "closed") {
      turnStart = i + 1;
      break;
    }
  }
  const proposals: TurnProposals["proposals"] = [];
  for (const e of events.slice(turnStart)) {
    for (const p of e.proposal?.proposed ?? []) proposals.push({ ...p, at: e.at });
    for (const taskId of e.proposal?.settled ?? []) {
      const i = proposals.findIndex((p) => p.taskId === taskId);
      if (i >= 0) proposals.splice(i, 1);
    }
  }
  return proposals.length > 0 ? { proposals } : undefined;
}
