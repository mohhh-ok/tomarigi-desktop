// The shape of a Claude Code transcript line and the reads every part of the transcript parsing shares (see the header of
// lib/transcript.ts)

export interface TranscriptEntry {
  type?: string;
  // The session the line was written in. A transcript started as a fork begins with its parent's lines copied with the
  // parent's id (see isForeignLine)
  sessionId?: unknown;
  subtype?: unknown; // On a `system` line (e.g. away_summary, see isIdleLine)
  isMeta?: boolean;
  isSidechain?: boolean;
  turnOrigin?: unknown; // Who started the turn of a prompt ("human", "sdk", "host_synthetic", "peer", ...)
  interruptedByShutdown?: boolean;
  timestamp?: string;
  continuedInSessionId?: unknown; // On a `continued-in` line (see TailInfo.continuedIn)
  message?: { role?: string; content?: unknown };
  cwd?: unknown;
  entrypoint?: unknown; // Internal field on user/assistant/attachment/system lines. See the TailInfo.entrypoint comment
  content?: unknown; // Body of a queue-operation line (raw task-notification text, a string). Unused for other types
  // Execution metadata on tool_result entries. Used only for the chick completion signal
  // (collectChickSignals). isAsync:true means "async launch confirmation of the Agent tool", which comes
  // back right after launch with the same tool_use_id as the launching tool_use (confirmed on real data).
  // It is not a completion and must be excluded (otherwise a background chick is misjudged as "done" a few
  // seconds after launch)
  // backgroundTaskId is the task-id on the launch confirmation of a command started with run_in_background
  // (see TailInfo.backgroundTaskStarts)
  // scheduledFor / stopped are on a ScheduleWakeup result, id / nextFireAt / recurring on a CronCreate result, and taskId /
  // timeoutMs / persistent on a Monitor result (see TailInfo.wakes)
  toolUseResult?: {
    isAsync?: boolean;
    backgroundTaskId?: string;
    scheduledFor?: unknown;
    stopped?: unknown;
    id?: unknown;
    nextFireAt?: unknown;
    recurring?: unknown;
    taskId?: unknown;
    timeoutMs?: unknown;
    persistent?: unknown;
  };
  // Sender on the isMeta user line that received a cross-session message (kind: "peer" and name)
  // from is the sender's address; for a Claude desktop app session it is its local_… id (docs/design.md "Watching")
  origin?: { kind?: unknown; name?: unknown; from?: unknown };
  // Cross-session messages that arrive mid-work are recorded in an attachment (queued_command) with the same origin
  attachment?: { origin?: { kind?: unknown; name?: unknown; from?: unknown } };
}

export interface Block {
  type?: string;
  name?: string;
  text?: string;
  id?: string; // id of a tool_use block (a tool_result names it in tool_use_id)
  input?: unknown; // Input of a tool_use block (used by summarizeToolInput to build the input summary)
  tool_use_id?: string; // id of the tool_use a tool_result block answers. Used to match chick completion signals
}


/**
 * Whether a transcript line is another session's: its `sessionId` is a string other than the session's own. A
 * transcript started as a fork (a side chat, or a fork another session started) begins with a copy of its parent's
 * lines, which keep the parent's `sessionId`; nothing is read from them (docs/design.md "Side chats and forked sessions
 * of the Claude desktop app"). A line without `sessionId`, or a read without an own id, counts as own.
 * is_foreign_line in src-tauri is the same rule
 */
export function isForeignLine(entry: { sessionId?: unknown }, ownSessionId: string | undefined): boolean {
  return ownSessionId !== undefined && typeof entry.sessionId === "string" && entry.sessionId !== ownSessionId;
}


/** The text of a message's content: a string, or its text blocks joined by newlines (message_text in src-tauri) */
export function messageText(content: unknown): string {
  return typeof content === "string" ? content : asBlocks(content).map((b) => b.text ?? "").join("\n");
}

/** The text of a tool_result block's content */
export function toolResultText(block: Block): string {
  return messageText((block as { content?: unknown }).content);
}


export const TASK_NOTIFICATION_TAG = "<task-notification>";
const TASK_STATUS_TAG = "<status>";
const TASK_ID_PATTERN = /<task-id>([^<]+)<\/task-id>/;

/** The task-id of a <task-notification> text, and whether it carries a <status> (a monitor's events come without one) */
export function taskNotificationOf(text: unknown): { taskId: string; hasStatus: boolean } | undefined {
  if (typeof text !== "string" || !text.includes(TASK_NOTIFICATION_TAG)) return undefined;
  const taskId = text.match(TASK_ID_PATTERN)?.[1];
  return taskId ? { taskId, hasStatus: text.includes(TASK_STATUS_TAG) } : undefined;
}


export function parseTimestamp(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const at = Date.parse(timestamp);
  return Number.isNaN(at) ? null : at;
}


// Limit shared across TailEvent.text (used for both user utterances and tool_use input summaries)
export const TEXT_FIELD_LIMIT = 500;


export function asBlocks(content: unknown): Block[] {
  // When content comes as a plain string (a simple user utterance), fill in text too. Previously only type
  // was set and text was dropped, so the user utterance input (extractUserText) was always empty in
  // this case
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) return content as Block[];
  return [];
}
