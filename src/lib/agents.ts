// The agents whose sessions are shown as birds (docs/design.md "Agents"). Each agent is one adapter here: its
// standard folder, how its sessions are listed under a watched folder, how each is read into the shared TailInfo,
// and whether its process is alive (with the pid used for jumping). lib/sessions.ts walks the watched folders
// through these, and everything after the listing (state, events, views) doesn't know which agent a session is
import { invoke } from "@tauri-apps/api/core";
import { NativeDirectoryHandle, NativeFile, type NativeFileHandle } from "./native-fs";
import type { RootEntry } from "./settings-store";
import type { LiveFoundEntry, LiveSession } from "./session-types";
import { knownTranscriptIds, listedRootIds, scanState, transcriptAppearedAt } from "./session-store";
import { codexDirOf, configDirOf, inNeverSeenGrace, sessionIdOfViewId } from "./session-liveness";
import { codexSessionsDir, codexThreadIdOf, fileAt, findCodexRollout, forgetEndedRollouts, type CodexRollout } from "./codex-rollout";
import { readCodexTailCached, readTailCached, readTailCachedWith } from "./session-tail";
import { scanChicks } from "./session-chicks";
import {
  earliestStart,
  matchSessionsToProcesses,
  matchThreadsToProcesses,
  uuidV7Time,
  programNamed,
  programOf,
  basenameOf,
  type AgentProcess,
  type AgentProcessScan,
} from "./agent-processes";
import { parseQwenRuntime, readQwenTail } from "./qwen-transcript";
import { readCopilotStartCwd, readCopilotTail } from "./copilot-transcript";
import { geminiProjectRoot, readGeminiTail } from "./gemini-transcript";
import { parseOpenCodeMessages, type OpenCodeMessage, type OpenCodeSession } from "./opencode-transcript";
import { cursorProjectSlug, forgetCursorFile, readCursorTail } from "./cursor-transcript";
import type { TailInfo } from "./transcript";
import { basename, parentDir, trimSeparators } from "./paths";

export type AgentKind = "claude" | "codex" | "qwen" | "copilot" | "gemini" | "opencode" | "cursor";

/** What one scan shares between the adapters while walking the watched folders */
export interface ScanListing {
  now: number;
  found: LiveFoundEntry[];
  // ids of sessions whose tail was read but which are not shown (kept in tailCache)
  skippedIds: Set<string>;
  nextContinuedFrom: Map<string, string>;
  // Claude Code's live sessions, also used for watching links
  liveSessions: LiveSession[];
  // ps + lsof for the agents without a pid file, run at most once per scan
  processes(kind: AgentKind): Promise<AgentProcessScan>;
}

export interface AgentAdapter {
  kind: AgentKind;
  label: string; // the agent's name: the label of its default watched folder and of its choice in the add dialog
  home: string; // the standard watched folder, relative to the home directory
  // For agents without a pid file: whether a ps command line is this agent's process
  matchesProcess?: (argv: string[]) => boolean;
  // Loads what liveness needs for all watched folders of this agent, once per scan before listing
  prepare?(roots: RootEntry[], listing: ScanListing): Promise<unknown>;
  // Pushes this folder's candidate sessions into listing.found, each with live and pid decided
  list(root: RootEntry, listing: ScanListing, prepared: unknown): Promise<void>;
  // After every folder was listed and liveness settled
  finish?(roots: RootEntry[], prepared: unknown): void;
}

// ---- Claude Code ----

interface ClaudePrepared {
  presentConfigDirs: Set<string>;
  unreliableConfigDirs: Set<string>;
  pidBySessionId: Map<string, number>;
}

