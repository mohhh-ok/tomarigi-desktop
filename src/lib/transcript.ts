import type { NativeFile } from "./native-fs";
// Reads Claude Code transcripts (~/.claude/projects/<slug>/<sessionId>.jsonl).
// The format is a Claude Code internal detail and can change without notice, so parsing is
// confined to this file. Codex is converted to the same TailInfo by a separate adapter in
// lib/codex-transcript.ts.

export type TailKind =
  | "user"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "closed"
  | "unknown";

export interface TailInfo {
  kind: TailKind;
  toolName?: string;
  events: TailEvent[];
  cwd?: string; // Last cwd found in the tail window (primary source for the display name; falls back to projectLabels if absent)
  // Max epoch ms over lines in the tail window whose timestamp parses (independent of classify()'s result;
  // includes line types not used for state, such as last-prompt and queue-operation). undefined if there
  // are none. It does not move for lines without a timestamp (last-prompt etc.) or for after-the-fact
  // appends that only bump the file mtime (a known behavior where the harness touches a dead transcript
  // hours later). State decisions (sinceMs) always use this as the time basis, never mtime — with mtime,
  // ended sessions actually reappeared as "working birds" after every such append, and this prevents that
  lastEventAt?: number;
  // Evidence for whether the session was started via the SDK (Claude Agent SDK). Picked up from the
  // internal field on user/assistant/attachment/system lines in the tail window, updated with the last
  // value found (same approach as cwd). It used to be read from user lines only, but `claude -p` has
  // just one user line at the top, so in transcripts around 150KB it fell outside the 64KB tail window
  // and could not be read (2026-09-25. No example of mixed values within one file in the latest 300 files).
  // Values confirmed on real data: interactive (cli) start is "cli", start via the Claude Agent SDK
  // (Python) is "sdk-py", `claude -p` is "sdk-cli". The TS SDK is presumed to be "sdk-ts" or similar,
  // so the caller (lib/sessions.ts) matches /^sdk/ rather than an exact value (only "sdk-cli" is
  // excluded from display).
  // The entrypoint field is internal and version-dependent (see docs/last-prompt-ghost.md; there is a
  // precedent where an assumption broke with the last-prompt record). If no line in the tail window has
  // entrypoint, it stays undefined = the caller treats it as cli (adult) (safe-side fallback)
  entrypoint?: string;
  // Definitive signals found in the parent transcript that a chick (subagent) has "stopped".
  // key is the chick's identifier (the task-id of a task-notification, or the id of the launching
  // tool_use = toolUseId in meta.json), value is the latest timestamp (epoch ms) the signal was seen.
  // The parent can resume a chick with the same task-id; then writes resume in the same jsonl and this
  // signal can appear multiple times with the same task-id, so it is always overwritten with the latest
  // value (scanChicks in lib/sessions.ts detects a resume by checking whether the chick's last
  // conversation time (lastEventAt) has advanced after the signal, and invalidates the signal if so).
  // It is computed with the same logic when reading a chick's own transcript (includeSidechain:true),
  // but it is only actually used for the parent tail (see deriveState/scanChicks in lib/sessions.ts).
  chickSignals: Map<string, number>;
  // Launch records of background tasks the parent started with run_in_background (Bash etc.; the same
  // from the parent's view even if the content is `claude -p`). key is the task-id
  // (toolUseResult.backgroundTaskId), value is the time of the tool_result confirming the launch.
  // Completion arrives in chickSignals as a <task-notification> with the same task-id. Launch lines leave
  // the tail window within tens of seconds, so the ledger is kept across scans by lib/sessions.ts
  // (backgroundTaskCache)
  backgroundTaskStarts: Map<string, number>;
  // Names of the peers exchanged with via cross-session messages (Claude Code's cross-session messaging).
  // On the sending side it is the recipient of the SendMessage tool call (input.to); on the receiving side
  // it is origin.name on the isMeta user line (or <cross-session-message from-name="…"> in the body if
  // absent). The value is the latest time of that trace. So it doesn't vanish when it leaves the tail
  // window, lib/sessions.ts (peerNameCache) keeps it across scans.
  // Used to decide the link for watching (docs/design.md "Watching")
  peerNames: Map<string, number>;
  // The session was handed over to another session (a `continued-in` line naming continuedInSessionId, written
  // when Claude Code moves the conversation to a background process). The old process can stay alive after
  // this, so lib/sessions.ts removes the bird as if the session had ended. Cleared if a user/assistant line
  // follows it (the conversation went on here after all)
  continuedIn?: string;
}

