import type { NativeDirectoryHandle, NativeFile, NativeFileHandle } from "./native-fs";
import { loadEventLog, saveEventLog, type RootEntry } from "./fsa";
import { isPeerActive, watchingCount } from "./watching";
import { readCodexTail, type CodexTailInfo } from "./codex-transcript";
import {
  basename,
  projectLabels,
  readEventsInRange,
  readTail,
  TAIL_BYTES,
  type TailEvent,
  type TailInfo,
} from "./transcript";
import type { AngerJudgement, AskJudgement } from "./jev";
import { invoke } from "@tauri-apps/api/core";

// Transition events reconstructed from the transcript with timestamps (experimental).
// key is for deduplicating the same event (every poll re-parses the same trailing 64KB)
export interface SessionEvent {
  key: string;
  sessionId: string;
  project: string;
  // Prompt snippet. For started it is the event's own user message; for others, the latest message
  // (pickSnippet). It is a separate field rather than embedded in the project string so that EventFeed can
  // independently apply the same display style as SessionView.snippet (smaller, faded)
  snippet?: string;
  type: "started" | "done" | "waiting" | "closed";
  at: number;
  // true when a done that was suppressed while waiting on chicks (subagents) is cancelled once the
  // suppression lifts. Kept in the log and feed, but no chirp or readout (see deriveDoneEvent)
  muted?: boolean;
  // Actual fire time (epoch ms) when a done released from suppression fires by timeout. at stays fixed
  // as the key basis (t = the parent's turn end), so the freshness guard uses this instead
  // (App.tsx: event.firedAt ?? event.at)
  firedAt?: number;
  // The assistant's final reply text for the done readout summary (lib/summarize.ts) (max 2000 chars,
  // from assistant_text.text in lib/transcript.ts). A temporary field used only for speech; events other
  // than done don't carry it. We don't want raw text that can be several KB in the persistent event log in
  // IndexedDB, so appendToEventLog strips it right before saving (it stays in the in-memory
  // sessionEventCache/events, so it can still be used for the readout at the moment App.tsx detects a new done)
  assistantText?: string;
  // Whether Jev judged the done turn as needs reply (recordAskJudgement). Shown in the debug dialog
  ask?: AskJudgement;
  // Jev's abuse verdict for the user message of a started event (recordAngerJudgement). Shown in the debug dialog
  anger?: AngerJudgement;
  // Whether this session's bird has the anger mark now. App sets it only for display; it is not written to the
  // persistent log
  angry?: boolean;
  // The same sentence as that turn's speech bubble, attached to the Recent activity row. App sets it only
  // for display; it is not written to the persistent log
  line?: string;
}

// Machine state (recomputed from the transcript alone on every poll). waiting means waiting for the user's
// answer to AskUserQuestion / ExitPlanMode / request_user_input
export type BirdState = "working" | "waiting" | "done" | "dozing";

export interface SessionView {
  id: string; // <rootId>/<slug>/<file name>
  project: string; // display name
  // Project identifier within the data source. For Claude Code, the slug under projects/; for Codex,
  // `codex:<cwd>`. Key for per-project icon set assignment (issue #14). It doesn't include rootId,
  // so the assignment is shared even when the same project path is seen from multiple roots
  slug: string;
  state: BirdState;
  sinceMs: number; // time since the last write
  toolName?: string; // tool name while idle on a tool_use
  chicks?: ChickView[]; // subagents (exist only as children of a parent)
  // Snippet of the latest user message (pickSnippet). Always shows "what this session was asked to do"
  snippet?: string;
  // Last reply of a stopped (done / dozing) turn. Used as the Jev verdict input and to identify the turn
  // (sessionId + at). at is the same value as the at of the same turn's done event
  reply?: { at: number; text: string };
  // Jev verdict for the reply's turn. Set by App (mock writes it directly)
  ask?: AskJudgement;
  // The latest message a person typed in this session (lastUserMessage). Input for the abuse verdict
  // (docs/design.md "Anger mark for abuse toward the AI"). Untrusted input; never shown
  userMessage?: { at: number; text: string };
  // Jev's abuse verdict for the latest judged user message. Set by App (mock writes it directly)
  anger?: AngerJudgement;
  // The question text while stopped on a question tool (AskUserQuestion / request_user_input). Taken as-is
  // from the tool input (no AI). Shown in the speech bubble (perch/bubble.tsx)
  question?: string;
  // Speech bubble text summarizing the reply's turn with BYOK. Set by App (mock writes it directly)
  summary?: string;
  // When Jev judged needs reply but there is no key for summarizing, the last sentence of reply
  // (lib/last-sentence.ts; no AI). Set by App. The speech bubble shows this when there is no summary
  replyTail?: string;
  // Peers connected by inter-session messages (Watching in docs/design.md). Claude Code only
  peers?: PeerLink[];
  // Watching: the number of peers currently active while this session's own machine state is done / dozing.
  // For a grace period after the peers stop (WATCH_GRACE_MS in lib/watching.ts) it is 0 and stays watching
  // (not put into the nest). Absent when not watching
  watching?: number;
  // Working folder and start time. Used for the watching indent on the Perch (the parent is the one started
  // first; the label is the path relative to the parent)
  cwd?: string;
  startedAt?: number;
}

/** A watching peer. viewId is set only when the peer is on screen (a SessionView from the same scan) */
export interface PeerLink {
  sessionId: string;
  viewId?: string;
  name: string;
  cwd?: string;
  // Start time (epoch ms). Decides the indent parent (the one started first) on the Perch
  startedAt?: number;
  // Active (isPeerActive in lib/watching.ts: the status in sessions/<pid>.json is not idle, or the on-screen
  // machine state is working / waiting)
  active: boolean;
  // Last time it was active (epoch ms). The newer of the last time this app saw it active and the peer's last
  // transcript write. Used for the watching grace period
  lastActiveAt?: number;
}

export interface ChickView {
  id: string; // <parent id>/<file name>
  name: string; // resolved from meta.json in order name → description → file name (resolveChickMeta)
  state: BirdState;
  sinceMs: number;
  toolName?: string;
}

export interface ScanResult {
  views: SessionView[];
  brokenIds: string[]; // ids of roots that failed to scan
  events: SessionEvent[]; // newest first, at most 30 (experimental)
}

// Internal scan result of scanChicks. ChickView is a public display-only type, so instead of polluting it,
// this separate type lets us add fields used only inside the scan (currently only view, but kept as the place
// for scan-side-only processing such as liveIds pruning or sorting by sinceMs).
// Previously it also held tail (TailInfo), but it was removed once tail had no remaining uses after deleting
// the deriveStaleEvent call for chicks (dead code that only ever returned null, since isChick was always true
// and the state was fixed to working)
interface ChickScan {
  view: ChickView;
}

const ACTIVE_WINDOW_MS = 30 * 60_000; // sessions older than this are not shown on the Perch
const WRITING_MS = 6_000; // recent write = working
const CHICK_ABANDONED_MS = 10 * 60_000; // a chick stuck in working with no writes for longer than this is treated as abandoned and not used to suppress done (threshold for abandoned chicks)
// Grace period, after a done suppressed while waiting on chicks is released, to wait for the parent to
// restart (cancel). The harness auto-restart after a background chick finishes was measured at about 3
// seconds after completion, so 30 seconds covers the normal case. If a known harness notification-delay bug
// delays the restart past 30 seconds, the timeout fires first and may chirp twice together with the done of
// the later restarted turn, but we accept that as a better degradation than staying silent (a recurrence of
// the actual problem)
const DONE_GRACE_MS = 30_000;
// Background tasks older than this with no completion notification are not used to suppress done.
// An escape hatch for when the notification line is missed (more than 64KB written between 3-second polls,
// timers throttled in a hidden tab, etc.) and suppression would never lift. A done released this way has an
// old at=T, so App.tsx's freshness guard keeps it silent (i.e. this value doesn't cause false fires)
const BACKGROUND_TASK_STALE_MS = 30 * 60_000;
const DOZE_MS = 5 * 60_000; // dozing once this long has passed since done
// Idle time before a chick's assistant_text tail is treated as done, as a fallback when the parent ledger
// (chickSignals) has no signal. The harmless pauses observed in real data ("wrote only text for a moment
// while working") were 36 seconds, and could exceed 60 seconds with long thinking, so we use 2 minutes, well
// above that (with a signal, done is set immediately without going through this value; see deriveState).
// If it still stays false (no notification, the chick died silently), eventually the existing
// CHICK_ABANDONED_MS (10 minutes, releases suppression in deriveDoneEvent) applies separately and treats it
// as an abandoned chick
const CHICK_TEXT_DONE_MS = 2 * 60_000;
// Tolerance when comparing a chick's completion signal (chickSignals) with the chick's last conversation time
// (tail.lastEventAt ?? file.lastModified). Normally the order is "chick's last write → notification written
// to the parent a few seconds later", so last conversation time <= signal always holds. A resumed chick's
// last conversation time moves clearly past the signal, so if it exceeds the signal by more than a few
// seconds' margin we treat it as resumed and invalidate the signal (see scanChicks)
const CHICK_SIGNAL_EPSILON_MS = 5_000;

// Urgency order of BirdState (smaller = more urgent). Both the views sort (end of scanSessions) and
// escalateWithChicks (parent escalation) use the same order, so it is defined once here and shared
// within the module
const STATE_URGENCY: Record<BirdState, number> = { waiting: 0, working: 1, done: 2, dozing: 3 };