const claude: AgentAdapter = {
  kind: "claude",
  label: "Claude Code",
  home: ".claude/projects",
  async prepare(roots, listing): Promise<ClaudePrepared> {
    const configDirs = new Set(roots.map(configDirOf));
    const scans = await Promise.all(
      [...configDirs].map(async (configDir) => {
        const scan = await invoke<{ present: boolean; sessions: LiveSession[]; reliable: boolean }>("live_sessions", {
          configDir,
          // A failed call says nothing about the folder: treat it as present but unreliable so shown birds stay
        }).catch(() => ({ present: true, sessions: [] as LiveSession[], reliable: false }));
        return { configDir, ...scan };
      }),
    );
    listing.liveSessions.push(...scans.flatMap((s) => s.sessions));
    return {
      presentConfigDirs: new Set(scans.filter((s) => s.present).map((s) => s.configDir)),
      // Reads where ps failed or sessions/*.json had an unreadable file. Birds are not removed based on this read
      unreliableConfigDirs: new Set(scans.filter((s) => !s.reliable).map((s) => s.configDir)),
      pidBySessionId: new Map(scans.flatMap((s) => s.sessions.map((l) => [l.sessionId, l.pid] as const))),
    };
  },
  async list(root, { now, found, skippedIds, nextContinuedFrom }, prepared) {
    const { presentConfigDirs, unreliableConfigDirs, pidBySessionId } = prepared as ClaudePrepared;
    const configDir = configDirOf(root);
    // Older Claude Code without <config>/sessions: there is no pid to check, so no birds
    if (!presentConfigDirs.has(configDir)) return;
    const firstListing = !listedRootIds.has(root.id);
    for await (const entry of root.handle.values()) {
      if (entry.kind !== "directory") continue;
      const projectDir = entry as NativeDirectoryHandle;
      for await (const child of projectDir.values()) {
        if (child.kind !== "file" || !child.name.endsWith(".jsonl")) continue;
        const file = await (child as NativeFileHandle).getFile();
        const id = `${root.id}/${projectDir.name}/${child.name}`;
        const sessionId = child.name.slice(0, -".jsonl".length);
        if (!knownTranscriptIds.has(id)) {
          knownTranscriptIds.add(id);
          if (!firstListing) transcriptAppearedAt.set(id, now);
        }
        const pid = pidBySessionId.get(sessionId);
        // Candidates: the process is alive, the bird is already shown (it goes through the miss count in settleLiveness),
        // or the transcript appeared within NEVER_SEEN_GRACE_MS (the sessions file can lag behind it).
        // However long ago the transcript was written doesn't matter
        if (pid === undefined && !scanState.trackedIds.has(id) && !inNeverSeenGrace(id, now)) continue;
        // The completion check for chicks (subagents) treats the parent ledger (chickSignals in the parent
        // tail) as the source of truth, so read the parent's tail before scanChicks (see the isChick comment
        // in deriveState). The tail read here is reused when building withTail (displayNames) (to compute cwd/base
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
        // Handed over to another session (TailInfo.continuedIn). The new session has its own transcript and
        // bird; the old process may stay alive, but this conversation no longer moves here
        if (tail.continuedIn) {
          nextContinuedFrom.set(tail.continuedIn, sessionIdOfViewId(id));
          skippedIds.add(id);
          continue;
        }
        const chicks = await scanChicks(projectDir, child.name, id, now, tail.chickSignals, file);
        found.push({
          agent: "claude",
          rootId: root.id,
          rootLabel: root.label,
          slug: projectDir.name,
          file,
          id,
          tail,
          chicks,
          live: pid !== undefined ? true : unreliableConfigDirs.has(configDir) ? undefined : false,
          pid,
        });
      }
    }
    // Only a listing that got through the whole folder counts (a failed one would make its unlisted files look
    // new on the next listing)
    listedRootIds.add(root.id);
  },
};

// ---- Codex ----

interface CodexPrepared {
  threadsByCodexDir: Map<string, Map<string, CodexLock>>; // threadId → who holds its lock
  unreliableCodexDirs: Set<string>;
}

// shared: the holder is the codex app-server that TUIs share (live_codex_threads in Rust), not the TUI itself
interface CodexLock {
  pid: number;
  shared: boolean;
}