// Classified lines, in time order. Only for reconstructing transition events (experimental feature)
export interface TailEvent {
  at: number; // epoch ms
  kind: TailKind;
  toolName?: string;
  // What text holds depends on kind:
  // - kind === "user": the user's utterance text (first 500 chars, TEXT_FIELD_LIMIT). Input for the
  //   event feed snippet (pickSnippet/formatSnippet in lib/sessions.ts)
  // - kind === "tool_use": a summary of the tool_use input (JSON.stringify, first 500 chars). Currently
  //   has no direct consumer (formerly the input for the permission-wait check, removed along with the
  //   LLM judgment feature. Still collected for display and future debugging)
  // - kind === "assistant_text": the assistant's text blocks concatenated (last 2000 chars,
  //   ASSISTANT_TEXT_LIMIT). It is the input for the done readout summary (lib/summarize.ts) and the
  //   last-sentence fallback readout (lib/voice.ts), so the tail end, where the conclusion is written, is kept
  text?: string;
  // kind === "user" only: the line says it didn't come from a person (origin.kind other than "human", such as
  // task-notification). Such lines still move the state, but are not judged as the user's message (anger mark)
  machine?: boolean;
}

interface TranscriptEntry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
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
  toolUseResult?: { isAsync?: boolean; backgroundTaskId?: string };
  // Sender on the isMeta user line that received a cross-session message (kind: "peer" and name)
  origin?: { kind?: unknown; name?: unknown };
  // Cross-session messages that arrive mid-work are recorded in an attachment (queued_command) with the same origin
  attachment?: { origin?: { kind?: unknown; name?: unknown } };
}

interface Block {
  type?: string;
  name?: string;
  text?: string;
  input?: unknown; // Input of a tool_use block (used by summarizeToolInput to build the input summary)
  tool_use_id?: string; // id of the tool_use a tool_result block answers. Used to match chick completion signals
}

// user message left behind when a session closes via /clear, Ctrl+C, or shutdown.
// Missing it leads to misjudging "no response to input = stuck"
const INTERRUPTED_PREFIX = "[Request interrupted by user";

// When a slash command that completes locally (/clear, /effort, /model, etc.) runs, a command echo is
// written to the transcript as a user entry without isMeta. The assistant's response never comes, so
// treating it as a normal user utterance keeps it looking like "waiting for a response" in started
// (measured: shown as "no response" for 17 minutes).
// Structure confirmed on real data (see the change history of lib/transcript.ts):
// - For commands with output (stdout), that stdout is written as a `<local-command-stdout>` tag in the
//   text of a user entry without isMeta (e.g. /effort, /model). classify() detects this generically by
//   checking for LOCAL_COMMAND_STDOUT_TAG and makes it closed
// - /clear is the exception: its stdout is empty, so stdout is written not to a user entry but to a
//   separate type:"system" entry (subtype: "local_command"), which the user branch of classify() never
//   reaches. Only this case is still judged by the command-name (the command echo itself) via a list
// The echo of a skill/custom command launch (e.g. /event-log) is a real prompt (what fires started), and
// the following user entry is the skill body without `<local-command-stdout>`, so it matches neither
// check above and is treated as a normal user utterance (confirmed on real data)
const CLOSING_SLASH_COMMANDS = ["/clear"];

const LOCAL_COMMAND_STDOUT_TAG = "<local-command-stdout>";

export const TAIL_BYTES = 64 * 1024;

// When a huge single line (base64 image etc.) sits near the end of the file, the TAIL_BYTES (64KB)
// window can fall inside that one line, leaving zero parseable lines (lines with a timestamp) in the
// window. The longest line observed on real data is 453KB (a subagent's Playwright screenshot embedded
// as base64 in a tool_result). In that case readWindow returned lastEventAt as undefined, and the caller
// (lib/sessions.ts) actually mistook it for "last updated long ago" and fell to done/dozing.
// As a fix, only when the window yields no line with a timestamp, the window is doubled
// (64KB→128KB→256KB→…) and read again. The cap MAX_TAIL_BYTES is 2MB, about 4.5x the observed max
// line length of 453KB (ensuring a window clearly larger than any line seen in practice, while avoiding
// reading an entire huge file with no cap).
// The normal case (the vast majority of files, with timestamp lines in the window) still finishes in one
// TAIL_BYTES read as before, so performance is unchanged.
const MAX_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Reads only the end of the file and classifies "the last thing that happened".
 * includeSidechain: set to true when reading a subagent transcript (every line isSidechain: true).
 * Defaults to false (the existing behavior for the main transcript).
 * If the window has no line with a timestamp (see the comment on the MAX_TAIL_BYTES constant),
 * the window is doubled and read again. If the file is small and the window already covers the
 * whole file, it cannot grow further, so the result is settled in one read.
 */
