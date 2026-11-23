import type { NativeFile } from "./native-fs";
import { isAbsolutePath } from "./paths";
import { asBlocks, isForeignLine, parseTimestamp, TEXT_FIELD_LIMIT, type Block, type TranscriptEntry } from "./transcript-entry";
import { collectChickSignals, handBackOf, trackTools } from "./transcript-chicks";
import { collectWakes } from "./transcript-wakes";
import { collectPeerNames, firstPromptStarterOf, isFirstPromptCandidate, sentPeerNamesOf, startsTurn } from "./transcript-peers";
import { desktopAskOf, proposalResultsOf, settledProposalOf, START_SESSION_TOOL } from "./transcript-desktop";
// Reads Claude Code transcripts (~/.claude/projects/<slug>/<sessionId>.jsonl).
// The format is a Claude Code internal detail and can change without notice, so parsing is
// confined to this file and the transcript-*.ts files it reads lines with (transcript-entry.ts: a line's shape;
// transcript-chicks.ts: a chick's end; transcript-wakes.ts: wakes; transcript-peers.ts: peers and turn starts;
// transcript-desktop.ts: the desktop app's asks and proposal cards). Codex is converted to the same TailInfo by a
// separate adapter in lib/codex-transcript.ts.

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
  // includes line types not used for state, such as last-prompt and queue-operation, except the idle lines of
  // isIdleLine such as away_summary). undefined if there are none. It does not move for lines without a timestamp (last-prompt etc.) or for after-the-fact
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
  // so the caller (isSdkSession in lib/session-chicks.ts) matches /^sdk/ rather than an exact value (only
  // "sdk-cli" is excluded from display, in lib/sessions.ts).
  // The entrypoint field is internal and version-dependent (see docs/last-prompt-ghost.md; there is a
  // precedent where an assumption broke with the last-prompt record). If no line in the tail window has
  // entrypoint, it stays undefined = the caller treats it as cli (adult) (safe-side fallback)
  entrypoint?: string;
  // Definitive signals found in the parent transcript that a chick (subagent) has "stopped".
  // key is the chick's identifier (the task-id of a task-notification, or the id of the launching
  // tool_use = toolUseId in meta.json), value is the latest timestamp (epoch ms) the signal was seen.
  // The parent can resume a chick with the same task-id; then writes resume in the same jsonl and this
  // signal can appear multiple times with the same task-id, so it is always overwritten with the latest
  // value (scanChicks in lib/session-chicks.ts detects a resume by checking whether the chick's last
  // conversation time (lastEventAt) has advanced after the signal, and invalidates the signal if so).
  // It is computed with the same logic when reading a chick's own transcript (includeSidechain:true),
  // but it is only actually used for the parent tail (see deriveState in lib/bird-state.ts and scanChicks in lib/session-chicks.ts).
  chickSignals: Map<string, number>;
  // Launch records of background tasks the parent started with run_in_background (Bash etc.; the same
  // from the parent's view even if the content is `claude -p`). key is the task-id
  // (toolUseResult.backgroundTaskId), value is the time of the tool_result confirming the launch.
  // Completion arrives in chickSignals as a <task-notification> with the same task-id. Launch lines leave
  // the tail window within tens of seconds, so the ledger is kept across scans in lib/session-store.ts
  // (backgroundTaskCache)
  backgroundTaskStarts: Map<string, number>;
  // What the session set up to wake itself later, Claude Code's own tools (docs/design.md "Turn verdicts"): a
  // ScheduleWakeup (key "wakeup": one pending at a time, a new one replaces it), a CronCreate ("cron:<id>") and a Monitor
  // ("monitor:<task id>"), from the results confirming them. until is when it fires or expires (absent for a recurring
  // cron or a persistent monitor). ends are when one was cancelled or stopped: ScheduleWakeup's stop, CronDelete, TaskStop,
  // or a monitor's <task-notification> with a <status> (its events come without one). Absent when there is none. Like
  // backgroundTaskStarts, these lines leave the tail window, so lib/session-store.ts keeps a ledger (wakeCache)
  wakes?: { starts: Map<string, { at: number; until?: number }>; ends: Map<string, number> };
  // Names of the peers exchanged with via cross-session messages (Claude Code's cross-session messaging).
  // On the sending side it is the recipient of the SendMessage tool call (input.to); on the receiving side
  // it is origin.name on the isMeta user line (or <cross-session-message from-name="…"> in the body if
  // absent). The value is the latest time of that trace. So it doesn't vanish when it leaves the tail
  // window, lib/session-store.ts (peerNameCache) keeps it across scans.
  // Used to decide the link for watching (docs/design.md "Watching")
  peerNames: Map<string, number>;
  // The sessions its latest turn sent a message to (SendMessage's to, the desktop app's send_message's session_id), as
  // peerNames names them; undefined when the window doesn't reach the prompt that started the turn. A parent takes over
  // the question a reply asks only when the turn sent it a message (askSentToParent in lib/watching.ts)
  lastTurnSentTo?: string[];
  // The last line with a time (the away recap aside) is the one Claude Code writes when a turn is over (`system` /
  // `turn_duration`): the session is done at once rather than working for WRITING_MS after its last write (deriveState
  // in lib/bird-state.ts). Any later line with a time clears it (a queued message, another session's message, the next
  // prompt may start the next turn). Absent for agents that write no such line, which keep the WRITING_MS rule
  turnEnded?: true;
  // A tool call in the window has no result yet (a tool still running, also when the tail is the result of another call
  // made in parallel). A chick with an open tool is abandoned only after CHICK_TOOL_ABANDONED_MS (deriveState in
  // lib/bird-state.ts; docs/design.md "Chicks that have finished")
  toolOpen?: true;
  // The last conversation line is a hand-back to the caller (Claude Code's SubagentHandback tool_use, or its result):
  // a chick that did this has finished, whatever the parent's records say. A later conversation line (a resume) clears it
  handedBack?: true;
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
  //   event feed snippet (pickSnippet/formatSnippet in lib/session-snippet.ts)
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
  // kind === "tool_use" only: the call ends the turn asking the user to decide (the Claude desktop app's
  // mcp__ccd_turn__wrap_up with an `ask`, see desktopAskOf); question is that `ask`
  ask?: { question?: string };
  // The Claude desktop app's session proposals in this line (docs/design.md "The "?" for sessions waiting on you"): see
  // ProposalTrace
  proposal?: ProposalTrace;
}