const codex: AgentAdapter = {
  kind: "codex",
  label: "Codex",
  home: ".codex/sessions",
  // The TUIs (and `codex exec`); the shared `codex app-server` has no tty and isn't one of them
  matchesProcess: (argv) => programNamed("codex")(argv) && !argv.includes("app-server"),
  // Codex threads whose process is alive, per <codex dir> (live_codex_threads in Rust: which
  // thread-writer-locks/<threadId>.lock files some process has open). unreliableCodexDirs are reads where lsof failed
  async prepare(roots): Promise<CodexPrepared> {
    const codexDirs = new Set(roots.map(codexDirOf));
    const scans = await Promise.all(
      [...codexDirs].map(async (codexDir) => {
        const scan = await invoke<{ threads: ({ threadId: string } & CodexLock)[]; reliable: boolean }>(
          "live_codex_threads",
          { codexDir },
        ).catch(() => ({ threads: [], reliable: false }));
        return { codexDir, ...scan };
      }),
    );
    return {
      threadsByCodexDir: new Map(
        scans.map((s) => [s.codexDir, new Map(s.threads.map((t) => [t.threadId, { pid: t.pid, shared: t.shared }]))]),
      ),
      unreliableCodexDirs: new Set(scans.filter((s) => !s.reliable).map((s) => s.codexDir)),
    };
  },
  /** Lists the rollouts of live (or already shown) threads of a Codex watched folder */
  async list(root, listing, prepared) {
    const { found, skippedIds } = listing;
    const { threadsByCodexDir, unreliableCodexDirs } = prepared as CodexPrepared;
    const codexDir = codexDirOf(root);
    const threads = threadsByCodexDir.get(codexDir) ?? new Map<string, CodexLock>();
    const sessionsDir = await codexSessionsDir(root.handle);
    if (!sessionsDir) return;
    // Rollouts of live threads (however old), plus birds already shown so they go through the miss count
    const rollouts = new Map<string, CodexRollout>(); // key: path
    for (const threadId of threads.keys()) {
      const rollout = await findCodexRollout(root.id, sessionsDir, threadId);
      if (rollout) rollouts.set(rollout.path, rollout);
    }
    const prefix = `${root.id}/codex/`;
    for (const trackedId of scanState.trackedIds) {
      if (!trackedId.startsWith(prefix)) continue;
      const path = trackedId.slice(prefix.length);
      if (rollouts.has(path)) continue;
      const file = await fileAt(sessionsDir, path);
      if (file) rollouts.set(path, { file, path });
    }
    const rows: { id: string; file: NativeFile; tail: TailInfo; threadId: string; lock: CodexLock | undefined }[] = [];
    for (const { file, path } of rollouts.values()) {
      const threadId = codexThreadIdOf(file.name);
      if (!threadId) continue;
      const id = `${prefix}${path}`;
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
      rows.push({ id, file, tail, threadId, lock: threads.get(threadId) });
    }
    // Locks held by the shared app-server stay held after their TUI exits: those threads are alive only while a TUI
    // in their cwd is (matchThreadsToProcesses), and the TUI is where a click jumps to
    const shared = rows.filter((r) => r.lock?.shared);
    const tuis = shared.length > 0 ? await listing.processes("codex") : { processes: [], reliable: true };
    const ownLocks = new Set([...threads.values()].filter((l) => !l.shared).map((l) => l.pid));
    const live = tuis.processes.filter((p) => !ownLocks.has(p.pid));
    if (tuis.reliable) rememberCodexTuis(live);
    const matches = matchThreadsToProcesses(
      shared.map((r) => ({ id: r.id, key: r.tail.cwd, writtenAt: r.file.lastModified, createdAt: uuidV7Time(r.threadId) })),
      [
        ...live.map((p) => ({ ...p, key: p.cwd, alive: true })),
        ...[...seenCodexTuis.values()]
          .filter((p) => !live.some((l) => l.pid === p.pid))
          .map((p) => ({ ...p, key: p.cwd, alive: false })),
      ],
    );
    const unreliable = unreliableCodexDirs.has(codexDir);
    for (const { id, file, tail, lock } of rows) {
      const cwd = tail.cwd;
      const match = lock?.shared ? matches.get(id) : undefined;
      // The app-server keeps an ended thread's lock: like a lock nobody holds, it only goes on for a bird on screen
      if (lock?.shared && !match && !scanState.trackedIds.has(id)) continue;
      const alive = lock?.shared
        ? match
          ? true
          : tuis.reliable
            ? false
            : undefined
        : lock !== undefined
          ? true
          : unreliable
            ? undefined
            : false;
      found.push({
        agent: "codex",
        rootId: root.id,
        rootLabel: root.label,
        slug: cwd ? `codex:${cwd}` : `codex:${file.name}`,
        file,
        id,
        tail,
        chicks: [],
        live: alive,
        pid: lock?.shared ? match?.pid : lock?.pid,
      });
    }
  },
  finish(roots, prepared) {
    const { threadsByCodexDir } = prepared as CodexPrepared;
    forgetEndedRollouts(
      roots,
      new Map([...threadsByCodexDir].map(([dir, threads]) => [dir, new Set(threads.keys())])),
    );
  },
};