export async function readTail(
  file: NativeFile,
  opts?: { includeSidechain?: boolean },
): Promise<TailInfo> {
  const includeSidechain = opts?.includeSidechain ?? false;
  const cap = Math.min(MAX_TAIL_BYTES, file.size);
  let windowBytes = TAIL_BYTES;
  let result = await readWindow(file, windowBytes, includeSidechain);
  while (result.lastEventAt === undefined && windowBytes < cap) {
    windowBytes = Math.min(windowBytes * 2, cap);
    result = await readWindow(file, windowBytes, includeSidechain);
  }
  return result;
}

/**
 * Classifies the lines in bytes [start, end) of the file (main transcript only). Used for bytes that were
 * appended between two polls but already fell out of the tail window, so the user message in them isn't
 * missed (anger mark input). A line cut at either edge fails to parse and is skipped
 */
export async function readEventsInRange(file: NativeFile, start: number, end: number): Promise<TailEvent[]> {
  const text = await file.slice(start, end).text();
  const events: TailEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = parseTimestamp(entry.timestamp);
    const next = classify(entry, false);
    if (!next || at === null) continue;
    events.push({ at, kind: next.kind, toolName: next.toolName, text: next.text, machine: next.machine });
  }
  return events;
}

const CHICK_SIGNAL_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Collects chick completion signals (the same collectChickSignals as TailInfo.chickSignals) from the whole
 * transcript from start, not just the tail window. A long-lived parent's completion records scroll out of the
 * tail window, and a chick is shown until its completion is recorded (docs/design.md "Removing birds of ended
 * sessions"), so lib/sessions.ts keeps the result across scans and reads only what was appended. end is the
 * position read up to; a last line cut off midway is left for the next read
 */
export async function scanChickSignals(
  file: NativeFile,
  start: number,
): Promise<{ signals: Map<string, number>; end: number }> {
  const signals = new Map<string, number>();
  let pos = start;
  while (pos < file.size) {
    const text = await file.slice(pos, Math.min(file.size, pos + CHICK_SIGNAL_CHUNK_BYTES)).text();
    const cut = text.lastIndexOf("\n");
    if (cut < 0) {
      // A single line longer than the chunk: read it whole
      if (pos + CHICK_SIGNAL_CHUNK_BYTES < file.size) {
        const whole = await file.slice(pos).text();
        const lineEnd = whole.indexOf("\n");
        if (lineEnd < 0) break;
        collectLine(whole.slice(0, lineEnd), signals);
        pos += new TextEncoder().encode(whole.slice(0, lineEnd + 1)).length;
        continue;
      }
      break;
    }
    const complete = text.slice(0, cut + 1);
    for (const line of complete.split("\n")) collectLine(line, signals);
    pos += new TextEncoder().encode(complete).length;
  }
  return { signals, end: pos };

  function collectLine(line: string, out: Map<string, number>): void {
    // Only these two kinds of line can carry a signal; skip JSON.parse for the rest
    if (!line.includes(TASK_NOTIFICATION_TAG) && !line.includes("tool_result")) return;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const at = parseTimestamp(entry.timestamp);
    if (at !== null) collectChickSignals(entry, at, out);
  }
}

/**
 * The body of readTail that reads and classifies one window. windowBytes is the number of bytes read
 * from the end of the file, which the caller (readTail) grows on each retry.
 */
async function readWindow(
  file: NativeFile,
  windowBytes: number,
  includeSidechain: boolean,
): Promise<TailInfo> {
  const truncated = file.size > windowBytes;
  const text = await file.slice(Math.max(0, file.size - windowBytes)).text();
  const lines = text.split("\n");
  if (truncated) lines.shift(); // The first line may have been read from the middle

  let kind: TailKind = "unknown";
  let toolName: string | undefined;
  let cwd: string | undefined;
  let entrypoint: string | undefined;
  let lastEventAt: number | undefined;
  let continuedIn: string | undefined;
  const events: TailEvent[] = [];
  const chickSignals = new Map<string, number>();
  const backgroundTaskStarts = new Map<string, number>();
  const peerNames = new Map<string, number>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // Lines without cwd (summary etc.) are mixed in, so update with the last value found regardless of
    // whether classification succeeds
    if (typeof entry.cwd === "string" && entry.cwd.startsWith("/")) cwd = entry.cwd;
    // entrypoint appears not only on user lines but also on assistant/attachment/system lines (see the
    // TailInfo.entrypoint comment). Like cwd, update with the last value found
    if (typeof entry.entrypoint === "string") entrypoint = entry.entrypoint;
    const at = parseTimestamp(entry.timestamp);
    // Track the max over every line whose timestamp parses, regardless of classify()'s result (whether
    // next is null) (see the TailInfo.lastEventAt comment). Even line types not used for state
    // (last-prompt, queue-operation, etc.) are a valid source for "when conversation actually happened"
    // as long as they carry a timestamp, so don't miss them
    if (at !== null) lastEventAt = lastEventAt === undefined ? at : Math.max(lastEventAt, at);
    // Chick completion signals are collected independently of classify() (the kind/events used for state).
    // queue-operation is a line type classify() ignores for state, but it is the only source of chick
    // completion signals, so pick it up separately here (without polluting kind/events)
    if (at !== null) collectChickSignals(entry, at, chickSignals);
    // Launch confirmation of run_in_background (see the TailInfo.backgroundTaskStarts comment).
    // Subagent lines are kept out of the parent's ledger by the same rule as classify()
    const backgroundTaskId =
      entry.type === "user" && !(entry.isSidechain && !includeSidechain)
        ? entry.toolUseResult?.backgroundTaskId
        : undefined;
    if (at !== null && typeof backgroundTaskId === "string" && backgroundTaskId) {
      backgroundTaskStarts.set(backgroundTaskId, at);
    }
    // Traces of cross-session messages are picked up separately from classify() (which skips isMeta)
    if (at !== null && !(entry.isSidechain && !includeSidechain)) {
      for (const name of collectPeerNames(entry)) {
        peerNames.set(name, Math.max(peerNames.get(name) ?? 0, at));
      }
    }
    if (entry.type === "continued-in" && typeof entry.continuedInSessionId === "string") {
      continuedIn = entry.continuedInSessionId;
    }
    const next = classify(entry, includeSidechain);
    if (!next) continue;
    continuedIn = undefined;
    kind = next.kind;
    toolName = next.toolName;
    if (at !== null) {
      events.push({ at, kind: next.kind, toolName: next.toolName, text: next.text, machine: next.machine });
    }
  }
  return {
    kind,
    toolName,
    events,
    cwd,
    chickSignals,
    backgroundTaskStarts,
    peerNames,
    lastEventAt,
    entrypoint,
    ...(continuedIn && { continuedIn }),
  };
}

