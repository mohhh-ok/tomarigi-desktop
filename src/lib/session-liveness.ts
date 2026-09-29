// Whether each session's process is alive, and when a bird is removed
import { invoke } from "@tauri-apps/api/core";
import type { RootEntry } from "./fsa";
import type { LiveFoundEntry, LiveSession } from "./session-types";
import {
  missCounts,
  recentlyEndedAt,
  scanState,
  seenAliveIds,
  sessionEventCache,
  transcriptAppearedAt,
} from "./session-store";

/** The <config> of a Claude Code watched folder (<config>/projects) */
export function configDirOf(root: RootEntry): string {
  const path = root.path.replace(/\/+$/, "");
  return path.slice(0, path.lastIndexOf("/"));
}

/**
 * Reads <config>/sessions/*.json for each watched folder (<config>/projects) (live_sessions in Rust).
 * sessions are those of running processes. presentConfigDirs are the <config>s that have <config>/sessions
 */
export async function loadLiveSessions(roots: RootEntry[]): Promise<{
  sessions: LiveSession[];
  presentConfigDirs: Set<string>;
  unreliableConfigDirs: Set<string>;
}> {
  const configDirs = new Set(roots.filter((r) => r.kind === "claude").map(configDirOf));
  const scans = await Promise.all(
    [...configDirs].map(async (configDir) => {
      const scan = await invoke<{ present: boolean; sessions: LiveSession[]; reliable: boolean }>(
        "live_sessions",
        { configDir },
      // A failed call says nothing about the folder: treat it as present but unreliable so shown birds stay
      ).catch(() => ({ present: true, sessions: [] as LiveSession[], reliable: false }));
      return { configDir, ...scan };
    }),
  );
  return {
    sessions: scans.flatMap((s) => s.sessions),
    presentConfigDirs: new Set(scans.filter((s) => s.present).map((s) => s.configDir)),
    // Reads where ps failed or sessions/*.json had an unreadable file. Birds are not removed based on this read
    unreliableConfigDirs: new Set(scans.filter((s) => !s.reliable).map((s) => s.configDir)),
  };
}

/** The <codex dir> of a Codex watched folder (~/.codex/sessions or ~/.codex) */
export function codexDirOf(root: RootEntry): string {
  const path = root.path.replace(/\/+$/, "");
  return path.endsWith("/sessions") ? path.slice(0, path.lastIndexOf("/")) : path;
}

/**
 * Codex threads whose process is alive, per <codex dir> (live_codex_threads in Rust: which
 * thread-writer-locks/<threadId>.lock files some process has open). unreliableCodexDirs are reads where lsof failed
 */
export async function loadLiveCodexThreads(roots: RootEntry[]): Promise<{
  threadIdsByCodexDir: Map<string, Set<string>>;
  unreliableCodexDirs: Set<string>;
}> {
  const codexDirs = new Set(roots.filter((r) => r.kind === "codex").map(codexDirOf));
  const scans = await Promise.all(
    [...codexDirs].map(async (codexDir) => {
      const scan = await invoke<{ threads: { threadId: string; pid: number }[]; reliable: boolean }>(
        "live_codex_threads",
        { codexDir },
      ).catch(() => ({ threads: [], reliable: false }));
      return { codexDir, ...scan };
    }),
  );
  return {
    threadIdsByCodexDir: new Map(scans.map((s) => [s.codexDir, new Set(s.threads.map((t) => t.threadId))])),
    unreliableCodexDirs: new Set(scans.filter((s) => !s.reliable).map((s) => s.codexDir)),
  };
}

// Birds are shown while their process is alive and removed right away once it ends; elapsed time plays no part
// (docs/design.md "Removing birds of ended sessions"). The check doesn't depend on the terminal type.
// Claude Code (including `claude -p` / SDK starts; measured with 2.1.284) writes <config>/sessions/<pid>.json right
// after it starts and deletes it when it ends (measured: every remaining file had a live pid). The transcript isn't
// created until the first message, so "there is a transcript but no live sessions file" normally means the process
// has ended. Codex keeps thread-writer-locks/<threadId>.lock open while it runs.
// - Candidates for birds are the sessions whose process is alive, birds already shown (trackedIds), and Claude
//   Code transcripts that appeared within the last NEVER_SEEN_GRACE_MS. A transcript's age doesn't matter
// - A session this app has seen alive at least once while running is removed on the next reads after it
//   disappears (within a few seconds)
// - One never seen is removed once NEVER_SEEN_GRACE_MS has passed since its transcript appeared. The grace keeps
//   a new session from being removed when, right after it starts, the sessions file write lags behind the
//   transcript. It is measured from when this app first listed the transcript, not from the file's mtime: the
//   harness touches dead transcripts hours later (see TailInfo.lastEventAt), and that must not bring a bird back.
//   Transcripts already there on the first listing of a folder get no grace, so sessions that ended just before
//   the app started don't flash up
// - Watched folders without <config>/sessions (older versions) are not supported: no pid, so no birds
// - Nothing is removed on a read where ps / lsof failed or sessions/*.json had an unreadable file (Claude Code
//   rewrites this file every time its state changes, so a half-written file may be read). A session is removed
//   only when it was not seen in MISSES_TO_END consecutive reads
const NEVER_SEEN_GRACE_MS = 15_000;
const MISSES_TO_END = 2;