/**
 * What one line says about the desktop app's session proposals (cards the user starts with a click):
 * - proposed: a start_session result `Proposed "<title>" (task_id: task_…)`, a card now shown (only an own_initiative
 *   proposal ends so; an offer waits for the user's answer within the call). Only the result of a start_session call
 *   (matched by tool_use_id): the same text in another tool's result (a file read, a command's output) is no card
 * - settled: proposals withdrawn (dismiss_task's task_id) or started by the session itself (start_session's
 *   proposal_id)
 */
export interface ProposalTrace {
  proposed?: { taskId: string; title?: string }[];
  settled?: string[];
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

// A line Claude Code writes while the session sits idle, which is not conversation: the recap written while the user is
// away (system / away_summary). It doesn't move lastEventAt, since it made a finished session look working for
// WRITING_MS and its turn was summarized and sent to the concierge again. Measured on the local transcripts: 3,692 of
// 3,942 away_summary lines came more than 6 seconds after the last user / assistant line and were not followed by one
// within 30 seconds. Other lines written late (queue-operation, api_error, ...) mostly start or belong to a turn and
// still count (docs/design.md "Bird states")
/** The line Claude Code writes once a turn is over. In the local transcripts it always came right after the turn's last
 * assistant text (docs/design.md "Bird states") */
function isTurnEndLine(entry: TranscriptEntry): boolean {
  return entry.type === "system" && entry.subtype === "turn_duration";
}

function isIdleLine(entry: TranscriptEntry): boolean {
  return entry.type === "system" && entry.subtype === "away_summary";
}

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

/** How a main transcript is read */
export interface TranscriptReadOptions {
  /** The session's own id (the transcript's file name without .jsonl): lines of another session are skipped
      (isForeignLine). Only main transcripts are read with it; a chick's lines all carry the main session's id */
  ownSessionId?: string;
}

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
  opts?: TranscriptReadOptions & { includeSidechain?: boolean },
): Promise<TailInfo> {
  const includeSidechain = opts?.includeSidechain ?? false;
  const cap = Math.min(MAX_TAIL_BYTES, file.size);
  let windowBytes = TAIL_BYTES;
  let result = await readWindow(file, windowBytes, includeSidechain, opts?.ownSessionId);
  while (result.lastEventAt === undefined && windowBytes < cap) {
    windowBytes = Math.min(windowBytes * 2, cap);
    result = await readWindow(file, windowBytes, includeSidechain, opts?.ownSessionId);
  }
  return result;
}

