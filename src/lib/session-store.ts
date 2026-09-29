// Module-level state of the session scan (lib/sessions.ts). Every cache and ledger kept across scans lives here,
// so the session-*.ts modules share the same instances. Values that are reassigned on a scan are properties of
// scanState / eventLogState, since a module can't reassign a binding it imported
import type { TailInfo } from "./transcript";
import type { BackgroundTask, BirdState, ChickMeta, FoundEntry, SessionEvent } from "./session-types";

export interface CacheEntry {
  size: number;
  lastModified: number;
  tail: TailInfo;
}

export const tailCache = new Map<string, CacheEntry>();

// key: parent session id. Chick completion signals from the whole parent transcript (scanChickSignals), read
// only for parents that have subagents. end is how far the file has been read; later reads cover only what was
// appended. The tail window alone loses records of chicks that finished long ago in a long-lived parent
export const chickSignalLedger = new Map<string, { end: number; signals: Map<string, number> }>();
// key: chickId. Pruned when no longer displayed (meta.json is re-read if it reappears)
export const chickMetaCache = new Map<string, ChickMeta>();
// key: session id. In sessions with huge tool output, the trailing 64KB window can fill up with tool results
// alone and contain no user message at all (this happened in practice).
// Remember the last seen snippet and keep showing it after it scrolls out of the window
export const snippetCache = new Map<string, string>();
// key: session id. The latest message a person typed (anger mark input). For the same reason as snippetCache,
// and because a message can even be appended and pushed out of the window between two polls (a large tool
// result right after it), keep the last one seen so the mark can still be judged and cleared
export const userMessageCache = new Map<string, { at: number; text: string }>();
// key: parent session id. Ledger of background tasks (run_in_background) (key: task-id).
// Start lines (TailInfo.backgroundTaskStarts) scroll out of the tail window within tens of seconds (measured:
// already outside the window at the turn end 50 seconds after start), so remember them while visible.
// Completion is filled from the parent tail's chickSignals (task-id → time from <task-notification>).
// Used for the suppression check in deriveDoneEvent
export const backgroundTaskCache = new Map<string, Map<string, BackgroundTask>>();

// Watching (docs/design.md "Watching"): per session (view id), the names of peers it exchanged inter-session
// messages with and the latest time for each. Kept across scans so that traces that left the tail window remain
export const peerNameCache = new Map<string, Map<string, number>>();
// How far into the transcript the exchange traces have been read (end of scan_peer_names in Rust). To pick up
// traces outside the tail window too, the first read covers the whole file and later reads only the new part
export const peerScanOffset = new Map<string, number>();
// Machine state and last write time of each session (sessionId) in the previous scan. Used to decide whether
// a peer is active, and for the watching done suppression (peers are passed in the same way as chicks)
export const lastPeerStates = new Map<string, { state: BirdState; lastWriteAt: number }>();
// Last time a peer was active (sessionId → epoch ms). Used for the watching grace period (lib/watching.ts)
export const peerLastActiveAt = new Map<string, number>();

// Liveness (lib/session-liveness.ts; see the NEVER_SEEN_GRACE_MS comment there).
// Number of consecutive reads where it was not seen (view id). Cleared when seen
export const missCounts = new Map<string, number>();
// Sessions seen alive (view id). Pruned together with the bird (a removed session is no longer a candidate, so
// it can't come back through the grace period)
export const seenAliveIds = new Set<string>();
// Sessions removed within the last NEVER_SEEN_GRACE_MS (view id → removal time). A transcript written just before
// its process ended is still inside the grace, and would otherwise come back as a never-seen candidate
export const recentlyEndedAt = new Map<string, number>();
// Claude Code transcripts listed so far (view id), and the roots listed completely at least once. A transcript not
// known on a later listing is new, and gets the grace from transcriptAppearedAt (pruned once the grace is over)
export const knownTranscriptIds = new Set<string>();
export const listedRootIds = new Set<string>();
export const transcriptAppearedAt = new Map<string, number>();

export const sessionEventCache = new Map<string, SessionEvent>(); // key: SessionEvent.key. Deduplicates the same event

// key: `<rootId>:<threadId>`. Where each live thread's rollout was found (the path never changes)
export const codexRolloutPathCache = new Map<string, string>();

export const scanState = {
  // Log only when the result of resolving link names changes
  lastWatchSignature: "",
  // Per-read record (for investigating fix18. Written to app-log only when the TOMARIGI_SCAN_LOG env var is set)
  scanLogEnabled: undefined as boolean | undefined,
  // Birds shown after the previous read (view id). They stay candidates even when this read can't see their process,
  // so that they go through the miss count instead of vanishing on a single unreliable read
  trackedIds: new Set<string>(),
  // sessionId a conversation was handed over to (TailInfo.continuedIn) → sessionId it came from. Rebuilt on every
  // scan. The new session can run in a Claude Code background process whose tty isn't a Ghostty pane, while the
  // pane that shows it is still the old process, so jumping falls back along this (lib/ghostty.ts)
  continuedFrom: new Map<string, string>(),
  // ids that were in views on the previous read (the per-read record uses this to log birds that disappeared or came back)
  lastScanViewIds: new Set<string>(),
};

// Persistent event log for debugging (the debug dialog). Unlike sessionEventCache it is not cleared by the
// 30-minute TTL; only the last MAX_EVENT_LOG entries are kept. knownLogKeys is an all-time marker of "has this
// ever been written to the log", and acts as a barrier against double appends to the log even when the same
// event is re-derived from the tail after sessionEventCache pruned it by the 30-minute TTL (which looks like
// a "new insert" from cacheEvent's point of view).
export const eventLogState = {
  entries: [] as SessionEvent[], // in append order (last is newest). The persisted data itself
  dirty: false, // whether this scan appended anything new to the persistent log. Saved once at the end of scanSessions
  // Right after startup, restoring the persistent log (async) hasn't finished. A "new insert" that arrives
  // before restoring can't be told apart from restored keys and would be appended twice, so it is held in
  // pending until restoring completes, then merged all at once.
  // "failed" is not turned into a "restore failed, so it's fine to continue empty" state —
  // this log is the only copy and can't be re-derived, so calling saveEventLog in the pre-restore state and
  // overwriting it with nothing (or only this scan's events) would erase the existing history.
  // On failure it stays fixed at "failed" and never passes the save gate (=== "done") at the end of scanSessions.
  hydration: "none" as "none" | "loading" | "done" | "failed",
};
export const knownLogKeys = new Set<string>();
export const pendingLogEvents: SessionEvent[] = [];

/**
 * Prunes caches for entries no longer shown (process ended). Even if sessions pile up day after day with the app
 * left open, the caches only hold what is displayed. skippedIds were read but not shown (their tail stays cached)
 */
export function pruneCaches(found: FoundEntry[], skippedIds: Set<string>): void {
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
  for (const key of chickSignalLedger.keys()) if (!liveIds.has(key)) chickSignalLedger.delete(key);
  for (const key of peerNameCache.keys()) if (!liveIds.has(key)) peerNameCache.delete(key);
  for (const key of peerScanOffset.keys()) if (!liveIds.has(key)) peerScanOffset.delete(key);
}
