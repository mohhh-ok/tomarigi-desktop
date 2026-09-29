// Watching links between sessions (docs/design.md "Watching")
import { invoke } from "@tauri-apps/api/core";
import { isPeerActive } from "./watching";
import type { FoundEntry, LiveSession, PeerLink, SessionView } from "./session-types";
import { lastPeerStates, peerLastActiveAt, peerNameCache, peerScanOffset, scanState } from "./session-store";
import { sessionIdOfViewId } from "./session-liveness";

export interface WatchLinks {
  liveBySessionId: Map<string, LiveSession>;
  viewIdBySessionId: Map<string, string>;
  peerLinksOf: (ownSessionId: string) => PeerLink[];
}

// Watching links (docs/design.md "Watching"). Match the names of peers exchanged with against the names of
// running sessions to get sessionIds, and link both ways (a trace on either side counts as linked)
export async function resolveWatchLinks(withTail: FoundEntry[], liveSessions: LiveSession[]): Promise<WatchLinks> {
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
  if (watchSignature !== scanState.lastWatchSignature) {
    scanState.lastWatchSignature = watchSignature;
    // Log only the name mapping (message bodies are neither read nor logged)
    void invoke("log", { line: `[watch] links\n${watchSignature || "(none)"}` }).catch(() => {});
  }
  return { liveBySessionId, viewIdBySessionId, peerLinksOf };
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