/**
 * Classifies the lines in bytes [start, end) of the file (main transcript only). Used for bytes that were
 * appended between two polls but already fell out of the tail window, so the user message in them isn't
 * missed (anger mark input). A line cut at either edge fails to parse and is skipped
 */
export async function readEventsInRange(
  file: NativeFile,
  start: number,
  end: number,
  opts?: TranscriptReadOptions,
): Promise<TailEvent[]> {
  const text = await file.slice(start, end).text();
  const events: TailEvent[] = [];
  const startSessionCalls = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isForeignLine(entry, opts?.ownSessionId)) continue;
    const at = parseTimestamp(entry.timestamp);
    const next = classify(entry, false, startSessionCalls);
    if (!next || at === null) continue;
    events.push({ at, kind: next.kind, toolName: next.toolName, text: next.text, machine: next.machine, ...(next.ask && { ask: next.ask }) });
  }
  return events;
}

/**
 * The body of readTail that reads and classifies one window. windowBytes is the number of bytes read
 * from the end of the file, which the caller (readTail) grows on each retry.
 */
async function readWindow(
  file: NativeFile,
  windowBytes: number,
  includeSidechain: boolean,
  ownSessionId: string | undefined,
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
  const wakeStarts = new Map<string, { at: number; until?: number }>();
  const wakeEnds = new Map<string, number>();
  // The first prompt is seen only when the window starts at the top of the file
  let lookingForFirst = !truncated;
  const startSessionCalls = new Set<string>();
  let turnSentTo: string[] | undefined;
  let turnEnded = false;
  const openTools = new Set<string>();
  let handBackId: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // A copied line of the parent's is not the session's: no state, event, time, peer or first prompt comes from it
    if (isForeignLine(entry, ownSessionId)) continue;
    if (lookingForFirst && isFirstPromptCandidate(entry)) {
      lookingForFirst = false;
      const starter = firstPromptStarterOf(entry);
      const firstAt = parseTimestamp(entry.timestamp);
      if (starter && firstAt !== null) peerNames.set(starter, Math.max(peerNames.get(starter) ?? 0, firstAt));
    }
    // Lines without cwd (summary etc.) are mixed in, so update with the last value found regardless of
    // whether classification succeeds
    if (typeof entry.cwd === "string" && isAbsolutePath(entry.cwd)) cwd = entry.cwd;
    // entrypoint appears not only on user lines but also on assistant/attachment/system lines (see the
    // TailInfo.entrypoint comment). Like cwd, update with the last value found
    if (typeof entry.entrypoint === "string") entrypoint = entry.entrypoint;
    const at = parseTimestamp(entry.timestamp);
    // Track the max over every line whose timestamp parses, regardless of classify()'s result (whether
    // next is null) (see the TailInfo.lastEventAt comment). Even line types not used for state
    // (last-prompt, queue-operation, etc.) are a valid source for "when conversation actually happened"
    // as long as they carry a timestamp, so don't miss them
    if (at !== null && !isIdleLine(entry)) lastEventAt = lastEventAt === undefined ? at : Math.max(lastEventAt, at);
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
    if (at !== null && !(entry.isSidechain && !includeSidechain)) collectWakes(entry, at, wakeStarts, wakeEnds);
    // Traces of cross-session messages are picked up separately from classify() (which skips isMeta)
    if (at !== null && !(entry.isSidechain && !includeSidechain)) {
      for (const name of collectPeerNames(entry)) {
        peerNames.set(name, Math.max(peerNames.get(name) ?? 0, at));
      }
    }
    if (startsTurn(entry)) turnSentTo = [];
    else if (turnSentTo && !(entry.isSidechain && !includeSidechain)) turnSentTo.push(...sentPeerNamesOf(entry));
    if (entry.type === "continued-in" && typeof entry.continuedInSessionId === "string") {
      continuedIn = entry.continuedInSessionId;
    }
    // Any later line with a time (a queued message, another session's message, the next prompt) may start the next
    // turn; only the away recap doesn't count, as for lastEventAt
    if (at !== null && !isIdleLine(entry) && !(entry.isSidechain && !includeSidechain)) turnEnded = isTurnEndLine(entry);
    const next = classify(entry, includeSidechain, startSessionCalls);
    if (!next) continue;
    trackTools(entry, openTools);
    handBackId = handBackOf(entry, next.kind, handBackId);
    continuedIn = undefined;
    kind = next.kind;
    toolName = next.toolName;
    if (at !== null) {
      events.push({
        at,
        kind: next.kind,
        toolName: next.toolName,
        text: next.text,
        machine: next.machine,
        ...(next.ask && { ask: next.ask }),
        ...(next.proposal && { proposal: next.proposal }),
      });
    }
  }
  return {
    kind,
    toolName,
    events,
    cwd,
    chickSignals,
    backgroundTaskStarts,
    ...((wakeStarts.size > 0 || wakeEnds.size > 0) && { wakes: { starts: wakeStarts, ends: wakeEnds } }),
    peerNames,
    ...(turnSentTo && { lastTurnSentTo: [...new Set(turnSentTo)] }),
    ...(turnEnded && { turnEnded: true as const }),
    ...(openTools.size > 0 && { toolOpen: true as const }),
    ...(handBackId !== undefined && { handedBack: true as const }),
    lastEventAt,
    entrypoint,
    ...(continuedIn && { continuedIn }),
  };
}