const CROSS_SESSION_FROM_NAME = /<cross-session-message\b[^>]*\bfrom-name="([^"]+)"/g;

/** Drops the display " [ref]" from a SendMessage recipient name (the ListAgents format; SendMessage in the docs) */
function peerNameOf(to: string): string | undefined {
  const name = to.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  // "main" (the parent conversation) and agent ids (a...-...) are not cross-session links
  if (!name || name === "main") return undefined;
  return name;
}

/**
 * Gets, from one line, the names of peers exchanged with via cross-session messages (TailInfo.peerNames).
 * Sent: input.to of the assistant's SendMessage tool_use. Received: origin.name on the isMeta user line
 * (when kind is "peer"), otherwise <cross-session-message from-name="…"> in the body. Messages that arrived
 * mid-work: origin.name of the attachment (queued_command). Same rules as scan_peer_names in src-tauri
 */
function collectPeerNames(entry: TranscriptEntry): string[] {
  const names: string[] = [];
  if (entry.type === "assistant") {
    for (const block of asBlocks(entry.message?.content)) {
      if (block.type !== "tool_use" || block.name !== "SendMessage") continue;
      const to = (block.input as { to?: unknown } | undefined)?.to;
      const name = typeof to === "string" ? peerNameOf(to) : undefined;
      if (name) names.push(name);
    }
  } else if (entry.type === "attachment") {
    const origin = entry.attachment?.origin;
    if (origin?.kind === "peer" && typeof origin.name === "string" && origin.name) names.push(origin.name);
  } else if (entry.type === "user" && entry.isMeta) {
    if (entry.origin?.kind === "peer" && typeof entry.origin.name === "string" && entry.origin.name) {
      names.push(entry.origin.name);
    } else {
      const content = entry.message?.content;
      const text = typeof content === "string" ? content : asBlocks(content).map((b) => b.text ?? "").join("\n");
      for (const m of text.matchAll(CROSS_SESSION_FROM_NAME)) names.push(m[1]);
    }
  }
  return names;
}