/**
 * Escalates the parent's display state to the most urgent of the parent's own state and its chicks' states.
 * A parent with a running chick is not put to sleep (prevents it from going into the nest in the garden), and
 * a parent whose chick just finished is woken up to done (actual problem: parent shown dozing next to a chick
 * done 10 seconds ago). Only dozing chicks are excluded — chicks themselves also fall from done → dozing when
 * left alone, so this gives a natural decay: "the parent wakes up only right after completion, and goes back
 * to sleep if left alone".
 */
function escalateWithChicks(state: BirdState, chicks: ChickView[]): BirdState {
  let escalated = state;
  for (const chick of chicks) {
    if (chick.state === "dozing") continue;
    if (STATE_URGENCY[chick.state] < STATE_URGENCY[escalated]) escalated = chick.state;
  }
  return escalated;
}

interface CacheEntry {
  size: number;
  lastModified: number;
  tail: TailInfo;
}

const tailCache = new Map<string, CacheEntry>();

/**
 * Tail read that reuses the cache when size and mtime are unchanged. Shared logic used by both
 * scanSessions (parents) and scanChicks (chicks) (the same pattern used to be duplicated in two places and
 * was merged). The parent side must call this before scanChicks — the chick completion check (the isChick
 * branch of deriveState) needs chickSignals from the parent tail
 * (see the comment in scanSessions for details).
 */
async function readTailCached(
  id: string,
  file: NativeFile,
  opts?: { includeSidechain?: boolean },
): Promise<TailInfo> {
  const cached = tailCache.get(id);
  if (cached && cached.size === file.size && cached.lastModified === file.lastModified) {
    return cached.tail;
  }
  const tail = await readTail(file, opts);
  // Bytes appended since the last read that are already outside the tail window may hold a user message
  // (anger mark input). Scan only that gap. Main transcripts only (chicks have no user messages)
  if (cached && !opts?.includeSidechain && file.size - cached.size > TAIL_BYTES) {
    // Read on to the end of the file (overlapping the window) so a line cut at the window's start isn't lost
    const end = file.size - TAIL_BYTES;
    const events = await readEventsInRange(file, Math.max(cached.size, end - MAX_GAP_BYTES), file.size);
    rememberUserMessage(id, lastUserMessage(events));
  }
  tailCache.set(id, { size: file.size, lastModified: file.lastModified, tail });
  return tail;
}

function rememberUserMessage(id: string, message: { at: number; text: string } | undefined): void {
  if (message && message.at >= (userMessageCache.get(id)?.at ?? -1)) userMessageCache.set(id, message);
}

async function readCodexTailCached(id: string, file: NativeFile): Promise<CodexTailInfo> {
  const cached = tailCache.get(id);
  if (cached && cached.size === file.size && cached.lastModified === file.lastModified) {
    return cached.tail as CodexTailInfo;
  }
  const tail = await readCodexTail(file);
  tailCache.set(id, { size: file.size, lastModified: file.lastModified, tail });
  return tail;
}

// key: chickId. Pruned when no longer displayed (meta.json is re-read if it reappears)
const chickMetaCache = new Map<string, ChickMeta>();
// key: session id. In sessions with huge tool output, the trailing 64KB window can fill up with tool results
// alone and contain no user message at all (this happened in practice).
// Remember the last seen snippet and keep showing it after it scrolls out of the window
const snippetCache = new Map<string, string>();
// key: session id. The latest message a person typed (anger mark input). For the same reason as snippetCache,
// and because a message can even be appended and pushed out of the window between two polls (a large tool
// result right after it), keep the last one seen so the mark can still be judged and cleared
const userMessageCache = new Map<string, { at: number; text: string }>();
// Upper limit of the bytes appended between two polls that are scanned outside the tail window for user messages
const MAX_GAP_BYTES = 2 * 1024 * 1024;
// key: parent session id. Ledger of background tasks (run_in_background) (key: task-id).
// Start lines (TailInfo.backgroundTaskStarts) scroll out of the tail window within tens of seconds (measured:
// already outside the window at the turn end 50 seconds after start), so remember them while visible.
// Completion is filled from the parent tail's chickSignals (task-id → time from <task-notification>).
// Used for the suppression check in deriveDoneEvent
type BackgroundTask = { startedAt: number; endedAt?: number };
const backgroundTaskCache = new Map<string, Map<string, BackgroundTask>>();

// Watching (docs/design.md "Watching"): per session (view id), the names of peers it exchanged inter-session
// messages with and the latest time for each. Kept across scans so that traces that left the tail window remain
const peerNameCache = new Map<string, Map<string, number>>();
// How far into the transcript the exchange traces have been read (end of scan_peer_names in Rust). To pick up
// traces outside the tail window too, the first read covers the whole file and later reads only the new part
const peerScanOffset = new Map<string, number>();
// Machine state and last write time of each session (sessionId) in the previous scan. Used to decide whether
// a peer is active, and for the watching done suppression (peers are passed in the same way as chicks)
const lastPeerStates = new Map<string, { state: BirdState; lastWriteAt: number }>();
// Last time a peer was active (sessionId → epoch ms). Used for the watching grace period (lib/watching.ts)
const peerLastActiveAt = new Map<string, number>();
// Log only when the result of resolving link names changes
let lastWatchSignature = "";

interface LiveSession {
  pid: number;
  sessionId: string;
  name?: string;
  cwd?: string;
  status?: string;
  startedAt?: number;
}

/** The <config> of a Claude Code watched folder (<config>/projects) */
function configDirOf(root: RootEntry): string {
  const path = root.path.replace(/\/+$/, "");
  return path.slice(0, path.lastIndexOf("/"));
}

/**
 * Reads <config>/sessions/*.json for each watched folder (<config>/projects) (live_sessions in Rust).
 * sessions are those of running processes. presentConfigDirs are the <config>s that have <config>/sessions
 */
async function loadLiveSessions(roots: RootEntry[]): Promise<{
  sessions: LiveSession[];
  presentConfigDirs: Set<string>;
  unreliableConfigDirs: Set<string>;
  unreadable: number;
}> {
  const configDirs = new Set(roots.filter((r) => r.kind === "claude").map(configDirOf));
  const scans = await Promise.all(
    [...configDirs].map(async (configDir) => {
      const scan = await invoke<{ present: boolean; sessions: LiveSession[]; reliable: boolean; unreadable: number }>(
        "live_sessions",
        { configDir },
      ).catch(() => ({ present: false, sessions: [] as LiveSession[], reliable: false, unreadable: 0 }));
      return { configDir, ...scan };
    }),
  );
  return {
    sessions: scans.flatMap((s) => s.sessions),
    presentConfigDirs: new Set(scans.filter((s) => s.present).map((s) => s.configDir)),
    // Reads where ps failed or sessions/*.json had an unreadable file. Birds are not removed based on this read
    unreliableConfigDirs: new Set(scans.filter((s) => !s.reliable).map((s) => s.configDir)),
    unreadable: scans.reduce((n, s) => n + s.unreadable, 0),
  };
}

// Birds of sessions whose process has ended are removed right away (docs/design.md "Removing birds of ended
// sessions"). The check doesn't depend on the terminal type.
// Claude Code writes <config>/sessions/<pid>.json right after it starts and deletes it when it ends (measured:
// every remaining file had a live pid). The transcript isn't created until the first message, so "there is a
// transcript but no live sessions file" normally means the process has ended.
// - A session this app has seen alive at least once while running is removed on the next read after it
//   disappears (within a few seconds)
// - One never seen (e.g. a session that ended before the app started) is removed if the transcript has had no
//   write for NEVER_SEEN_GRACE_MS. The grace keeps it from being removed when, right after startup, the file
//   write lags behind the transcript
// - Watched folders without <config>/sessions (older versions), Codex, and SDK-started sessions are excluded
//   (30 minutes as before)
// - Nothing is removed on a read where ps failed or sessions/*.json had an unreadable file (Claude Code rewrites
//   this file every time its state changes, so a half-written file may be read). A session is removed only when
//   it was not seen in MISSES_TO_END consecutive reads
const NEVER_SEEN_GRACE_MS = 15_000;
const MISSES_TO_END = 2;
// Number of consecutive reads where it was not seen (view id). Cleared when seen
const missCounts = new Map<string, number>();
// Per-read record (for investigating fix18. Written to app-log only when the TOMARIGI_SCAN_LOG env var is set)
let scanLogEnabled: boolean | undefined;
// Sessions seen alive (view id). Kept even after removal (dropping it would bring the bird back during the
// grace period), and pruned once it leaves the 30-minute window
const seenAliveIds = new Set<string>();

function sessionIdOfViewId(id: string): string {
  const file = id.split("/")[2] ?? "";
  return file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) : file;
}
const sessionEventCache = new Map<string, SessionEvent>(); // key: SessionEvent.key. Deduplicates the same event
const MAX_EVENTS = 30;

// Persistent event log for debugging (the debug dialog). Unlike sessionEventCache it is not cleared by the
// 30-minute TTL; only the last MAX_EVENT_LOG entries are kept. knownLogKeys is an all-time marker of "has this
// ever been written to the log", and acts as a barrier against double appends to the log even when the same
// event is re-derived from the tail after sessionEventCache pruned it by the 30-minute TTL (which looks like
// a "new insert" from cacheEvent's point of view).
const MAX_EVENT_LOG = 500;
let eventLog: SessionEvent[] = []; // in append order (last is newest). The persisted data itself
const knownLogKeys = new Set<string>();
let eventLogDirty = false; // whether this scan appended anything new to the persistent log. Saved once at the end of scanSessions
// Right after startup, restoring the persistent log (async) hasn't finished. A "new insert" that arrives
// before restoring can't be told apart from restored keys and would be appended twice, so it is held in
// pending until restoring completes, then merged all at once.
// "failed" is not turned into a "restore failed, so it's fine to continue empty" state —
// this log is the only copy and can't be re-derived, so calling saveEventLog in the pre-restore state and
// overwriting it with nothing (or only this scan's events) would erase the existing history.
// On failure it stays fixed at "failed" and never passes the save gate (=== "done") at the end of scanSessions.
let eventLogHydration: "none" | "loading" | "done" | "failed" = "none";
const pendingLogEvents: SessionEvent[] = [];