interface Classified {
  kind: TailKind;
  toolName?: string;
  text?: string;
  machine?: boolean;
  ask?: { question?: string };
  proposal?: ProposalTrace;
}

/**
 * startSessionCalls: the ids of the start_session calls seen so far in the read, so that only their results are read
 * as proposal cards (classify adds to it)
 */
function classify(entry: TranscriptEntry, includeSidechain: boolean, startSessionCalls: Set<string>): Classified | null {
  if (entry.isSidechain && !includeSidechain) return null; // Subagent lines are not used for the main line's state
  if (entry.type === "assistant") {
    const blocks = asBlocks(entry.message?.content);
    for (const b of blocks) if (b.type === "tool_use" && b.name === START_SESSION_TOOL && b.id) startSessionCalls.add(b.id);
    const toolUse = blocks.findLast((b) => b.type === "tool_use");
    if (toolUse) {
      // Sending input as is can get large, so trim to the first 500 chars (this just reuses the text
      // field meant for user utterances; the content is something else)
      const ask = desktopAskOf(toolUse.name, toolUse.input);
      const settled = blocks.flatMap((b) => (b.type === "tool_use" ? settledProposalOf(b.name, b.input) : []));
      return {
        kind: "tool_use",
        toolName: toolUse.name,
        text: summarizeToolInput(toolUse.input),
        ...(ask && { ask }),
        ...(settled.length > 0 && { proposal: { settled } }),
      };
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
    if (blocks.some((b) => b.type === "tool_result")) {
      const proposal = proposalResultsOf(blocks, startSessionCalls);
      return proposal ? { kind: "tool_result", proposal } : { kind: "tool_result" };
    }
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

function commonPrefix(items: string[]): string {
  let prefix = items[0];
  for (const item of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < item.length && prefix[i] === item[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/**
 * When the session last wrote: the time of the last line with a timestamp, or the file's mtime when the tail window has
 * none. The basis of its state (sinceMs), and once it is done / dozing, when its turn ended (watchingCount's
 * ownTurnEndedAt; docs/design.md "Watching"). Chicks use the same basis for sinceMs and
 * for choosing parent candidates
 */
export function lastWrittenAt(tail: Pick<TailInfo, "lastEventAt">, lastModified: number): number {
  return tail.lastEventAt ?? lastModified;
}