// Codex TUIs seen alive (pid → start and cwd), kept after they exit so a thread created after a TUI started ends
// with that TUI instead of moving to an older one in the same cwd
const seenCodexTuis = new Map<number, AgentProcess>();
const MAX_SEEN_CODEX_TUIS = 64;

function rememberCodexTuis(processes: AgentProcess[]): void {
  for (const p of processes) {
    seenCodexTuis.delete(p.pid);
    seenCodexTuis.set(p.pid, p);
  }
  for (const pid of [...seenCodexTuis.keys()].slice(0, Math.max(0, seenCodexTuis.size - MAX_SEEN_CODEX_TUIS))) {
    seenCodexTuis.delete(pid);
  }
}

// ---- Qwen Code: pid from <sessionId>.runtime.json ----

const qwen: AgentAdapter = {
  kind: "qwen",
  label: "Qwen Code",
  home: ".qwen/projects",
  async list(root, { found }) {
    const sessions: { id: string; file: NativeFile; pid?: number; workDir?: string }[] = [];
    for await (const project of root.handle.values()) {
      if (project.kind !== "directory") continue;
      let chats: NativeDirectoryHandle;
      try {
        chats = await project.getDirectoryHandle("chats");
      } catch {
        continue;
      }
      const runtimes = new Map<string, { pid: number; workDir?: string }>();
      const transcripts = new Map<string, NativeFile>();
      for await (const child of chats.values()) {
        if (child.kind !== "file") continue;
        if (child.name.endsWith(".runtime.json")) {
          const runtime = parseQwenRuntime(await (await child.getFile()).text());
          if (runtime) runtimes.set(runtime.sessionId, runtime);
        } else if (child.name.endsWith(".jsonl")) {
          transcripts.set(child.name.slice(0, -".jsonl".length), await child.getFile());
        }
      }
      for (const [sessionId, file] of transcripts) {
        const id = `${root.id}/qwen/${project.name}/${file.name}`;
        const runtime = runtimes.get(sessionId);
        if (!runtime && !scanState.trackedIds.has(id)) continue;
        sessions.push({ id, file, pid: runtime?.pid, workDir: runtime?.workDir });
      }
    }
    // The runtime file stays after qwen exits, so only pids that are running count
    const pids = [...new Set(sessions.flatMap((s) => (s.pid === undefined ? [] : [s.pid])))];
    const scan = await invoke<{ alive: number[]; reliable: boolean }>("alive_pids", { pids }).catch(() => ({
      alive: [] as number[],
      reliable: false,
    }));
    const alive = new Set(scan.alive);
    for (const s of sessions) {
      const isAlive = s.pid !== undefined && alive.has(s.pid);
      if (!isAlive && !scanState.trackedIds.has(s.id)) continue;
      const tail = await readTailCachedWith(s.id, s.file, readQwenTail);
      const cwd = tail.cwd ?? s.workDir;
      found.push(entryOf("qwen", root, s.id, s.file, { ...tail, cwd }, isAlive ? true : scan.reliable ? false : undefined, isAlive ? s.pid : undefined));
    }
  },
};

// ---- Agents matched by process and cwd ----

interface ProcessCandidate {
  id: string;
  file: NativeFile;
  writtenAt: number;
  // Compared with keyOf(process cwd)
  key: string | undefined;
  read(cwd: string | undefined): Promise<TailInfo>;
}

/**
 * Shared listing of agents without a pid file: the sessions written since this agent's processes started (plus
 * the birds already shown), matched to the processes by cwd (matchSessionsToProcesses)
 */
async function listByProcess(
  kind: AgentKind,
  root: RootEntry,
  listing: ScanListing,
  candidates: (since: number | undefined) => AsyncIterable<ProcessCandidate>,
  keyOf: (cwd: string) => string = (cwd) => cwd,
): Promise<void> {
  if (!(await hasWork(kind, root, listing))) return;
  const { processes, reliable } = await listing.processes(kind);
  const since = reliable ? earliestStart(processes) : undefined;
  const picked: ProcessCandidate[] = [];
  for await (const c of candidates(since)) {
    const tracked = scanState.trackedIds.has(c.id);
    if (!tracked && (since === undefined || c.writtenAt < since)) continue;
    picked.push(c);
  }
  const matches = matchSessionsToProcesses(
    picked.map((c) => ({ id: c.id, key: c.key, writtenAt: c.writtenAt })),
    processes.map((p: AgentProcess) => ({ ...p, key: keyOf(p.cwd) })),
  );
  for (const c of picked) {
    const match = matches.get(c.id);
    if (match) lastCwdById.set(c.id, match.cwd);
    const tail = await c.read(match?.cwd ?? lastCwdById.get(c.id));
    const live = match ? true : reliable ? false : undefined;
    listing.found.push(entryOf(kind, root, c.id, c.file, tail, live, match?.pid));
  }
}