// The set of current SessionEvent["type"] values. Even if a retired type (formerly "harsh": removed along with
// the LLM judgement feature; generated by lib/harassment.ts) remains in the persistent log, the reading side
// (places that check against this set) safely ignores it. Existing records in IndexedDB are left as-is without
// migration, but are excluded from display and re-saving from then on
const KNOWN_EVENT_TYPES = new Set<SessionEvent["type"]>([
  "started",
  "done",
  "waiting",
  "closed",
]);

function isKnownEventType(type: string): type is SessionEvent["type"] {
  return KNOWN_EVENT_TYPES.has(type as SessionEvent["type"]);
}

function hydrateEventLog(): void {
  if (eventLogHydration !== "none") return;
  eventLogHydration = "loading";
  void (async () => {
    try {
      const saved = await loadEventLog<SessionEvent>();
      if (saved) {
        // Retired types (formerly "harsh" etc.) are excluded from re-saving and display (see KNOWN_EVENT_TYPES above)
        eventLog = saved.filter((e) => isKnownEventType(e.type));
        for (const e of eventLog) knownLogKeys.add(e.key);
      }
      eventLogHydration = "done";
      // Merge what was missed before restoring finished. appendToEventLog rejects known keys
      for (const event of pendingLogEvents) appendToEventLog(event);
      pendingLogEvents.length = 0;
    } catch (e) {
      // Not set to "done", to avoid the risk of overwriting existing history (saving stops for good).
      // pending will never be persisted now, so discard it (not kept in memory for the rest of this
      // session either; cacheEvent also stops adding to pending once "failed")
      console.warn("[tomarigi] failed to restore the event log", e);
      eventLogHydration = "failed";
      pendingLogEvents.length = 0;
    }
  })();
}

/**
 * The actual append to the persistent log. knownLogKeys prevents duplicates across all time, and only the
 * last MAX_EVENT_LOG entries are kept. assistantText (temporary field for the readout summary, max 2000
 * chars) is not written — there is no reason to pile up several KB per entry in IndexedDB for a field used
 * only for speech, so it is stripped right before persisting
 * (the in-memory sessionEventCache keeps it as-is; see cacheEvent).
 */
function appendToEventLog(event: SessionEvent): void {
  if (knownLogKeys.has(event.key)) return;
  knownLogKeys.add(event.key);
  const { assistantText: _assistantText, ...persisted } = event;
  eventLog.push(persisted);
  if (eventLog.length > MAX_EVENT_LOG) {
    const removed = eventLog.shift();
    if (removed) knownLogKeys.delete(removed.key);
  }
  eventLogDirty = true;
}

/**
 * Inserts into sessionEventCache are first-write-wins (a later value never overwrites the same key).
 * For event types, at comes from the transcript and never changes, so first-write-wins doesn't change behavior.
 * Only events "actually newly inserted into the Map" are also sent to the persistent log (so that even though
 * cacheEvent is called every scan, the same event isn't added to the log twice).
 */
function cacheEvent(event: SessionEvent): void {
  if (sessionEventCache.has(event.key)) return;
  sessionEventCache.set(event.key, event);
  hydrateEventLog(); // the first call starts restoring (no-op afterwards)
  if (eventLogHydration === "done") {
    appendToEventLog(event);
  } else if (eventLogHydration !== "failed") {
    // With "failed" restoring has been given up, so stop adding to pending from then on
    // (prevents unbounded growth; appending to the persistent log is given up for this session)
    pendingLogEvents.push(event);
  }
}

const SNIPPET_MAX_WIDTH = 24; // max display width (in half-width units). Overflow becomes "…"

// Full-width characters (CJK, kana, etc.) are about twice as wide as half-width ones, so counting code points
// makes the display width differ between Japanese and English. Count in half-width units (full-width = 2,
// half-width = 1). The approximation "everything except ASCII and half-width kana is full-width" is enough
// (snippets don't need exact layout calculation)
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code <= 0xff) return 1; // ASCII, Latin-1
  if (code >= 0xff61 && code <= 0xffdc) return 1; // half-width kana
  return 2;
}

/**
 * Picks the snippet that shows "what this session is being asked to do right now". Walks the user events
 * (with text) in tail.events from newest, and takes the first "usable" text. Short instructions ("push" etc.)
 * are still information as prompts, so they aren't rejected. undefined if none is found (e.g. a session with
 * only machine text)
 */
function pickSnippet(tail: TailInfo): string | undefined {
  for (let i = tail.events.length - 1; i >= 0; i--) {
    const event = tail.events[i];
    if (event.kind !== "user" || !event.text) continue;
    const snippet = formatSnippet(event.text);
    if (snippet) return snippet;
  }
  return undefined;
}

/**
 * The latest message a person typed (anger mark input). Skips lines marked as not from a person
 * (task-notification etc.) and machine text that formatSnippet rejects (slash command echoes, bash-input,
 * [Request interrupted, ...). The at is the same as that message's started event
 */
function lastUserMessage(events: TailEvent[]): { at: number; text: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind !== "user" || event.machine || !event.text) continue;
    if (!formatSnippet(event.text)) continue;
    return { at: event.at, text: event.text };
  }
  return undefined;
}