const TASK_NOTIFICATION_TAG = "<task-notification>";
const TASK_ID_PATTERN = /<task-id>([^<]+)<\/task-id>/;

/**
 * Picks up definitive signals that a chick (subagent) has stopped from queue-operation lines and
 * user (tool_result) lines, and adds them to out (key = chick identifier, value = its timestamp).
 * Uses the at (= entry.timestamp) computed by the caller (readTail) as is.
 */
function collectChickSignals(entry: TranscriptEntry, at: number, out: Map<string, number>): void {
  if (entry.type === "queue-operation") {
    // Signal that a background chick finished. <task-notification> fires every time an agent stops
    // (after a resume it can fire multiple times with the same task-id), so always overwrite with the
    // latest at. The status value is not checked (anything other than completed is also treated as a
    // "that chick stopped" signal. See the TailInfo.chickSignals comment for details).
    // content can be present on any of the enqueue/remove/dequeue operations (dequeue is often empty,
    // but if absent nothing happens, so no harm).
    // Completion notices of background commands such as Bash (task-notification itself is not specific
    // to Task/Agent) also pass through here. scanChicks ignores them because there is no chick file, and
    // backgroundTaskCache in lib/sessions.ts uses them as background task completion
    const content = entry.content;
    if (typeof content === "string" && content.includes(TASK_NOTIFICATION_TAG)) {
      const taskId = content.match(TASK_ID_PATTERN)?.[1];
      if (taskId) out.set(taskId, at);
    }
    return;
  }
  if (entry.type === "user") {
    // Signal that a synchronous call (a blocking Task/Agent call) finished. The time a tool_result arrives
    // whose tool_use_id matches toolUseId in the chick's meta.json is the completion time as is.
    // However, the Agent tool's async launch confirmation (toolUseResult.isAsync===true) returns right
    // after launch with the same tool_use_id but is not a completion, so it is excluded (see the
    // TranscriptEntry.toolUseResult comment)
    if (entry.toolUseResult?.isAsync) return;
    const blocks = asBlocks(entry.message?.content);
    for (const b of blocks) {
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") out.set(b.tool_use_id, at);
    }
  }
}

function parseTimestamp(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const at = Date.parse(timestamp);
  return Number.isNaN(at) ? null : at;
}

interface Classified {
  kind: TailKind;
  toolName?: string;
  text?: string;
  machine?: boolean;
}

function classify(entry: TranscriptEntry, includeSidechain: boolean): Classified | null {
  if (entry.isSidechain && !includeSidechain) return null; // Subagent lines are not used for the main line's state
  if (entry.type === "assistant") {
    const blocks = asBlocks(entry.message?.content);
    const toolUse = blocks.findLast((b) => b.type === "tool_use");
    if (toolUse) {
      // Sending input as is can get large, so trim to the first 500 chars (this just reuses the text
      // field meant for user utterances; the content is something else)
      return { kind: "tool_use", toolName: toolUse.name, text: summarizeToolInput(toolUse.input) };
    }
    if (blocks.some((b) => b.type === "text")) {
      return { kind: "assistant_text", text: extractAssistantText(blocks) };
    }
    return null; // thinking only etc. does not change the state
  }
  if (entry.type === "user") {
    if (entry.interruptedByShutdown || isInterruptedMessage(entry.message?.content)) {
      return { kind: "closed" };
    }
    const blocks = asBlocks(entry.message?.content);
    if (blocks.some((b) => b.type === "tool_result")) return { kind: "tool_result" };
    if (entry.isMeta) return null;
    if (blocks.some((b) => b.type === "text" && b.text?.includes(LOCAL_COMMAND_STDOUT_TAG))) {
      return { kind: "closed" };
    }
    const commandName = extractCommandName(blocks);
    if (commandName && CLOSING_SLASH_COMMANDS.includes(commandName)) return { kind: "closed" };
    // Trim to the first 500 chars, enough for the snippet display (also serves as a memory cap)
    // Older versions have no origin, so only an explicit non-human origin is marked
    const originKind = entry.origin?.kind;
    const machine = typeof originKind === "string" && originKind !== "human";
    return { kind: "user", text: extractUserText(blocks), ...(machine && { machine }) };
  }
  return null; // summary / file-history-snapshot etc. are ignored
}