/** No process of this agent and no bird of this folder on screen: nothing to list (the folder isn't walked) */
async function hasWork(kind: AgentKind, root: RootEntry, listing: ScanListing): Promise<boolean> {
  const { processes, reliable } = await listing.processes(kind);
  const prefix = `${root.id}/${kind}/`;
  return processes.length > 0 || !reliable || [...scanState.trackedIds].some((id) => id.startsWith(prefix));
}

// The cwd a session was last matched with (for agents whose transcript has no cwd), so the name stays while it ends
const lastCwdById = new Map<string, string>();

function entryOf(
  agent: AgentKind,
  root: RootEntry,
  id: string,
  file: NativeFile,
  tail: TailInfo,
  live: boolean | undefined,
  pid: number | undefined,
): LiveFoundEntry {
  return {
    agent,
    rootId: root.id,
    rootLabel: root.label,
    // Key of the per-project icon set, shared across watched folders (the same as Codex's `codex:<cwd>`)
    slug: `${agent}:${tail.cwd ?? id}`,
    file,
    id,
    tail,
    chicks: [],
    live,
    pid,
  };
}

async function* filesIn(dir: NativeDirectoryHandle): AsyncGenerator<NativeFile> {
  for await (const child of dir.values()) if (child.kind === "file") yield await child.getFile();
}

const copilotCwdCache = new Map<string, string | undefined>(); // events.jsonl path → cwd of session.start

const copilot: AgentAdapter = {
  kind: "copilot",
  label: "GitHub Copilot CLI",
  home: ".copilot/session-state",
  matchesProcess: programNamed("copilot"),
  async list(root, listing) {
    await listByProcess("copilot", root, listing, async function* (since) {
      for await (const dir of root.handle.values()) {
        if (dir.kind !== "directory") continue;
        let file: NativeFile;
        try {
          file = await (await dir.getFileHandle("events.jsonl")).getFile();
        } catch {
          continue;
        }
        const id = `${root.id}/copilot/${dir.name}/events.jsonl`;
        if (!scanState.trackedIds.has(id) && (since === undefined || file.lastModified < since)) continue;
        if (!copilotCwdCache.has(file.path)) copilotCwdCache.set(file.path, await readCopilotStartCwd(file));
        const startCwd = copilotCwdCache.get(file.path);
        const tail = await readTailCachedWith(id, file, (f) => readCopilotTail(f, startCwd));
        yield { id, file, writtenAt: file.lastModified, key: tail.cwd, read: async () => tail };
      }
    });
  },
};

const gemini: AgentAdapter = {
  kind: "gemini",
  label: "Gemini CLI",
  home: ".gemini/tmp",
  matchesProcess: programNamed("gemini"),
  async list(root, listing) {
    // ~/.gemini/projects.json maps each project folder to its slug under ~/.gemini/tmp
    const geminiDir = new NativeDirectoryHandle(basename(root.path) === "tmp" ? parentDir(root.path) : trimSeparators(root.path));
    const projectsJson = await geminiDir
      .getFileHandle("projects.json")
      .then(async (h) => (await h.getFile()).text())
      .catch(() => undefined);
    await listByProcess("gemini", root, listing, async function* (since) {
      for await (const slugDir of root.handle.values()) {
        if (slugDir.kind !== "directory") continue;
        let chats: NativeDirectoryHandle;
        try {
          chats = await slugDir.getDirectoryHandle("chats");
        } catch {
          continue;
        }
        let cwd: string | undefined;
        for await (const file of filesIn(chats)) {
          if (!file.name.startsWith("session-") || !file.name.endsWith(".jsonl")) continue;
          const id = `${root.id}/gemini/${slugDir.name}/${file.name}`;
          if (!scanState.trackedIds.has(id) && (since === undefined || file.lastModified < since)) continue;
          cwd ??= await geminiProjectRoot(slugDir, projectsJson);
          const tail = await readTailCachedWith(id, file, (f) => readGeminiTail(f, cwd));
          yield { id, file, writtenAt: file.lastModified, key: cwd, read: async () => tail };
        }
      }
    });
  },
};