// Rejects text unusable as a snippet and formats the rest: machine text (slash command <command- tags,
// [SYSTEM notices, [Request interrupted, etc.) gives undefined.
// "[Image #N]" marks an image attachment followed by the body, so strip it and use the body.
// Newlines and runs of whitespace are normalized to a single space, then cut at the display width limit
// (full-width = 2, half-width = 1)
function formatSnippet(rawText: string): string | undefined {
  let normalized = rawText.trim().replace(/\s+/g, " ");
  normalized = normalized.replace(/^(\[Image #\d+\]\s*)+/, "");
  if (!normalized) return undefined;
  if (normalized.startsWith("<")) return undefined;
  if (normalized.startsWith("[SYSTEM") || normalized.startsWith("[Request interrupted")) {
    return undefined;
  }
  let width = 0;
  let cut = normalized.length; // position (string index) where the limit was reached. The end if never reached
  for (let i = 0; i < normalized.length; ) {
    const ch = String.fromCodePoint(normalized.codePointAt(i) ?? 0);
    width += charWidth(ch);
    i += ch.length;
    if (width > SNIPPET_MAX_WIDTH) {
      cut = i - ch.length;
      break;
    }
  }
  if (cut >= normalized.length) return normalized;
  return `${normalized.slice(0, cut)}…`;
}

// One scan result inside scanSessions. The same shape is used for found, withTail, and SDK chick distribution
interface FoundEntry {
  agent: "claude" | "codex";
  rootId: string;
  rootLabel: string;
  slug: string; // project directory name (under ~/.claude*/projects/). Also part of the grouping key when
  // narrowing SDK chicks' parent candidates to "the same project directory"
  file: NativeFile;
  id: string;
  tail: TailInfo;
  chicks: ChickScan[]; // subagent chicks found by scanChicks (SDK chicks are not included here)
}

interface CodexRollout {
  file: NativeFile;
  path: string;
}

/**
 * Codex stores rollouts below YYYY/MM/DD. Only today and yesterday can contain a
 * session inside ACTIVE_WINDOW_MS, so avoid walking the user's entire history on
 * every three-second poll. Both ~/.codex/sessions and ~/.codex are accepted.
 */
async function findRecentCodexRollouts(
  selectedRoot: NativeDirectoryHandle,
  now: number,
): Promise<CodexRollout[]> {
  let sessionsDir = selectedRoot;
  if (selectedRoot.name !== "sessions") {
    try {
      sessionsDir = await selectedRoot.getDirectoryHandle("sessions");
    } catch {
      return [];
    }
  }

  const dates = [new Date(now), new Date(now - 24 * 60 * 60_000)];
  const seen = new Set<string>();
  const rollouts: CodexRollout[] = [];
  for (const date of dates) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const datePath = `${year}/${month}/${day}`;
    if (seen.has(datePath)) continue;
    seen.add(datePath);

    try {
      const yearDir = await sessionsDir.getDirectoryHandle(year);
      const monthDir = await yearDir.getDirectoryHandle(month);
      const dayDir = await monthDir.getDirectoryHandle(day);
      for await (const entry of dayDir.values()) {
        if (entry.kind !== "file" || !entry.name.endsWith(".jsonl")) continue;
        const file = await (entry as NativeFileHandle).getFile();
        rollouts.push({ file, path: `${datePath}/${entry.name}` });
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
    }
  }
  return rollouts;
}

export async function scanSessions(roots: RootEntry[]): Promise<ScanResult> {
  const now = Date.now();
  const found: FoundEntry[] = [];
  const brokenIds: string[] = [];
  // ids of sessions whose tail was read but which were excluded from display (sdk-cli, Codex internal rollouts).
  // They aren't in found, but pruning them from tailCache would re-read them every 3 seconds, so keep them
  const skippedIds = new Set<string>();

  for (const root of roots) {
    try {
      if (root.kind === "claude") {
        for await (const entry of root.handle.values()) {
          if (entry.kind !== "directory") continue;
          const projectDir = entry as NativeDirectoryHandle;
          for await (const child of projectDir.values()) {
            if (child.kind !== "file" || !child.name.endsWith(".jsonl")) continue;
            const file = await (child as NativeFileHandle).getFile();
            // This is a rough cutoff before reading the tail (for speed), so mtime is fine here: mtime can
            // run ahead of the actual last conversation time (tail.lastEventAt) but never behind it, so a
            // session passing this check can never actually be past ACTIVE_WINDOW_MS
            // (a rough filter on the safe side. The exact time basis is tail.lastEventAt in the sinceMs calculation below)
            if (now - file.lastModified > ACTIVE_WINDOW_MS) continue;
            const id = `${root.id}/${projectDir.name}/${child.name}`;
            // The completion check for chicks (subagents) treats the parent ledger (chickSignals in the parent
            // tail) as the source of truth, so read the parent's tail before scanChicks (see the isChick comment
            // in deriveState). The tail read here is reused when building withTail below (to compute cwd/base
            // name), so it isn't read twice
            const tail = await readTailCached(id, file);
            // `claude -p` (entrypoint "sdk-cli") is out of scope for tomarigi (no birds, no events).
            // Most are started in the background by Claude Code as a command; neither child nor parent keeps the
            // other's id, so they can't be tied to a parent reliably (cwd is the launch directory too, with no
            // parent in the same directory). The launching parent's done is handled by background task
            // suppression (deriveDoneEvent). A `claude -p` typed by hand prints its result in that terminal,
            // so there is little need to watch it
            if (tail.entrypoint === "sdk-cli") {
              skippedIds.add(id);
              continue;
            }
            const chicks = await scanChicks(projectDir, child.name, id, now, tail.chickSignals);
            found.push({
              agent: "claude",
              rootId: root.id,
              rootLabel: root.label,
              slug: projectDir.name,
              file,
              id,
              tail,
              chicks,
            });
          }
        }
      }

      if (root.kind === "codex") {
        for (const { file, path } of await findRecentCodexRollouts(root.handle, now)) {
          if (now - file.lastModified > ACTIVE_WINDOW_MS) continue;
          const id = `${root.id}/codex/${path}`;
          const tail = await readCodexTailCached(id, file);
          // Internal rollouts (subagents, guardian reviews, and future non-user sources) can
          // complete repeatedly while the parent is still working. Treating them as independent
          // sessions duplicates birds and emits false done events. Older rollouts may not have
          // thread_source, so keep those for backward compatibility and reject only explicit
          // non-user sources.
          if (tail.threadSource !== undefined && tail.threadSource !== "user") {
            skippedIds.add(id);
            continue;
          }
          const cwd = tail.cwd;
          const slug = cwd ? `codex:${cwd}` : `codex:${file.name}`;
          found.push({
            agent: "codex",
            rootId: root.id,
            rootLabel: root.label,
            slug,
            file,
            id,
            tail,
            chicks: [],
          });
        }
      }
    } catch (e) {
      console.warn("[tomarigi] failed to scan root", root.id, e);
      brokenIds.push(root.id);
    }
  }

  // Remove sessions whose process has ended (together with their chicks) from display (see the
  // NEVER_SEEN_GRACE_MS comment). Their tail has been read, so add them to skippedIds to keep them in tailCache
  const { sessions: liveSessions, presentConfigDirs, unreliableConfigDirs, unreadable } = await loadLiveSessions(roots);
  const liveSessionIds = new Set(liveSessions.map((l) => l.sessionId));
  const configDirByRoot = new Map(roots.filter((r) => r.kind === "claude").map((r) => [r.id, configDirOf(r)]));
  const endedIds = new Set<string>();
  const foundIds = new Set(found.map((f) => f.id));
  for (const id of seenAliveIds) if (!foundIds.has(id)) seenAliveIds.delete(id);
  for (const id of missCounts.keys()) if (!foundIds.has(id)) missCounts.delete(id);
  for (const f of found) {
    if (f.agent !== "claude" || /^sdk/.test(f.tail.entrypoint ?? "")) continue;
    const configDir = configDirByRoot.get(f.rootId);
    if (configDir === undefined || !presentConfigDirs.has(configDir)) continue;
    if (liveSessionIds.has(sessionIdOfViewId(f.id))) {
      seenAliveIds.add(f.id);
      missCounts.delete(f.id);
      continue;
    }
    // If this read's result is unreliable, neither remove nor count
    if (unreliableConfigDirs.has(configDir)) continue;
    const seen = seenAliveIds.has(f.id);
    if (!seen && now - f.file.lastModified <= NEVER_SEEN_GRACE_MS) continue;
    const misses = (missCounts.get(f.id) ?? 0) + 1;
    missCounts.set(f.id, misses);
    if (misses < MISSES_TO_END) continue;
    endedIds.add(f.id);
    // Log each time it is removed (so flickering on and off can be traced). Not logged on every read while it stays removed
    if (misses === MISSES_TO_END) {
      const line = `[live] ended ${f.id} seenAlive=${seen} misses=${misses} idleMs=${now - f.file.lastModified}`;
      void invoke("log", { line }).catch(() => {});
    }
  }
  if (endedIds.size > 0) {
    for (const f of found) if (endedIds.has(f.id)) skippedIds.add(f.id);
    found.splice(0, found.length, ...found.filter((f) => !endedIds.has(f.id)));
    // Also remove from Recent activity (the latest card per session)
    for (const [key, event] of sessionEventCache) if (endedIds.has(event.sessionId)) sessionEventCache.delete(key);
  }

  // Turning sessions started via the SDK (Claude Agent SDK) into chicks. The entrypoint field is an
  // internal spec; cli/sdk-py were confirmed in real data (2026-08-08; see the comment on TailInfo.entrypoint).
  // Sessions where it can't be read because the tail window has no line with entrypoint stay undefined
  // = there is no basis to conclude they were SDK-started, so err on the safe side and keep treating them as cli (adults).
  const SDK_ENTRYPOINT_RE = /^sdk/;
  const isSdkSession = (f: FoundEntry) =>
    f.agent === "claude" && SDK_ENTRYPOINT_RE.test(f.tail.entrypoint ?? "");
  // Use the same time basis as the state check (tail.lastEventAt, else file.lastModified; see the comment on
  // TailInfo.lastEventAt) for choosing parent candidates too
  const effectiveLastEventAt = (f: FoundEntry) => f.tail.lastEventAt ?? f.file.lastModified;

  const sdkEntries = found.filter(isSdkSession);
  const nonSdkEntries = found.filter((f) => !isSdkSession(f));

  // Parent candidate: within "the same project directory" = same root and same slug, the non-SDK session with
  // the newest last conversation time. found is still every entry already cut off by ACTIVE_WINDOW_MS, and
  // non-SDK sessions always become displayed via withTail after this, so the "is displayed" condition is also
  // satisfied automatically
  const parentCandidateByGroup = new Map<string, FoundEntry>(); // key: `${rootId}/${slug}`
  for (const f of nonSdkEntries) {
    const key = `${f.rootId}/${f.slug}`;
    const current = parentCandidateByGroup.get(key);
    if (!current || effectiveLastEventAt(f) > effectiveLastEventAt(current)) {
      parentCandidateByGroup.set(key, f);
    }
  }

  // SDK sessions are collected as chicks (ChickScan) keyed by the parent candidate's id. Orphans with no parent
  // candidate (= no other non-SDK session in the same project directory) are not dropped but fall back to being
  // shown as adult birds as before (orphanSdkEntries).
  // Parent candidates are only recomputed on each scan (not persisted), so when a newer non-SDK session appears
  // the SDK chick naturally moves to it (never tied to the previous parent again)
  const sdkChicksByParentId = new Map<string, ChickScan[]>();
  const orphanSdkEntries: FoundEntry[] = [];
  for (const f of sdkEntries) {
    const parent = parentCandidateByGroup.get(`${f.rootId}/${f.slug}`);
    if (!parent) {
      orphanSdkEntries.push(f);
      continue;
    }
    const sinceMs = now - effectiveLastEventAt(f);
    // The chick id is fixed based on the file name (stable even when the parent changes. File names are unique
    // within a project directory, so combined with slug they don't collide across roots).
    // It is in a separate "sdk:" namespace from existing subagent chick ids (`${parent id}/${file name}`) and
    // SessionEvent.key (`${sessionId}:${at}:${type}`, always derived from the parent id), so it collides with
    // neither chickMetaCache nor event deduplication
    const chickId = `sdk:${f.slug}/${f.file.name}`;
    const view: ChickView = {
      id: chickId,
      name: "SDK", // no meta.json exists (SDK starts don't have one), so a fixed name instead of resolveChickMeta
      // The parent ledger (chickSignals) has no completion signal for SDK chicks (it is a mechanism on the
      // parent transcript side, so it doesn't appear in the SDK session's own tail). Use the dedicated
      // deriveSdkChickState instead of deriveState (see the comment on its definition for why)
      state: deriveSdkChickState(f.tail, sinceMs),
      sinceMs,
      toolName: f.tail.kind === "tool_use" ? f.tail.toolName : undefined,
    };
    const list = sdkChicksByParentId.get(parent.id) ?? [];
    list.push({ view });
    sdkChicksByParentId.set(parent.id, list);
  }

  // Displayed entries (those that can become a SessionView) = non-SDK sessions + SDK orphans with no parent candidate
  const displayEntries = [...nonSdkEntries, ...orphanSdkEntries];

  // Compute the display name table per root (fallback for sessions without a cwd. Stripping the common prefix
  // of slugs only makes sense within a root). Computing from found (all entries including SDK) gives the same
  // result as displayEntries (an SDK session's slug is always shared with some displayed session), but we
  // simply use every scanned entry
  const labelsByRoot = new Map<string, Map<string, string>>();
  for (const root of roots) {
    const slugs = [...new Set(found.filter((f) => f.rootId === root.id).map((f) => f.slug))];
    labelsByRoot.set(root.id, projectLabels(slugs));
  }

  // The base name prefers cwd when available (it matches across roots, so the duplicate detection below can
  // detect the same project). The tail was already read in the loop above.
  // isSdk is used for the state branch (switching between deriveState/deriveSdkChickState in the loop below).
  // The deriveSdkChickState fix for "stuck in working when ending on a structured output tool" also needs to
  // apply to orphanSdkEntries (the adult-display fallback for SDK sessions with no parent candidate), so the
  // isSdkSession result is carried along here
  const withTail: (FoundEntry & { base: string; isSdk: boolean })[] = [];
  for (const f of displayEntries) {
    const base = f.tail.cwd
      ? basename(f.tail.cwd)
      : (labelsByRoot.get(f.rootId)?.get(f.slug) ?? f.slug);
    withTail.push({ ...f, base, isSdk: isSdkSession(f) });
  }

  // Tally which roots each display name (without the root label) appears in, and append the root label only
  // to names duplicated across different roots to tell them apart
  const baseNameRoots = new Map<string, Set<string>>();
  for (const f of withTail) {
    if (!baseNameRoots.has(f.base)) baseNameRoots.set(f.base, new Set());
    baseNameRoots.get(f.base)?.add(f.rootId);
  }


  // Watching links (docs/design.md "Watching"). Match the names of peers exchanged with against the names of
  // running sessions to get sessionIds, and link both ways (a trace on either side counts as linked)
  const liveByName = new Map<string, LiveSession>();
  const liveBySessionId = new Map<string, LiveSession>();
  for (const live of liveSessions) {
    if (live.name) liveByName.set(live.name, live);
    liveBySessionId.set(live.sessionId, live);
  }
  const viewIdBySessionId = new Map<string, string>();
  const links = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    if (!links.has(a)) links.set(a, new Set());
    links.get(a)?.add(b);
  };
  const claudeEntries = withTail.filter((f) => f.agent === "claude");
  await Promise.all(
    claudeEntries.map(async (f) => {
      try {
        const scan = await invoke<{ names: [string, string][]; end: number }>("scan_peer_names", {
          path: f.file.path,
          start: peerScanOffset.get(f.id) ?? 0,
        });
        peerScanOffset.set(f.id, scan.end);
        let names = peerNameCache.get(f.id);
        if (!names) {
          names = new Map();
          peerNameCache.set(f.id, names);
        }
        for (const [name, timestamp] of scan.names) {
          const at = Date.parse(timestamp);
          if (Number.isFinite(at)) names.set(name, Math.max(names.get(name) ?? 0, at));
        }
      } catch {
        // If it can't be read, decide only from the traces within the tail window (tail.peerNames)
      }
    }),
  );
  for (const f of claudeEntries) {
    const ownSessionId = sessionIdOfViewId(f.id);
    viewIdBySessionId.set(ownSessionId, f.id);
    let names = peerNameCache.get(f.id);
    if (!names) {
      names = new Map();
      peerNameCache.set(f.id, names);
    }
    for (const [name, at] of f.tail.peerNames) names.set(name, Math.max(names.get(name) ?? 0, at));
    for (const name of names.keys()) {
      const peer = liveByName.get(name);
      if (!peer) continue;
      link(ownSessionId, peer.sessionId);
      link(peer.sessionId, ownSessionId);
    }
  }
  const peerLinksOf = (ownSessionId: string): PeerLink[] =>
    [...(links.get(ownSessionId) ?? [])].map((sessionId) => {
      const live = liveBySessionId.get(sessionId);
      const last = lastPeerStates.get(sessionId);
      return {
        sessionId,
        viewId: viewIdBySessionId.get(sessionId),
        name: live?.name ?? sessionId.slice(0, 8),
        cwd: live?.cwd,
        startedAt: live?.startedAt,
        active: isPeerActive(live?.status, last?.state),
        lastActiveAt: peerLastActiveAt.get(sessionId),
      };
    });
  const watchSignature = [...links.entries()]
    .map(([a, bs]) => `${liveBySessionId.get(a)?.name ?? a.slice(0, 8)} <-> ${[...bs].map((b) => liveBySessionId.get(b)?.name ?? b.slice(0, 8)).sort().join(", ")}`)
    .sort()
    .join("\n");
  if (watchSignature !== lastWatchSignature) {
    lastWatchSignature = watchSignature;
    // Log only the name mapping (message bodies are neither read nor logged)
    void invoke("log", { line: `[watch] links\n${watchSignature || "(none)"}` }).catch(() => {});
  }

  const views: SessionView[] = [];

  for (const { rootLabel, file, id, chicks, tail, base, slug, isSdk } of withTail) {
    const ambiguous = (baseNameRoots.get(base)?.size ?? 0) > 1;
    // The time basis for the state check is tail.lastEventAt (the last time of a line with a timestamp).
    // Later appends without a timestamp (last-prompt etc., a touch on a dead transcript hours later) only
    // advance file.lastModified, so using mtime as the basis makes ended sessions reappear (see the comment on
    // TailInfo.lastEventAt). Falls back to mtime only in the rare case where the tail window has no line with a timestamp
    const sinceMs = now - (tail.lastEventAt ?? file.lastModified);
    const project = ambiguous ? `${base} (${rootLabel})` : base;
    // Subagent chicks (from scanChicks) and SDK chicks (those for which this session was chosen as parent
    // candidate) are carried as separate lists and used differently depending on the destination.
    // - subagentChickViews (without SDK): passed only to deriveSessionEvents (done suppression check).
    //   SDK chicks are not children the parent started but unrelated processes running alongside, so an SDK
    //   chick merely running must not trigger the parent's done suppression (see the deriveDoneEvent comment;
    //   the suppression premise "a child the parent started" doesn't hold for SDK chicks).
    // - chickViews (merged with SDK): passed with SDK chicks included, as before, to escalateWithChicks
    //   (display escalation) and SessionView.chicks (display). Excluding them from escalation would make a
    //   running SDK chick vanish into the nest with the parent the moment the parent turns dozing, a visibility
    //   regression compared to before they became chicks (when they were visible as adult birds), so they are
    //   deliberately kept on the display side.
    const subagentChickViews = chicks.map((c) => c.view);
    const sdkChickViews = (sdkChicksByParentId.get(id) ?? []).map((c) => c.view);
    const chickViews = [...subagentChickViews, ...sdkChickViews].sort(
      (a, b) => a.sinceMs - b.sinceMs,
    );
    // deriveState is the only source for the "appearance (bird)". However, SDK orphans (SDK sessions with no
    // parent candidate that fell back to adult display, isSdk===true) use deriveSdkChickState —
    // the problem of getting stuck in working when ending on a structured output tool (tool_result) is still
    // unfixed in deriveState (see the deriveSdkChickState comment)
    const tailState = isSdk ? deriveSdkChickState(tail, sinceMs) : deriveState(tail, sinceMs, false);
    // While Claude Code shows choices (AskUserQuestion) or a permission prompt, it doesn't write that tool_use
    // to the transcript yet (it writes it after the answer). Instead the status in <config>/sessions/<pid>.json
    // becomes "waiting", so treat that as needs reply
    const state: BirdState =
      !isSdk && liveBySessionId.get(sessionIdOfViewId(id))?.status === "waiting" ? "waiting" : tailState;
    // The display state is escalated to a chick's urgency while the chick is running (anything but done/dozing)
    const displayState = escalateWithChicks(state, chickViews);
    // Always attach the latest user message snippet ("what this session was asked to do" is the main info).
    // If there is no message in the window, use the last remembered snippet instead
    const snippet = pickSnippet(tail) ?? snippetCache.get(id);
    if (snippet) snippetCache.set(id, snippet);
    const peers = peerLinksOf(sessionIdOfViewId(id));
    const watching = watchingCount(displayState, peers, now);
    const last = tail.events[tail.events.length - 1];
    const reply =
      (displayState === "done" || displayState === "dozing") &&
      last?.kind === "assistant_text" &&
      last.text
        ? { at: last.at, text: last.text }
        : undefined;
    const question =
      displayState === "waiting" && last?.kind === "tool_use" ? extractQuestion(last.text) : undefined;
    rememberUserMessage(id, lastUserMessage(tail.events));
    const userMessage = userMessageCache.get(id);
    views.push({
      id,
      project,
      slug,
      state: displayState,
      sinceMs,
      toolName: tail.kind === "tool_use" ? tail.toolName : undefined,
      chicks: chickViews.length > 0 ? chickViews : undefined,
      snippet,
      reply,
      question,
      userMessage,
      peers: peers.length > 0 ? peers : undefined,
      watching,
      cwd: tail.cwd,
      startedAt: liveBySessionId.get(sessionIdOfViewId(id))?.startedAt,
    });
    // Only done also looks at the chicks' (subagents') status: while a chick is running it is still too early
    // as a "come back" signal. SDK chicks are not included here (see the comment above)
    const backgroundTasks = updateBackgroundTasks(id, tail);
    // A watching session's done is not emitted until all linked peers have stopped. Peers are passed to the
    // deriveDoneEvent suppression the same way as chicks (active peers as running chicks, stopped peers with
    // their last write time)
    const peerChicks: ChickView[] = peers.flatMap((p) => {
      const lastState = lastPeerStates.get(p.sessionId);
      if (p.active) return [{ id: `peer:${p.sessionId}`, name: p.name, state: "working" as const, sinceMs: 0 }];
      if (!lastState) return [];
      return [{ id: `peer:${p.sessionId}`, name: p.name, state: lastState.state, sinceMs: now - lastState.lastWriteAt }];
    });
    for (const event of deriveSessionEvents(
      tail,
      id,
      project,
      [...subagentChickViews, ...peerChicks],
      backgroundTasks,
      snippet,
      now,
    )) {
      cacheEvent(event);
    }
  }

  for (const view of views) {
    lastPeerStates.set(sessionIdOfViewId(view.id), { state: view.state, lastWriteAt: now - view.sinceMs });
  }
  // The last time each peer was active, used for the watching grace period. Now if it is active now, otherwise
  // the last transcript write (so that even right after the app restarts, we know the peer was active a moment ago)
  for (const [sessionId, last] of lastPeerStates) {
    const active = isPeerActive(liveBySessionId.get(sessionId)?.status, last.state);
    const seen = active ? now : last.lastWriteAt;
    peerLastActiveAt.set(sessionId, Math.max(peerLastActiveAt.get(sessionId) ?? 0, seen));
  }
  for (const sessionId of peerLastActiveAt.keys()) if (!lastPeerStates.has(sessionId)) peerLastActiveAt.delete(sessionId);
  for (const key of lastPeerStates.keys()) {
    if (!viewIdBySessionId.has(key) && !liveBySessionId.has(key)) lastPeerStates.delete(key);
  }

  views.sort((a, b) => STATE_URGENCY[a.state] - STATE_URGENCY[b.state] || a.sinceMs - b.sinceMs);

  if (scanLogEnabled === undefined) {
    scanLogEnabled = await invoke<boolean>("scan_log_enabled").catch(() => false);
  }
  if (scanLogEnabled) logScan(views, liveSessions, unreliableConfigDirs, unreadable, endedIds);

  // Prune caches for entries that left the 30-minute window. Even if sessions pile up day after day with the
  // app left open (PiP always on), the caches only hold what is displayed
  const liveIds = new Set<string>();
  for (const f of found) {
    liveIds.add(f.id);
    for (const c of f.chicks) liveIds.add(c.view.id);
  }
  for (const key of tailCache.keys()) {
    if (!liveIds.has(key) && !skippedIds.has(key)) tailCache.delete(key);
  }
  for (const key of chickMetaCache.keys()) if (!liveIds.has(key)) chickMetaCache.delete(key);
  for (const key of snippetCache.keys()) if (!liveIds.has(key)) snippetCache.delete(key);
  for (const key of userMessageCache.keys()) if (!liveIds.has(key)) userMessageCache.delete(key);
  for (const key of backgroundTaskCache.keys()) if (!liveIds.has(key)) backgroundTaskCache.delete(key);
  for (const key of peerNameCache.keys()) if (!liveIds.has(key)) peerNameCache.delete(key);
  for (const key of peerScanOffset.keys()) if (!liveIds.has(key)) peerScanOffset.delete(key);

  // Drop events older than ACTIVE_WINDOW_MS (every poll re-parses the tail, so this caps what accumulates
  // even after deduplication)
  for (const [key, event] of sessionEventCache) {
    if (now - event.at > ACTIVE_WINDOW_MS) sessionEventCache.delete(key);
  }
  const events = [...sessionEventCache.values()].sort((a, b) => b.at - a.at).slice(0, MAX_EVENTS);

  // The persistent event log is written once at the end of this scan rather than on every cacheEvent (scans
  // with no new events don't write). The dirty flag can be set not only by appendToEventLog via cacheEvent but
  // also by the pending merge in hydrateEventLog
  if (eventLogDirty && eventLogHydration === "done") {
    eventLogDirty = false;
    void saveEventLog(eventLog).catch((e) => {
      console.warn("[tomarigi] failed to save the event log", e);
    });
  }

  return { views, brokenIds, events };
}

// ids that were in views on the previous read (the per-read record uses this to log birds that disappeared or came back)
let lastScanViewIds = new Set<string>();

/**
 * Per-read record (for investigating fix18). One line per read. Logs birds with watching links, and birds that
 * disappeared or came back since the previous read. Whether a bird goes into the nest (disappears from the
 * garden) is an approximation of the same condition as isNested in garden.tsx
 * (dozing and not watching; the "?" isn't considered here)
 */
function logScan(
  views: SessionView[],
  live: LiveSession[],
  unreliableConfigDirs: Set<string>,
  unreadable: number,
  endedIds: Set<string>,
): void {
  const liveById = new Map(live.map((l) => [l.sessionId, l]));
  const ids = new Set(views.map((v) => v.id));
  const short = (id: string) => sessionIdOfViewId(id).slice(0, 8);
  const gone = [...lastScanViewIds].filter((id) => !ids.has(id)).map(short);
  const back = [...ids].filter((id) => !lastScanViewIds.has(id)).map(short);
  lastScanViewIds = ids;
  const linked = views
    .filter((v) => v.peers && v.peers.length > 0)
    .map((v) => {
      const own = liveById.get(sessionIdOfViewId(v.id));
      const peers = (v.peers ?? [])
        .map((p) => `${p.sessionId.slice(0, 8)}(${liveById.get(p.sessionId)?.status ?? "not-live"}/${lastPeerStates.get(p.sessionId)?.state ?? "-"}/${p.active ? "active" : "inactive"}/${p.viewId ? "view" : "noview"}/lastActive=${p.lastActiveAt ? Math.round((Date.now() - p.lastActiveAt) / 1000) + "s" : "-"})`)
        .join(",");
      const nest = v.state === "dozing" && v.watching === undefined;
      return `${v.project}#${short(v.id)} ${own?.name ?? "?"} live=${own ? own.status : "no"} state=${v.state} since=${Math.round(v.sinceMs / 1000)}s watching=${v.watching ?? "-"} nest=${nest} peers=[${peers}]`;
    });
  const line =
    `[scan] live=${live.length} unreliable=[${[...unreliableConfigDirs].join(",")}] unreadable=${unreadable} ` +
    `ended=[${[...endedIds].map(short).join(",")}] gone=[${gone.join(",")}] back=[${back.join(",")}]\n  ` +
    (linked.length > 0 ? linked.join("\n  ") : "(no linked)");
  void invoke("log", { line }).catch(() => {});
}

/**
 * Writes the Jev verdict to the persistent log entry of the same turn's done event (key = sessionId:at:done),
 * to see the probability in the debug dialog. Not written when the done isn't in the log yet (e.g. suppressed)
 */
export function recordAskJudgement(sessionId: string, at: number, ask: AskJudgement): void {
  const key = `${sessionId}:${at}:done`;
  const logged = eventLog.find((e) => e.key === key);
  if (!logged) return;
  logged.ask = ask;
  eventLogDirty = true;
}

/** Writes the abuse verdict to the persistent log entry of that message's started event (key = sessionId:at:started) */
export function recordAngerJudgement(sessionId: string, at: number, anger: AngerJudgement): void {
  const logged = eventLog.find((e) => e.key === `${sessionId}:${at}:started`);
  if (!logged) return;
  logged.anger = anger;
  eventLogDirty = true;
}

/** Entry point for DebugApp in the debug dialog to read the persistent event log.
 * The value type is owned here (lib/sessions.ts), so this wraps loadEventLog<T> from fsa.
 * Retired types (formerly "harsh" etc.) are ignored via KNOWN_EVENT_TYPES (same policy as hydrateEventLog) */
export async function loadPersistedEvents(): Promise<SessionEvent[]> {
  const saved = (await loadEventLog<SessionEvent>()) ?? [];
  return saved.filter((e) => isKnownEventType(e.type));
}

/**
 * Derives a session's transition events (started, waiting for reply, done, closed) from the tail's event list.
 * To avoid false detection of progress text in the middle of a turn, done counts only when the next classified
 * event is not tool_use/tool_result. In addition, if a chick (subagent) is still running it is too early as a
 * "come back" signal, so it is suppressed (deriveDoneEvent).
 * waiting treats a call to AskUserQuestion/ExitPlanMode as a definite wait for the user's answer, and ones
 * already answered are also emitted as history as-is (no timeout estimation).
 */
function deriveSessionEvents(
  tail: TailInfo,
  sessionId: string,
  project: string,
  chicks: ChickView[],
  backgroundTasks: Map<string, BackgroundTask>,
  snippet: string | undefined,
  now: number,
): SessionEvent[] {
  const result: SessionEvent[] = [];
  const events = tail.events;
  // Walk the event list tracking "the previous user message", and attach each event's own turn prompt.
  // Attaching the session's latest message (snippet) to everything would pin unrelated messages to past
  // events via the first-write-wins cache.
  // snippet is only used as a substitute when there is no message in the window
  let lastPrompt: string | undefined;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.kind === "user") {
      // A started event carries "the prompt itself". What was asked is the main info of this event, so it
      // isn't omitted even for short instructions or a single session
      const prompt = event.text ? formatSnippet(event.text) : undefined;
      if (prompt) lastPrompt = prompt;
      result.push(mkSessionEvent(sessionId, project, "started", event.at, prompt ?? snippet));
    } else if (event.kind === "closed") {
      result.push(mkSessionEvent(sessionId, project, "closed", event.at, lastPrompt ?? snippet));
    } else if (event.kind === "assistant_text") {
      const next = events[i + 1];
      if (!next || (next.kind !== "tool_use" && next.kind !== "tool_result")) {
        // The existence of next (= some event after T) is a definitive signal that the parent has already
        // restarted/continued (used for the cancel check in deriveDoneEvent)
        const parentAdvanced = next !== undefined;
        const done = deriveDoneEvent(
          sessionId,
          project,
          event.at,
          chicks,
          backgroundTasks,
          lastPrompt ?? snippet,
          now,
          parentAdvanced,
          event.text,
        );
        if (done) result.push(done);
      }
    } else if (event.kind === "tool_use" && isWaitingTool(event.toolName)) {
      result.push(mkSessionEvent(sessionId, project, "waiting", event.at, lastPrompt ?? snippet));
    }
  }
  return result;
}

