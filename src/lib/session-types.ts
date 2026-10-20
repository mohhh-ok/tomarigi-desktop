// Types of the session scan (lib/sessions.ts and the modules it is split into)
import type { NativeFile } from "./native-fs";
import type { TailInfo } from "./transcript";
import type { JudgeErrorKind } from "./judge";
import type { AgentKind } from "./agents";

/**
 * The turn verdict on whether the last reply waits on the user, one per turn (sessionId + time of the last reply). It
 * comes with the speech bubble summary (docs/design.md "Turn verdicts"); pending while that request runs, error when
 * it failed or the answer didn't match the schema
 */
export interface AskJudgement {
  status: "pending" | "asking" | "not_asking" | "error";
  /** Kind of error (for the debug display). no-matching-json: a local model's answer that isn't JSON matching the schema */
  errorKind?: JudgeErrorKind | "no-matching-json";
}

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
  // The turn verdict of the done turn (recordTurnVerdict): whether it waits on the user, and whether a message the user
  // sent in that turn was abusive toward the AI (absent when the request failed). Shown in the debug log screen
  ask?: AskJudgement;
  abusive?: boolean;
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
  // Last reply of a stopped (done / dozing) turn. Used as the turn verdict input and to identify the turn
  // (sessionId + at). at is the same value as the at of the same turn's done event
  reply?: { at: number; text: string };
  // The turn verdict for the reply's turn. Set by App (mock writes it directly)
  ask?: AskJudgement;
  // The messages a person typed in the stopped turn, oldest first (turnUserMessages in lib/session-tail.ts). Input
  // for the abuse verdict (docs/design.md "Anger mark for abuse toward the AI"). Untrusted input; never shown
  userMessages?: { at: number; text: string }[];
  // Whether the bird has the anger mark: the latest turn verdict said a message of that turn was abusive. It stays
  // until the next turn's verdict. Set by App (mock writes it directly)
  angry?: boolean;
  // The question text while stopped on a question tool (AskUserQuestion / request_user_input). Taken as-is
  // from the tool input (no AI). Shown in the speech bubble (perch/bubble.tsx)
  question?: string;
  // Speech bubble text summarizing the reply's turn with BYOK. Set by App (mock writes it directly)
  summary?: string;
  // Peers connected by inter-session messages (Watching in docs/design.md). Claude Code only
  peers?: PeerLink[];
  // Watching: the number of peers currently active while this session's own machine state is done / dozing.
  // For a grace period after the peers stop (WATCH_GRACE_MS in lib/watching.ts) it is 0 and stays watching.
  // Absent when not watching
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
export interface ChickScan {
  view: ChickView;
  // The parent's transcript has recorded this chick's completion (and it hasn't resumed since). Such chicks are
  // not listed under the parent (docs/design.md "Removing birds of ended sessions") but are still passed to the
  // done suppression and the parent's state escalation, which need to see that they just finished
  completed: boolean;
}

// A background task (run_in_background) in the parent's ledger (backgroundTaskCache in lib/session-store.ts)
export type BackgroundTask = { startedAt: number; endedAt?: number };

export interface LiveSession {
  pid: number;
  sessionId: string;
  name?: string;
  cwd?: string;
  status?: string;
  startedAt?: number;
}

// One scan result inside scanSessions. The same shape is used for found, withTail, and SDK chick distribution
export interface FoundEntry {
  agent: AgentKind;
  rootId: string;
  rootLabel: string;
  slug: string; // project directory name (under ~/.claude*/projects/). Also part of the grouping key when
  // narrowing SDK chicks' parent candidates to "the same project directory"
  file: NativeFile;
  id: string;
  tail: TailInfo;
  chicks: ChickScan[]; // subagent chicks found by scanChicks (SDK chicks are not included here)
}

// A FoundEntry with whether its process is alive on this read, decided by its agent's adapter (lib/agents.ts):
// true / false, or undefined when this read can't tell (ps / lsof or the agent's files failed; nothing is removed).
// pid is the process found for it, used for jumping (several sessions in one cwd: only the one written last has it)
export type LiveFoundEntry = FoundEntry & { live: boolean | undefined; pid?: number };

export interface ChickMeta {
  name: string; // resolved from meta.json in order name → description → file name
  toolUseId?: string; // tool_use id at start (Task/Agent call). Used to match the sync completion signal
}