const opencode: AgentAdapter = {
  kind: "opencode",
  label: "OpenCode",
  home: ".local/share/opencode",
  matchesProcess: programNamed("opencode"),
  async list(root, listing) {
    if (!(await hasWork("opencode", root, listing))) return;
    const dbPath = `${trimSeparators(root.path)}/opencode.db`;
    const scan = await invoke<{ present: boolean; sessions: OpenCodeSession[]; reliable: boolean }>("opencode_sessions", {
      dbPath,
    }).catch(() => ({ present: true, sessions: [] as OpenCodeSession[], reliable: false }));
    if (!scan.present) return;
    // A failed read keeps the birds already shown: list them from the last sessions seen
    const sessions = scan.reliable ? scan.sessions : (lastOpenCodeSessions.get(root.id) ?? []);
    if (scan.reliable) lastOpenCodeSessions.set(root.id, scan.sessions);
    await listByProcess("opencode", root, listing, async function* (since) {
      for (const session of sessions) {
        // Subagent sessions point at their parent; like Codex's internal rollouts they get no bird of their own
        if (session.parentId) continue;
        const id = `${root.id}/opencode/${session.id}`;
        if (!scanState.trackedIds.has(id) && (since === undefined || session.lastWriteAt < since)) continue;
        const file = new NativeFile(`${dbPath}#${session.id}`, session.id, 0, session.lastWriteAt);
        const tail = await readTailCachedWith(id, file, async () => {
          const messages = await invoke<OpenCodeMessage[] | null>("opencode_tail", { dbPath, sessionId: session.id });
          return parseOpenCodeMessages(messages ?? [], session);
        });
        yield { id, file, writtenAt: session.lastWriteAt, key: session.directory, read: async () => tail };
      }
    });
  },
};
const lastOpenCodeSessions = new Map<string, OpenCodeSession[]>();

const cursor: AgentAdapter = {
  kind: "cursor",
  label: "Cursor CLI",
  home: ".cursor/projects",
  // cursor-agent 2025.09.18 runs as `<home>/.local/share/cursor-agent/versions/<v>/node --use-system-ca <same>/index.js`.
  // 2026.10.18 keeps the name it was started by as argv[0] (`<home>/.local/bin/cursor-agent --use-system-ca
  // <same>/index.js`, or `agent ...` when started by that name), and spawns `<same>/node <same>/index.js
  // worker-server`, which outlives the session (its parent becomes pid 1) and is not a session
  matchesProcess: (argv) => {
    const script = argv.findIndex((arg) => /[\\/]cursor-agent[\\/]versions[\\/][^\\/]+[\\/]index\.js$/.test(arg));
    if (script >= 0) return argv[script + 1] !== "worker-server";
    return basenameOf(programOf(argv) ?? "") === "cursor-agent";
  },
  async list(root, listing) {
    await listByProcess(
      "cursor",
      root,
      listing,
      async function* (since) {
        for await (const project of root.handle.values()) {
          if (project.kind !== "directory") continue;
          let transcripts: NativeDirectoryHandle;
          try {
            transcripts = await project.getDirectoryHandle("agent-transcripts");
          } catch {
            continue;
          }
          for await (const dir of transcripts.values()) {
            if (dir.kind !== "directory") continue;
            let file: NativeFile;
            try {
              file = await (await dir.getFileHandle(`${dir.name}.jsonl`)).getFile();
            } catch {
              continue;
            }
            const id = `${root.id}/cursor/${project.name}/${dir.name}/${file.name}`;
            if (!scanState.trackedIds.has(id) && (since === undefined || file.lastModified < since)) {
              forgetCursorFile(file.path);
              continue;
            }
            yield {
              id,
              file,
              writtenAt: file.lastModified,
              key: project.name,
              // The transcript has no cwd; it is the matched process's
              read: async (cwd) => ({ ...(await readTailCachedWith(id, file, readCursorTail)), cwd }),
            };
          }
        }
      },
      cursorProjectSlug,
    );
  },
};

export const AGENTS: AgentAdapter[] = [claude, codex, qwen, copilot, gemini, opencode, cursor];

export function agentOf(kind: AgentKind): AgentAdapter {
  return AGENTS.find((a) => a.kind === kind) ?? claude;
}