/** Adds the starts and completions seen in the parent tail to backgroundTaskCache and returns that session's ledger */
function updateBackgroundTasks(sessionId: string, tail: TailInfo): Map<string, BackgroundTask> {
  let tasks = backgroundTaskCache.get(sessionId);
  if (!tasks) {
    tasks = new Map();
    backgroundTaskCache.set(sessionId, tasks);
  }
  for (const [taskId, startedAt] of tail.backgroundTaskStarts) {
    if (!tasks.has(taskId)) tasks.set(taskId, { startedAt });
  }
  for (const [taskId, task] of tasks) {
    const endedAt = tail.chickSignals.get(taskId);
    if (endedAt !== undefined && endedAt >= task.startedAt) task.endedAt = endedAt;
  }
  return tasks;
}

/**
 * Extracts the first question text from a question tool's input (first 500 chars of the JSON;
 * summarizeToolInput in lib/transcript.ts, arguments for Codex). AskUserQuestion and request_user_input both
 * have questions[].question. When cut at 500 chars with no closing ", use what is there up to the cut.
 * ExitPlanMode has no question text (undefined)
 */
function extractQuestion(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const m = /"question"\s*:\s*"((?:[^"\\]|\\.)*)("?)/.exec(input);
  if (!m) return undefined;
  let text = m[1];
  if (m[2] === "") text = text.replace(/\\$/, ""); // drop a trailing escape cut off midway
  try {
    text = JSON.parse(`"${text}"`) as string;
  } catch {
    // If the escapes are broken, use it raw
  }
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

function isWaitingTool(toolName: string | undefined): boolean {
  return (
    toolName === "AskUserQuestion" ||
    toolName === "ExitPlanMode" ||
    toolName === "request_user_input"
  );
}

/**
 * Even if the main session stops at T, if even one chick (subagent) was alive past T, that T's done is
 * suppressed for now (the suppression lifts on the scan where all are done/dozing or treated as abandoned).
 * Whether a chick is really running or stopped can't be decided from its ordering relative to T alone
 * (chicks commonly go tens of seconds without writing, e.g. while running Bash, so a running chick that just
 * happens to have no write at the moment of T would be misjudged as "stopped"). Instead, decide by the
 * freshness of the time since its last write (sinceMs) itself: if sinceMs is under CHICK_ABANDONED_MS it is
 * still alive (suppressed even when stuck in working); otherwise it is treated as abandoned and ignored.
 * T is an immutable past event in the tail, so while suppressed this function keeps being re-evaluated every
 * scan, and the suppression lifts naturally once the chicks are all finished.
 *
 * The check order always does "suppression by running chicks" first. A running chick is alive at the current
 * scan (now > T), so "alive past T" is certain without even looking at its write time, and whether to suppress
 * is decided here first. Without this order, on the first scan right after the parent's turn end T, there is a
 * moment where even a running chick's last write is still before T, and just at that moment
 * wasAnyChickAliveAfterT becomes false and it wrongly falls through to the normal immediate-fire path
 * (actual problem: with T=16:58:17 and the previous write at 16:58:1x, done was not suppressed, fired
 * immediately, and chirped).
 * Only after leaving the loop with no running chick confirmed do we check whether all chicks had finished at
 * time T (no chicks, or every chick's last write before T). A stopped chick's last write time no longer moves,
 * so the comparison at this point is reliable.
 * The finished case is the normal immediate-fire path that needs no suppression at all, and is outside the
 * cancel/grace/timeout below (behavior unchanged from the old implementation). Only the case "some chick was
 * alive past T" goes through suppression → release → cancel/grace/timeout.
 *
 * Firing after release is a deterministic timeout+cancel rather than relying on freshness (the old
 * implementation kept at=T fixed and relied on App.tsx's freshness guard (EVENT_FRESHNESS_MS=30 seconds), so
 * whether the release fell within freshness was effectively luck. Actual problem: the chick finished 17 seconds
 * after the parent's turn end → the release fired within the 30-second freshness and chirped, then 3 seconds
 * later the harness auto-restarted the parent and it continued → the final turn's done chirped again, a double
 * chirp).
 * - **Cancel**: at release, the parent's tail already has an event (of any kind) after T = the parent has
 *   already restarted/continued. The done is then meaningless as that event, so it is returned with muted
 *   (kept in the log and EventFeed but no chirp).
 * - **Grace**: if not cancelled yet and DONE_GRACE_MS hasn't passed since the chick's last write, wait a bit
 *   longer for the parent to restart. Return null and re-evaluate on the next scan.
 * - **Timeout fire**: if the parent hasn't restarted after DONE_GRACE_MS, fire it as a done that may chirp.
 *   at stays t, the key basis (reason below), so firedAt=now is attached instead for App.tsx's freshness guard
 *   to check.
 *
 * Why at stays fixed to t (= T, the parent's own turn end):
 * - When a background agent finished, chirping done at the chick's write time W made the harness auto-restart
 *   the parent right after, write a completion report, and emit done again at that turn's end (T2), chirping
 *   twice in a row (actual problem). The first one at W is always redundant — the parent is always restarted
 *   and emits the T2 done.
 * - The key (`sessionId:t:done`) comes from t and never changes, so no matter how many times it is
 *   re-evaluated during suppression or grace it is the same key, fitting cleanly with both sessionEventCache's
 *   first-write-wins (cacheEvent) and deduplication (no "key changes on every fire" wobble like the old
 *   implementation with a variable at).
 *
 * For the basis of DONE_GRACE_MS (30 seconds), see the comment on the constant.
 *
 * Background tasks (run_in_background Bash etc.; backgroundTaskCache) are suppressed for the same reason as
 * chicks: even if the parent writes "running it in the background" and stops at T, the task's
 * <task-notification> always resumes the parent, which emits done at the report turn's end T2. The T done is
 * redundant, and chirping it makes one request speak twice (actual problem: the waiting announcement while
 * running five `claude -p` in the background was read out). Unlike chicks there is no dedicated transcript and
 * liveness can't be seen, so the check uses only the start and completion notification times:
 * - A task started at or before T with no completion notification yet → suppress (null)
 * - Started at or before T, with a completion notification after T → same as chick release (muted if the
 *   parent has resumed; otherwise timeout fire after the DONE_GRACE_MS grace)
 * Completion notifications come for both completed and failed (confirmed in real data). The escape hatch for
 * a missed notification line is BACKGROUND_TASK_STALE_MS.
 * As with chicks, the done of a turn that ended after talking with the user while a task was running is also
 * suppressed.
 */
function deriveDoneEvent(
  sessionId: string,
  project: string,
  t: number,
  chicks: ChickView[],
  backgroundTasks: Map<string, BackgroundTask>,
  snippet: string | undefined,
  now: number,
  parentAdvanced: boolean,
  // This turn's final assistant reply text (assistant_text.text). A temporary value only used as input to the
  // done readout summary (lib/summarize.ts), so it is put as-is on the generated SessionEvent
  // (excluding it from persistence is appendToEventLog's responsibility)
  assistantText: string | undefined,
): SessionEvent | null {
  // Background tasks: only those started at or before T matter for T's done
  let lastTaskEndAfterT: number | undefined;
  for (const task of backgroundTasks.values()) {
    if (task.startedAt > t) continue;
    if (task.endedAt === undefined) {
      if (now - task.startedAt < BACKGROUND_TASK_STALE_MS) return null; // running → suppress
      continue; // the notification may have been missed (see BACKGROUND_TASK_STALE_MS)
    }
    if (task.endedAt > t) lastTaskEndAfterT = Math.max(lastTaskEndAfterT ?? 0, task.endedAt);
  }

  // Check suppression by running chicks first. A running chick is alive at the current scan (now > T), so
  // "alive past T" is certain without even looking at its write time.
  // If this came after the wasAnyChickAliveAfterT check, on the first scan right after the parent's turn end
  // there is a moment where even a running chick's last write is still before T, and just at that moment
  // wasAnyChickAliveAfterT would be misjudged as false and fall through to the normal immediate-fire path
  for (const chick of chicks) {
    if (chick.state === "done" || chick.state === "dozing") continue; // finished chicks don't matter
    if (chick.sinceMs < CHICK_ABANDONED_MS) return null; // suppress if even one chick looks like it is running
    // sinceMs >= CHICK_ABANDONED_MS: stuck in working with no writes for a long time = treated as abandoned and ignored
  }

  // A background task finished after T. As with chick release: muted if the parent has resumed; while waiting
  // for it to resume, grace up to DONE_GRACE_MS; if it still hasn't resumed, timeout fire
  if (lastTaskEndAfterT !== undefined) {
    if (parentAdvanced) {
      return { ...mkSessionEvent(sessionId, project, "done", t, snippet, assistantText), muted: true };
    }
    if (now - lastTaskEndAfterT < DONE_GRACE_MS) return null;
    return { ...mkSessionEvent(sessionId, project, "done", t, snippet, assistantText), firedAt: now };
  }

  // Reaching here means no chick is running. A stopped chick's last write time no longer moves, so the
  // comparison at this point (was any chick alive past T) is reliable
  const wasAnyChickAliveAfterT = chicks.some((chick) => now - chick.sinceMs > t);
  if (!wasAnyChickAliveAfterT) {
    // All chicks had finished at time T (including no chicks) = no suppression needed, normal immediate-fire path
    return mkSessionEvent(sessionId, project, "done", t, snippet, assistantText);
  }

  // Release: if the parent already has an event after T (restarted/continued), this done no longer means
  // anything, so return it muted (kept in the log and feed)
  if (parentAdvanced) {
    return { ...mkSessionEvent(sessionId, project, "done", t, snippet, assistantText), muted: true };
  }

  // Grace: GRACE hasn't passed since the chick's last write. Wait a bit longer for the parent to restart
  const lastChickWriteAt = Math.max(...chicks.map((chick) => now - chick.sinceMs));
  if (now - lastChickWriteAt < DONE_GRACE_MS) return null;

  // Timeout fire: the parent hasn't restarted after GRACE. Return it as a done that may chirp
  return { ...mkSessionEvent(sessionId, project, "done", t, snippet, assistantText), firedAt: now };
}

function mkSessionEvent(
  sessionId: string,
  project: string,
  type: SessionEvent["type"],
  at: number,
  snippet?: string,
  assistantText?: string,
): SessionEvent {
  return { key: `${sessionId}:${at}:${type}`, sessionId, project, snippet, type, at, assistantText };
}

/**
 * Looks into subagents/ only for parent sessions that are displayed
 * (<projectDir>/<sessionId>/subagents/agent-*.jsonl).
 * A missing directory (NotFoundError) is the normal no-chick case, so it is swallowed.
 *
 * parentChickSignals: chickSignals taken from the parent tail (already read by readTailCached). The chick
 * completion check treats this as the source of truth (see the isChick comment in deriveState). The caller
 * (scanSessions) must read the parent tail before scanChicks.
 */
async function scanChicks(
  projectDir: NativeDirectoryHandle,
  sessionFileName: string,
  parentId: string,
  now: number,
  parentChickSignals: Map<string, number>,
): Promise<ChickScan[]> {
  const sessionId = sessionFileName.replace(/\.jsonl$/, "");
  let subagentsDir: NativeDirectoryHandle;
  try {
    const sessionDir = await projectDir.getDirectoryHandle(sessionId);
    subagentsDir = await sessionDir.getDirectoryHandle("subagents");
  } catch (e) {
    // A missing directory (NotFoundError) is the normal no-chick case. Anything else is abnormal, so leave a trace
    if (!(e instanceof DOMException && e.name === "NotFoundError")) {
      console.warn("[tomarigi] failed to scan subagents", parentId, e);
    }
    return [];
  }

  const chicks: ChickScan[] = [];
  for await (const entry of subagentsDir.values()) {
    if (entry.kind !== "file" || !entry.name.endsWith(".jsonl")) continue;
    const file = await (entry as NativeFileHandle).getFile();
    // mtime is fine here for the same reason as the equivalent filter in the parent scan (see the comment in
    // scanSessions): it is a rough cutoff before reading the tail, and mtime only runs ahead of the actual last
    // conversation time
    if (now - file.lastModified > ACTIVE_WINDOW_MS) continue;

    const chickId = `${parentId}/${entry.name}`;
    const tail = await readTailCached(chickId, file, { includeSidechain: true });
    // Use tail.lastEventAt as the basis for the same reason as the parent scan's sinceMs (see the equivalent
    // place in scanSessions). sinceMs is for display, so the mtime fallback is acceptable
    const chickSinceBasis = tail.lastEventAt ?? file.lastModified;
    const sinceMs = now - chickSinceBasis;
    const meta = await resolveChickMeta(subagentsDir, entry.name, chickId);
    // Recover the task-id from the file name agent-<task-id>.jsonl. It matches <task-id> in
    // task-notification (confirmed in real data). Even with naming lacking the "agent-" prefix
    // (should it change in the future), it is just used as the key as-is; the signal simply won't be found
    // and it falls to the later fallback check, so it errs on the safe side
    const taskId = entry.name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    // Pass tail.lastEventAt as-is, before the mtime fallback, to the resume check (resolveChickDoneSignalAt).
    // Not trusting mtime is the very reason that function exists, and substituting chickSinceBasis (meant for
    // sinceMs) would bring back the same problem (mistaking a later touch for a resume)
    const chickDoneSignalAt = resolveChickDoneSignalAt(
      parentChickSignals,
      taskId,
      meta.toolUseId,
      tail.lastEventAt,
    );
    chicks.push({
      view: {
        id: chickId,
        name: meta.name,
        state: deriveState(tail, sinceMs, true, chickDoneSignalAt),
        sinceMs,
        toolName: tail.kind === "tool_use" ? tail.toolName : undefined,
      },
    });
  }
  chicks.sort((a, b) => a.view.sinceMs - b.view.sinceMs);
  return chicks;
}

/**
 * Resolves this chick's completion signal from the parent ledger (parentChickSignals). A chick can have two
 * kinds of identifier (async start = task-id, sync call = toolUseId in meta.json), so look up both, and if by
 * any chance both have a signal, take the newer one (repeated resumes can update both separately).
 *
 * Normally only one has a value: task-id (task-notification) fires every time the agent stops, so it can be
 * updated on each resume, whereas toolUseId (tool_result) gets a value only once, because once a blocking
 * call's result has returned the tool_use_id is resolved at the API level and never reused (later resumes go
 * through another path such as SendMessage and have a new tool_use_id). Both having a value would only happen
 * in an unexpected case like "the same chick was once started by a sync call and later also went through the
 * async notification path", not confirmed in real data. Math.max is insurance against that unexpected case.
 *
 * Even with a signal, if the chick's last conversation time (chickLastEventAt, tail.lastEventAt; no fallback
 * to mtime, reason below) is clearly after the signal (by more than CHICK_SIGNAL_EPSILON_MS), treat the chick
 * as resumed after the signal and writing again, and invalidate it (return undefined = treat as "no signal".
 * The parent can resume a chick with the same task-id and writes resume in the same jsonl, so pinning the
 * signal as a past one would leave it done forever even after the resume).
 * The last conversation time is used instead of mtime so that later appends without a timestamp (a touch that
 * only changes mtime) aren't mistaken for a resume — with an mtime basis every ghost touch would invalidate a
 * valid completion signal, and a chick that should be finished would look like it is working.
 *
 * If chickLastEventAt is undefined (the tail window has no line with a timestamp, so the last conversation
 * time is unknown), the resume check itself is skipped and the signal is treated as valid as-is. No fallback
 * to mtime — as above, not trusting mtime is the very reason this function exists, and substituting it would
 * bring back the same "a later touch revives a finished chick into working" problem.
 */
function resolveChickDoneSignalAt(
  parentChickSignals: Map<string, number>,
  taskId: string,
  toolUseId: string | undefined,
  chickLastEventAt: number | undefined,
): number | undefined {
  const byTaskId = parentChickSignals.get(taskId);
  const byToolUseId = toolUseId ? parentChickSignals.get(toolUseId) : undefined;
  const signalAt =
    byTaskId === undefined ? byToolUseId : byToolUseId === undefined ? byTaskId : Math.max(byTaskId, byToolUseId);
  if (signalAt === undefined) return undefined;
  if (chickLastEventAt === undefined) return signalAt; // last conversation time unknown. No basis to conclude a resume, so return the signal as valid
  if (chickLastEventAt > signalAt + CHICK_SIGNAL_EPSILON_MS) return undefined; // resumed. The signal is invalid
  return signalAt;
}

interface ChickMeta {
  name: string; // resolved from meta.json in order name → description → file name
  toolUseId?: string; // tool_use id at start (Task/Agent call). Used to match the sync completion signal
}

/**
 * Reads agent-<id>.meta.json. Claude Code's real data has no name, only description, so fall back in order
 * name → description → file name.
 * toolUseId is the matching key for the sync chick completion signal (resolveChickDoneSignalAt).
 */
async function resolveChickMeta(
  subagentsDir: NativeDirectoryHandle,
  fileName: string,
  chickId: string,
): Promise<ChickMeta> {
  const cached = chickMetaCache.get(chickId);
  if (cached) return cached;

  const base = fileName.replace(/\.jsonl$/, "");
  let meta: ChickMeta = { name: base };
  try {
    const metaHandle = await subagentsDir.getFileHandle(`${base}.meta.json`);
    const metaFile = await metaHandle.getFile();
    const raw = JSON.parse(await metaFile.text()) as {
      name?: string;
      description?: string;
      toolUseId?: string;
    };
    meta = {
      name: raw.name ?? raw.description ?? base,
      toolUseId: typeof raw.toolUseId === "string" ? raw.toolUseId : undefined,
    };
  } catch {
    // If meta.json is missing/broken, fall back to the file name for the name and continue without toolUseId
    // (not fatal: even without toolUseId, signal matching via task-id still works)
  }
  chickMetaCache.set(chickId, meta);
  return meta;
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
function deriveState(
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
 * override would keep an SDK chick ending on tool_result stuck in working for the whole ACTIVE_WINDOW_MS
 * (30 minutes), keep the parent looking working via escalateWithChicks, and also wrongly feed into
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
function deriveSdkChickState(tail: TailInfo, sinceMs: number): BirdState {
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