// Limit shared across TailEvent.text (used for both user utterances and tool_use input summaries)
const TEXT_FIELD_LIMIT = 500;

function extractUserText(blocks: Block[]): string | undefined {
  const parts = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text as string);
  if (parts.length === 0) return undefined;
  return parts.join("\n").slice(0, TEXT_FIELD_LIMIT);
}

// Material for the done readout summary (lib/summarize.ts), kept with a looser limit than user utterances.
// The 500 chars for user utterances are enough for "the gist of what was said", but too short as an
// amount of assistant response to summarize, so it gets its own limit
const ASSISTANT_TEXT_LIMIT = 2000;

// Same structure as extractUserText, but it keeps the last N chars instead of the first. The purpose is
// "what was finished" (summary input, last-sentence fallback readout), so for long responses the tail end
// where the conclusion is written must be kept (cutting from the start drops the closing sentence
// entirely in responses over 2000 chars)
function extractAssistantText(blocks: Block[]): string | undefined {
  const parts = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text as string);
  if (parts.length === 0) return undefined;
  return parts.join("\n").slice(-ASSISTANT_TEXT_LIMIT);
}

// Extracts the content of `<command-name>` from the echo of a slash command.
// The order of `<command-name>` and `<command-message>` differs by command (/clear has command-name
// first, /event-log has command-message first), so it searches the whole text instead of matching the start
const COMMAND_NAME_PATTERN = /<command-name>([^<]*)<\/command-name>/;

function extractCommandName(blocks: Block[]): string | undefined {
  for (const b of blocks) {
    if (b.type !== "text" || !b.text) continue;
    const match = b.text.match(COMMAND_NAME_PATTERN);
    if (match) return match[1].trim();
  }
  return undefined;
}

// Turns a tool_use input into a summary string. Inputs where JSON.stringify can fail
// (circular references etc., not expected in real data) are swallowed
function summarizeToolInput(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  try {
    return JSON.stringify(input).slice(0, TEXT_FIELD_LIMIT);
  } catch {
    return undefined;
  }
}

function isInterruptedMessage(content: unknown): boolean {
  if (typeof content === "string") return content.startsWith(INTERRUPTED_PREFIX);
  if (!Array.isArray(content)) return false;
  return (content as Block[]).some(
    (b) => b.type === "text" && (b.text ?? "").startsWith(INTERRUPTED_PREFIX),
  );
}

function asBlocks(content: unknown): Block[] {
  // When content comes as a plain string (a simple user utterance), fill in text too. Previously only type
  // was set and text was dropped, so the user utterance input (extractUserText) was always empty in
  // this case
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) return content as Block[];
  return [];
}

/**
 * Gets display names from slugs (the path with `/`→`-`). Not used for sessions whose cwd was read from
 * the tail (the primary approach is basename(cwd)). As a fallback when cwd is unavailable, it builds the
 * display name by stripping the prefix common to all slugs
 * (e.g. -Users-x-Dev-gyokan and -Users-x-Dev-ai-tools → gyokan / ai-tools).
 * Known limits: separators cannot be told apart from hyphens inside words, and nothing is stripped when
 * only one slug is active under the root.
 */
export function projectLabels(slugs: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (slugs.length === 0) return map;
  let prefix = slugs.length === 1 ? "" : commonPrefix(slugs);
  prefix = prefix.slice(0, prefix.lastIndexOf("-") + 1); // Back up to a segment boundary
  for (const slug of slugs) {
    const label = slug.slice(prefix.length).replace(/^-+/, "");
    map.set(slug, label || slug);
  }
  return map;
}

/**
 * Returns the last segment of a path (`/`-separated, trailing slashes ignored).
 * Inputs whose segment would be empty (e.g. "/") are returned as is.
 */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const result = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  return result || path;
}

function commonPrefix(items: string[]): string {
  let prefix = items[0];
  for (const item of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < item.length && prefix[i] === item[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}