export function inNeverSeenGrace(id: string, now: number): boolean {
  const appearedAt = transcriptAppearedAt.get(id);
  return appearedAt !== undefined && now - appearedAt <= NEVER_SEEN_GRACE_MS && !recentlyEndedAt.has(id);
}

/** Sessions the conversation came from, newest first (A → B → C gives [B, A] for C) */
export function predecessorsOf(sessionId: string): string[] {
  const out: string[] = [];
  for (let id = scanState.continuedFrom.get(sessionId); id && !out.includes(id); id = scanState.continuedFrom.get(id)) out.push(id);
  return out;
}

export function sessionIdOfViewId(id: string): string {
  const file = id.split("/")[2] ?? "";
  return file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) : file;
}

/**
 * Removes sessions whose process has ended (together with their chicks) from found, and from Recent activity
 * (see the NEVER_SEEN_GRACE_MS comment). Their tail has been read, so they are added to skippedIds to keep them
 * in tailCache. Returns the ids removed on this read
 */
export function settleLiveness(
  found: LiveFoundEntry[],
  skippedIds: Set<string>,
  live: {
    liveSessionIds: Set<string>;
    threadIdsByCodexDir: Map<string, Set<string>>;
    unreliableConfigDirs: Set<string>;
    unreliableCodexDirs: Set<string>;
  },
  now: number,
): Set<string> {
  const { liveSessionIds, threadIdsByCodexDir, unreliableConfigDirs, unreliableCodexDirs } = live;
  for (const [id, at] of recentlyEndedAt) if (now - at > NEVER_SEEN_GRACE_MS) recentlyEndedAt.delete(id);
  for (const [id, at] of transcriptAppearedAt) if (now - at > NEVER_SEEN_GRACE_MS) transcriptAppearedAt.delete(id);
  const endedIds = new Set<string>();
  const foundIds = new Set(found.map((f) => f.id));
  for (const id of seenAliveIds) if (!foundIds.has(id)) seenAliveIds.delete(id);
  for (const id of missCounts.keys()) if (!foundIds.has(id)) missCounts.delete(id);
  for (const f of found) {
    const alive =
      f.agent === "claude" ? liveSessionIds.has(f.liveKey) : (threadIdsByCodexDir.get(f.liveDir)?.has(f.liveKey) ?? false);
    if (alive) {
      seenAliveIds.add(f.id);
      missCounts.delete(f.id);
      continue;
    }
    // If this read's result is unreliable, neither remove nor count
    if ((f.agent === "claude" ? unreliableConfigDirs : unreliableCodexDirs).has(f.liveDir)) continue;
    const seen = seenAliveIds.has(f.id);
    if (!seen && inNeverSeenGrace(f.id, now)) continue;
    const misses = (missCounts.get(f.id) ?? 0) + 1;
    missCounts.set(f.id, misses);
    if (misses < MISSES_TO_END) continue;
    endedIds.add(f.id);
    // Log each time it is removed (so flickering on and off can be traced)
    const line = `[live] ended ${f.id} seenAlive=${seen} misses=${misses} idleMs=${now - f.file.lastModified}`;
    void invoke("log", { line }).catch(() => {});
  }
  if (endedIds.size > 0) {
    for (const f of found) if (endedIds.has(f.id)) skippedIds.add(f.id);
    found.splice(0, found.length, ...found.filter((f) => !endedIds.has(f.id)));
    // Also remove from Recent activity (the latest card per session)
    for (const [key, event] of sessionEventCache) if (endedIds.has(event.sessionId)) sessionEventCache.delete(key);
    for (const id of endedIds) {
      seenAliveIds.delete(id);
      missCounts.delete(id);
      recentlyEndedAt.set(id, now);
    }
  }
  scanState.trackedIds = new Set(found.map((f) => f.id));
  return endedIds;
}
