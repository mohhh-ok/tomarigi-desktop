// Watching links between sessions (docs/design.md "Watching")
import { invoke } from "@tauri-apps/api/core";
import { isPeerActive, peerLookup, rememberLatestTurnTyped, startedBySession, type FirstPrompt } from "./watching";
import type { FoundEntry, LiveSession, PeerLink, SessionView } from "./session-types";
import { firstPromptCache, latestTurnTypedIds, lastPeerStates, peerLastActiveAt, peerNameCache, peerScanOffset, scanState, startedCardCache } from "./session-store";
import { pendingProposalsOf } from "./transcript";
import { cardKey } from "./proposals";
import { sessionIdOfViewId } from "./session-liveness";

export interface WatchLinks {
  liveBySessionId: Map<string, LiveSession>;
  viewIdBySessionId: Map<string, string>;
  peerLinksOf: (ownSessionId: string) => PeerLink[];
  /** Whether the session (view id) was started by another session (startedBySession in lib/watching.ts) */
  startedBySessionOf: (viewId: string) => boolean;
  /** The proposal cards the user started (cardKey in lib/proposals.ts), from the desktop app's records */
  startedCards: ReadonlySet<string>;
}

// Watching links (docs/design.md "Watching"). Match the names (or desktop app ids) of peers exchanged with against
// the running sessions to get sessionIds, and link both ways (a trace on either side counts as linked)
export async function resolveWatchLinks(withTail: FoundEntry[], liveSessions: LiveSession[]): Promise<WatchLinks> {
  const peerOf = peerLookup(liveSessions);
  const liveBySessionId = new Map<string, LiveSession>();
  for (const live of liveSessions) liveBySessionId.set(live.sessionId, live);
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
        const scan = await invoke<{
          names: [string, string][];
          firstPrompt?: FirstPrompt | null;
          lastTurnTyped?: boolean | null;
          end: number;
        }>(
          "scan_peer_names",
          { path: f.file.path, start: peerScanOffset.get(f.id) ?? 0 },
        );
        if (scan.firstPrompt) firstPromptCache.set(f.id, scan.firstPrompt);
        rememberLatestTurnTyped(latestTurnTypedIds, f.id, scan.lastTurnTyped);
        // The first prompt is read from the top only, so the offset stays at the top until it has come (a session
        // just started may not have written it yet; the file is still small then)
        if (firstPromptCache.has(f.id)) peerScanOffset.set(f.id, scan.end);
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
      const peer = peerOf(name);
      if (!peer) continue;
      link(ownSessionId, peer.sessionId);
      link(peer.sessionId, ownSessionId);
    }
  }
  const peerLinksOf = (ownSessionId: string): PeerLink[] =>
    [...(links.get(ownSessionId) ?? [])].map((sessionId) => {
      const live = liveBySessionId.get(sessionId);
      return {
        sessionId,
        viewId: viewIdBySessionId.get(sessionId),
        name: live?.name ?? sessionId.slice(0, 8),
        cwd: live?.cwd,
        startedAt: live?.startedAt,
        ...peerMotion(sessionId, live?.status),
      };
    });
  const watchSignature = [...links.entries()]
    .map(([a, bs]) => `${liveBySessionId.get(a)?.name ?? a.slice(0, 8)} <-> ${[...bs].map((b) => liveBySessionId.get(b)?.name ?? b.slice(0, 8)).sort().join(", ")}`)
    .sort()
    .join("\n");
  if (watchSignature !== scanState.lastWatchSignature) {
    scanState.lastWatchSignature = watchSignature;
    // Log only the name mapping (message bodies are neither read nor logged)
    void invoke("log", { line: `[watch] links\n${watchSignature || "(none)"}` }).catch(() => {});
  }
  const startedBySessionOf = (viewId: string) =>
    startedBySession(firstPromptCache.get(viewId), latestTurnTypedIds.has(viewId));
  await readStartedCards(claudeEntries, liveBySessionId);
  return { liveBySessionId, viewIdBySessionId, peerLinksOf, startedBySessionOf, startedCards: startedCardCache };
}

/**
 * How a linked session moves, as watchingCount (lib/watching.ts) reads it: whether it moves now, the last time it moved,
 * and its last transcript write, from what the previous scan remembered (rememberPeerStates). status is its status in
 * sessions/<pid>.json
 */
export function peerMotion(sessionId: string, status: string | undefined): Pick<PeerLink, "active" | "lastActiveAt" | "lastWriteAt"> {
  const last = lastPeerStates.get(sessionId);
  return {
    active: isPeerActive(status, last?.state),
    lastActiveAt: peerLastActiveAt.get(sessionId),
    lastWriteAt: last?.lastWriteAt,
  };
}

/** Remembers each session's state for the next scan's peer checks (lastPeerStates, peerLastActiveAt) */
export function rememberPeerStates(views: SessionView[], watch: WatchLinks, now: number): void {
  const { liveBySessionId, viewIdBySessionId } = watch;
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
}

/**
 * Reads, from the desktop app's records, which of the cards that sessions' last turns left the user started
 * (desktop_spawned_from in src-tauri; docs/design.md "The "?" for sessions waiting on you"), and remembers them in
 * startedCardCache: a started card stays started. Asks only when some card isn't known to be started yet, for records
 * written since the oldest such card. When the records can't be read, no card counts as started (the wait then ends
 * with the session's next turn)
 */
async function readStartedCards(entries: FoundEntry[], liveBySessionId: Map<string, LiveSession>): Promise<void> {
  const parents = new Set<string>();
  let since = Infinity;
  for (const f of entries) {
    const host = liveBySessionId.get(sessionIdOfViewId(f.id))?.hostSessionId;
    if (!host) continue;
    for (const p of pendingProposalsOf(f.tail.events)?.proposals ?? []) {
      if (startedCardCache.has(cardKey(host, p.taskId))) continue;
      parents.add(host);
      since = Math.min(since, p.at);
    }
  }
  if (parents.size === 0) return;
  try {
    const scan = await invoke<{ spawned: { parent: string; taskId: string }[]; reliable: boolean }>("desktop_spawned_from", {
      parents: [...parents],
      sinceMs: Math.max(0, Math.floor(since)),
    });
    for (const s of scan.spawned) startedCardCache.add(cardKey(s.parent, s.taskId));
  } catch {
    // Not read this time: the cards stay not started until a later read
  }
}
