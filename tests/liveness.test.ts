// Birds are shown while their process is alive and removed once it ends, never because of elapsed time
// (docs/design.md "Removing birds of ended sessions"). Runs the real scanSessions against fixture folders.
// invoke is mocked: fs_* read the fixture files, live_sessions / live_codex_threads follow the same steps as the
// Rust commands (ps for Claude Code, lsof on thread-writer-locks for Codex) against real processes.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const entryOf = (name: string, st: fs.Stats) => ({
  name,
  kind: st.isDirectory() ? "directory" : "file",
  size: st.size,
  mtimeMs: Math.floor(st.mtimeMs),
});
const wrap = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    throw (e as NodeJS.ErrnoException).code === "ENOENT" ? `NotFound: ${(e as NodeJS.ErrnoException).path}` : String(e);
  }
};
const isAlive = (pid: number) => {
  try {
    execFileSync("ps", ["-p", String(pid)]);
    return true;
  } catch {
    return false;
  }
};

// focus_session calls from focusSession (sessionId, and "+app" when asked to fall back to the app), and the level
// each sessionId answers (Rust's FocusResult)
const focusCalls: string[] = [];
const focusResults = new Map<string, "pane" | "app" | "none">();
// Claude Code sessions the Claude desktop app runs (open_desktop_session opens them; it is "none" for any other)
const desktopSessions = new Set<string>();
// live_sessions answers by configDir that bypass ps, to drive reads exactly (sessions listed as alive, reliable or not)
const liveOverride = new Map<string, { sessions: object[]; reliable: boolean }>();
// Agents without a pid file (docs/design.md "Agents"): stand-in processes and the command line ps shows for each.
// tty_processes answers with the ones still alive; process_cwds runs the real lsof on them
const agentCommands = new Map<number, { command: string; startedAtMs: number }>();
// Lock holders that live_codex_threads reports as the shared codex app-server (Rust reads their command line)
const appServerPids = new Set<number>();
let psFails = false;
// OpenCode's database as the Rust side returns it (src-tauri/src/opencode.rs), by dbPath
const openCodeDbs = new Map<string, { sessions: object[]; tails: Map<string, object[]> }>();
// scan_peer_names answers by transcript path (the Rust command is tested in src-tauri); the rest get no traces
const peerScans = new Map<string, object>();
// The desktop app's records, as desktop_started_cards reads them (the Rust command is tested in src-tauri): sessions
// started from cards (the starter's local id and the task id, and when the record was written), and each session's
// local id by its transcript id. spawnedUnreadable stands for records that can't be read; cardReads keeps each call
const spawnedRecords: { parent: string; taskId: string; writtenAt: number }[] = [];
const desktopHosts = new Map<string, string>();
let spawnedUnreadable = false;
const cardReads: { parents: { cli: string; host: string | null }[]; sinceMs: number }[] = [];
// The desktop app's records as desktop_side_chats reads them (the Rust command is tested in src-tauri): by local id,
// whether the record is a side chat's (`spawnedFrom.btw`); an id not here has no record or can't be read yet.
// sideChatAsks keeps the ids of each call
const sideChatRecords = new Map<string, boolean>();
const sideChatAsks: string[][] = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, never>) => {
    switch (cmd) {
      case "fs_list":
        return wrap(() =>
          fs.readdirSync(args.path).map((n) => entryOf(n, fs.statSync(path.join(args.path, n)))),
        );
      case "fs_stat":
        return wrap(() => entryOf(path.basename(args.path), fs.statSync(args.path)));
      case "fs_read":
        return wrap(() => {
          const fd = fs.openSync(args.path, "r");
          const buf = Buffer.alloc(Math.max(0, (args.end as number) - (args.start as number)));
          const n = fs.readSync(fd, buf, 0, buf.length, args.start);
          fs.closeSync(fd);
          return buf.subarray(0, n).toString("utf8");
        });
      case "live_sessions": {
        const override = liveOverride.get(args.configDir);
        if (override) return { present: true, ...override };
        const dir = path.join(args.configDir, "sessions");
        if (!fs.existsSync(dir)) return { present: false, sessions: [], reliable: true };
        const sessions = fs
          .readdirSync(dir)
          .filter((n) => n.endsWith(".json"))
          .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")));
        return { present: true, sessions: sessions.filter((s) => isAlive(s.pid)), reliable: true };
      }
      case "live_codex_threads": {
        const dir = path.join(args.codexDir, "thread-writer-locks");
        if (!fs.existsSync(dir)) return { threads: [], reliable: true };
        let out = "";
        try {
          out = execFileSync("lsof", ["-w", "-F", "pn", "+d", dir]).toString();
        } catch (e) {
          out = String((e as { stdout?: Buffer }).stdout ?? ""); // exits with 1 even when files are found
        }
        const threads: { threadId: string; pid: number; shared: boolean }[] = [];
        let pid = 0;
        for (const line of out.split("\n")) {
          if (line.startsWith("p")) pid = Number(line.slice(1));
          const file = line.startsWith("n") ? path.basename(line.slice(1)) : "";
          if (file.endsWith(".lock") && !file.startsWith(".")) {
            threads.push({ threadId: file.slice(0, -5), pid, shared: appServerPids.has(pid) });
          }
        }
        return { threads, reliable: true };
      }
      case "tty_processes":
        if (psFails) return { processes: [], reliable: false };
        return {
          processes: [...agentCommands]
            .filter(([pid]) => isAlive(pid))
            .map(([pid, p]) => ({ pid, tty: "ttys009", startedAtMs: p.startedAtMs, command: p.command })),
          reliable: true,
        };
      case "process_cwds": {
        const pids = args.pids as number[];
        let out = "";
        try {
          out = execFileSync("lsof", ["-w", "-a", "-d", "cwd", "-p", pids.join(","), "-Fn"]).toString();
        } catch (e) {
          out = String((e as { stdout?: Buffer }).stdout ?? "");
        }
        const cwds: [number, string][] = [];
        let pid = 0;
        for (const l of out.split("\n")) {
          if (l.startsWith("p")) pid = Number(l.slice(1));
          if (l.startsWith("n")) cwds.push([pid, l.slice(1)]);
        }
        return { cwds, reliable: true };
      }
      case "alive_pids":
        return { alive: (args.pids as number[]).filter(isAlive), reliable: true };
      case "opencode_sessions": {
        const db = openCodeDbs.get(args.dbPath);
        return db ? { present: true, sessions: db.sessions, reliable: true } : { present: false, sessions: [], reliable: true };
      }
      case "opencode_tail":
        return openCodeDbs.get(args.dbPath)?.tails.get(args.sessionId) ?? null;
      case "scan_peer_names":
        return peerScans.get(args.path) ?? { names: [], end: 0 };
      case "desktop_started_cards": {
        const parents = args.parents as { cli: string; host: string | null }[];
        cardReads.push({ parents, sinceMs: args.sinceMs as number });
        if (spawnedUnreadable) return { hosts: [], spawned: [], read: 0, readAtMs: Date.now(), reliable: false };
        const hosts: [string, string][] = parents.flatMap((p) => {
          const host = p.host === null ? desktopHosts.get(p.cli) : undefined;
          return host ? [[p.cli, host] as [string, string]] : [];
        });
        const hostOf = (p: { cli: string; host: string | null }) => p.host ?? hosts.find(([cli]) => cli === p.cli)?.[1];
        const fresh = spawnedRecords.filter((r) => r.writtenAt >= (args.sinceMs as number));
        const spawned = parents.flatMap((p) =>
          fresh.filter((r) => r.parent === hostOf(p)).map((r) => ({ cli: p.cli, taskId: r.taskId })),
        );
        return { hosts, spawned, read: fresh.length, readAtMs: Date.now(), reliable: true };
      }
      case "desktop_side_chats": {
        const ids = args.ids as string[];
        sideChatAsks.push(ids);
        return { answers: ids.flatMap((id) => (sideChatRecords.has(id) ? [[id, sideChatRecords.get(id)]] : [])), reliable: true };
      }
      case "log":
        return;
      case "focus_pid":
        focusCalls.push(`pid=${args.pid}${args.fallbackToApp ? "+app" : ""}`);
        return { level: "pane", detail: "" };
      case "open_desktop_session":
        if (!desktopSessions.has(args.sessionId)) return { level: "none", detail: "not a desktop session" };
        focusCalls.push(`desktop:${args.sessionId}`);
        return { level: "pane", detail: "" };
      case "focus_session":
        focusCalls.push(args.fallbackToApp ? `${args.sessionId}+app` : args.sessionId);
        return { level: focusResults.get(args.sessionId) ?? "none", detail: "" };
      default:
        throw `unmocked ${cmd}`;
    }
  },
}));

const { NativeDirectoryHandle } = await import("../src/lib/native-fs.ts");
const { scanSessions, jumpPidOf } = await import("../src/lib/sessions.ts");
const { focusTargetOf, focusSession } = await import("../src/lib/terminal-focus.ts");
const { cursorProjectSlug } = await import("../src/lib/cursor-transcript.ts");
const { startedCardCache, cardReadSince, pruneCaches } = await import("../src/lib/session-store.ts");
const { cardKey } = await import("../src/lib/proposals.ts");
type Roots = Parameters<typeof scanSessions>[0];

const base = fs.mkdtempSync(path.join(os.tmpdir(), "tomarigi-test-"));
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill();
  fs.rmSync(base, { recursive: true, force: true });
});

const MIN = 60_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const line = (o: object) => JSON.stringify(o) + "\n";
const setMtime = (file: string, msAgo: number) => {
  const t = new Date(Date.now() - msAgo);
  fs.utimesSync(file, t, t);
};
const rootOf = (id: string, kind: string, p: string) =>
  ({ id, kind, label: id, path: p, builtin: true, handle: new NativeDirectoryHandle(p) }) as unknown as Roots[number];
/** A stand-in for the agent process. Its pid is what sessions/<pid>.json or the lock holder points at */
const startProcess = (command = "exec sleep 600") => {
  const child = spawn("sh", ["-c", command], { stdio: "ignore" });
  children.push(child);
  return child;
};
const stop = async (child: ChildProcess) => {
  child.kill();
  while (isAlive(child.pid!)) await Bun.sleep(20);
};
/** Birds are removed only after MISSES_TO_END (2) reliable scans in a row, so scan twice */
const scanTwice = async (roots: Roots) => {
  await scanSessions(roots);
  return scanSessions(roots);
};

/** A Claude Code config dir with one session whose transcript was last written `idleMs` ago */
function claudeFixture(name: string, sessionId: string, idleMs: number) {
  const config = path.join(base, name);
  const proj = path.join(config, "projects", "-tmp-" + name);
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(config, "sessions"), { recursive: true });
  const transcript = path.join(proj, `${sessionId}.jsonl`);
  fs.writeFileSync(
    transcript,
    line({ type: "user", timestamp: iso(idleMs + MIN), cwd: `/tmp/${name}`, entrypoint: "cli", message: { role: "user", content: "task" } }) +
      line({ type: "assistant", timestamp: iso(idleMs), cwd: `/tmp/${name}`, message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
  );
  setMtime(transcript, idleMs);
  const live = (pid: number) =>
    fs.writeFileSync(path.join(config, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: `/tmp/${name}`, status: "idle" }));
  return { config, proj, transcript, live, roots: [rootOf(name, "claude", path.join(config, "projects"))] };
}

describe("Claude Code", () => {
  test("a live session idle for hours keeps its bird; it is removed once the process ends", async () => {
    const sid = "11111111-0000-4000-8000-000000000001";
    const fx = claudeFixture("idle", sid, 3 * 60 * MIN);
    const proc = startProcess();
    fx.live(proc.pid!);

    const alive = await scanTwice(fx.roots);
    expect(alive.views.map((v) => v.id)).toEqual([`idle/-tmp-idle/${sid}.jsonl`]);
    expect(alive.views[0].sinceMs).toBeGreaterThan(30 * MIN);

    await stop(proc);
    expect((await scanTwice(fx.roots)).views).toEqual([]);
  });

  test("a transcript whose process already ended gets no bird, even if it was written recently or touched", async () => {
    const fx = claudeFixture("dead", "22222222-0000-4000-8000-000000000002", 2_000);
    expect((await scanTwice(fx.roots)).views).toEqual([]);
    fs.appendFileSync(fx.transcript, line({ type: "last-prompt", lastPrompt: "x" }));
    expect((await scanTwice(fx.roots)).views).toEqual([]);
  });

  test("a session handed over to another session loses its bird even though its old process is still alive", async () => {
    const sid = "44444444-0000-4000-8000-000000000004";
    const fx = claudeFixture("handoff", sid, 2 * MIN);
    const proc = startProcess();
    fx.live(proc.pid!);
    expect((await scanTwice(fx.roots)).views.length).toBe(1);

    fs.appendFileSync(
      fx.transcript,
      line({ type: "continued-in", timestamp: iso(0), sessionId: sid, continuedInSessionId: "55555555-0000-4000-8000-000000000005" }),
    );
    expect((await scanTwice(fx.roots)).views).toEqual([]);
  });

  test("clicking the session a conversation was handed over to jumps to the pane of the process it came from", async () => {
    const oldSid = "66666666-0000-4000-8000-000000000006";
    const newSid = "77777777-0000-4000-8000-000000000007";
    const fx = claudeFixture("jump", oldSid, 2 * MIN);
    // The old process stays alive after the handover and keeps showing the conversation in its pane
    const oldProc = startProcess();
    fx.live(oldProc.pid!);
    fs.appendFileSync(
      fx.transcript,
      line({ type: "continued-in", timestamp: iso(0), sessionId: oldSid, continuedInSessionId: newSid }),
    );
    await scanSessions(fx.roots);
    // The new session runs in a background process whose tty isn't a terminal pane; the old process's pane shows it
    focusResults.set(newSid, "none");
    focusResults.set(oldSid, "pane");
    focusCalls.length = 0;
    await focusSession(`jump/-tmp-jump/${newSid}.jsonl`, fx.roots);
    expect(focusCalls).toEqual([newSid, oldSid]);

    // When the new session's own pane is found, it stops there
    focusResults.set(newSid, "pane");
    focusCalls.length = 0;
    await focusSession(`jump/-tmp-jump/${newSid}.jsonl`, fx.roots);
    expect(focusCalls).toEqual([newSid]);

    // When no pane is found in any of them, the app owning the first session is brought to the front
    focusResults.set(newSid, "none");
    focusResults.set(oldSid, "none");
    focusCalls.length = 0;
    await focusSession(`jump/-tmp-jump/${newSid}.jsonl`, fx.roots);
    expect(focusCalls).toEqual([newSid, oldSid, `${newSid}+app`]);
  });

  test("a session of the Claude desktop app opens there before any terminal is looked for; its chick opens it too", async () => {
    const sid = "88888888-0000-4000-8000-000000000008";
    const fx = claudeFixture("desk", sid, 2 * MIN);
    fx.live(startProcess().pid!);
    await scanSessions(fx.roots);
    desktopSessions.add(sid);
    focusCalls.length = 0;
    await focusSession(`desk/-tmp-desk/${sid}.jsonl`, fx.roots);
    await focusSession(`desk/-tmp-desk/${sid}.jsonl/agent-a1.jsonl`, fx.roots);
    expect(focusCalls).toEqual([`desktop:${sid}`, `desktop:${sid}`]);
    // Not one of the app's: its terminal pane, as before
    desktopSessions.delete(sid);
    focusResults.set(sid, "pane");
    focusCalls.length = 0;
    await focusSession(`desk/-tmp-desk/${sid}.jsonl`, fx.roots);
    expect(focusCalls).toEqual([`${sid}+app`]);
  });

  test("a chick without a completion record stays however long it is idle, and leaves once completion is recorded", async () => {
    const sid = "33333333-0000-4000-8000-000000000003";
    const taskId = "a0123456789abcdef";
    const fx = claudeFixture("chick", sid, 49 * MIN);
    const proc = startProcess();
    fx.live(proc.pid!);
    const chick = path.join(fx.proj, sid, "subagents", `agent-${taskId}.jsonl`);
    fs.mkdirSync(path.dirname(chick), { recursive: true });
    fs.writeFileSync(
      chick,
      line({ type: "assistant", isSidechain: true, timestamp: iso(40 * MIN), message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "long" } }] } }),
    );
    setMtime(chick, 40 * MIN);
    setMtime(fx.transcript, 49 * MIN);

    const before = await scanTwice(fx.roots);
    expect(before.views[0].chicks?.length).toBe(1);

    fs.appendFileSync(
      fx.transcript,
      line({ type: "queue-operation", operation: "enqueue", timestamp: iso(0), content: `<task-notification><task-id>${taskId}</task-id><status>completed</status></task-notification>` }),
    );
    // Push the record far out of the tail window; the ledger reads the whole transcript
    let filler = "";
    for (let i = 0; i < 400; i++) filler += line({ type: "system", timestamp: iso(0), content: "x".repeat(500) });
    fs.appendFileSync(fx.transcript, filler);
    const after = await scanSessions(fx.roots);
    expect(after.views[0].chicks ?? []).toEqual([]);
  });
});

describe("Claude Code liveness reads", () => {
  const sid = (n: number) => `88888888-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const liveRead = (config: string, sessions: object[], reliable = true) =>
    liveOverride.set(config, { sessions, reliable });

  test("a bird seen alive is removed only after MISSES_TO_END (2) reliable reads in a row without it", async () => {
    const id = sid(1);
    const fx = claudeFixture("miss", id, 2 * MIN);
    const alive = { pid: 1, sessionId: id, status: "idle" };
    liveRead(fx.config, [alive]);
    expect((await scanSessions(fx.roots)).views.length).toBe(1);

    liveRead(fx.config, []);
    expect((await scanSessions(fx.roots)).views.length).toBe(1);
    // Seen again: the count starts over
    liveRead(fx.config, [alive]);
    expect((await scanSessions(fx.roots)).views.length).toBe(1);
    liveRead(fx.config, []);
    expect((await scanSessions(fx.roots)).views.length).toBe(1);
    expect((await scanSessions(fx.roots)).views).toEqual([]);
  });

  test("an unreliable read neither removes nor counts", async () => {
    const id = sid(2);
    const fx = claudeFixture("unreliable", id, 2 * MIN);
    liveRead(fx.config, [{ pid: 1, sessionId: id, status: "idle" }]);
    expect((await scanSessions(fx.roots)).views.length).toBe(1);

    liveRead(fx.config, [], false);
    for (let i = 0; i < 3; i++) expect((await scanSessions(fx.roots)).views.length).toBe(1);
    liveRead(fx.config, []);
    expect((await scanSessions(fx.roots)).views.length).toBe(1);
    liveRead(fx.config, [], false);
    expect((await scanSessions(fx.roots)).views.length).toBe(1);
    liveRead(fx.config, []);
    expect((await scanSessions(fx.roots)).views).toEqual([]);
  });

  test("a transcript that appears after the first listing is shown during the grace without a live session", async () => {
    const fx = claudeFixture("grace", sid(3), 2 * MIN);
    liveRead(fx.config, []);
    // Already there on the first listing: no grace
    expect((await scanTwice(fx.roots)).views).toEqual([]);

    const fresh = sid(4);
    fs.writeFileSync(
      path.join(fx.proj, `${fresh}.jsonl`),
      line({ type: "user", timestamp: iso(0), cwd: "/tmp/grace", entrypoint: "cli", message: { role: "user", content: "new" } }),
    );
    const shown = await scanTwice(fx.roots);
    expect(shown.views.map((v) => v.id)).toEqual([`grace/-tmp-grace/${fresh}.jsonl`]);
    expect(shown.views[0].state).toBe("working");
  });

  test("status waiting in the sessions file makes the bird waiting", async () => {
    const id = sid(5);
    const fx = claudeFixture("waiting", id, 2 * MIN);
    liveRead(fx.config, [{ pid: 1, sessionId: id, status: "idle" }]);
    expect((await scanSessions(fx.roots)).views[0].state).toBe("done");
    liveRead(fx.config, [{ pid: 1, sessionId: id, status: "waiting" }]);
    expect((await scanSessions(fx.roots)).views[0].state).toBe("waiting");
  });

  test("done dozes off after DOZE_MS (5 minutes) since the last write", async () => {
    const id = sid(6);
    const fx = claudeFixture("doze", id, 5 * MIN + 10_000);
    liveRead(fx.config, [{ pid: 1, sessionId: id, status: "idle" }]);
    expect((await scanSessions(fx.roots)).views[0].state).toBe("dozing");
  });
});

// docs/design.md "Side chats and forked sessions of the Claude desktop app". Shaped like the real records on this machine:
// the side chat's transcript starts with its main session's lines copied with the main session's id, its process
// lingers idle after its turn, and its record has spawnedFrom.btw; ids and names made up
describe("side chats of the Claude desktop app", () => {
  const sid = (n: number) => `5cde0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const liveRead = (config: string, sessions: object[]) => liveOverride.set(config, { sessions, reliable: true });
  /** A desktop app main session and, beside it, a transcript started as a fork of it (a side chat or another fork) */
  function forkFixture(name: string, mainId: string, forkId: string) {
    const fx = claudeFixture(name, mainId, 2 * MIN);
    const main = fs.readFileSync(fx.transcript, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.stringify({ ...JSON.parse(l), sessionId: mainId }));
    fs.writeFileSync(fx.transcript, main.join("\n") + "\n");
    const forkPath = path.join(fx.proj, `${forkId}.jsonl`);
    const writeFork = () =>
      fs.writeFileSync(
        forkPath,
        main.join("\n") +
          "\n" +
          line({ type: "user", sessionId: forkId, timestamp: iso(MIN + 5_000), turnOrigin: "human", origin: { kind: "human" }, cwd: `/tmp/${name}`, entrypoint: "claude-desktop", message: { role: "user", content: "what is X" } }) +
          line({ type: "assistant", sessionId: forkId, timestamp: iso(MIN), cwd: `/tmp/${name}`, message: { role: "assistant", content: [{ type: "text", text: "X is a header" }] } }),
      );
    return { ...fx, forkPath, writeFork, mainView: `${name}/-tmp-${name}/${mainId}.jsonl`, forkView: `${name}/-tmp-${name}/${forkId}.jsonl` };
  }
  const live = (id: string, pid: number, host?: string) => ({ pid, sessionId: id, status: "idle", entrypoint: "claude-desktop", ...(host && { hostSessionId: host }) });

  test("a side chat whose process lingers gets no bird, isn't linked, and its main session doesn't watch it", async () => {
    const mainId = sid(1);
    const sideId = sid(2);
    const fx = forkFixture("btw", mainId, sideId);
    fx.writeFork();
    sideChatRecords.set(`local_${mainId}`, false);
    sideChatRecords.set(`local_${sideId}`, true);
    liveRead(fx.config, [live(mainId, 1, `local_${mainId}`), live(sideId, 2, `local_${sideId}`)]);
    // The main session's traces name the side chat (as a link to it would)
    peerScans.set(fx.transcript, { names: [[`local_${sideId}`, iso(MIN)]], end: 0 });
    sideChatAsks.length = 0;
    const first = await scanTwice(fx.roots);
    expect(first.views.map((v) => v.id)).toEqual([fx.mainView]);
    expect(first.views[0].peers ?? []).toEqual([]);
    expect(first.views[0].watching).toBeUndefined();
    expect(first.events.filter((e) => e.sessionId === fx.forkView)).toEqual([]);
    // Each record is read once: the second load asks for nothing
    expect(sideChatAsks).toEqual([[`local_${mainId}`, `local_${sideId}`]]);
  });

  test("a side chat shown before its record could be read leaves on the load that reads it, with its Recent activity rows", async () => {
    const mainId = sid(3);
    const sideId = sid(4);
    const fx = forkFixture("btwlate", mainId, sideId);
    fx.writeFork();
    sideChatRecords.set(`local_${mainId}`, false);
    liveRead(fx.config, [live(mainId, 3, `local_${mainId}`), live(sideId, 4, `local_${sideId}`)]);
    const before = await scanTwice(fx.roots);
    expect(before.views.map((v) => v.id).sort()).toEqual([fx.mainView, fx.forkView].sort());
    expect(before.events.some((e) => e.sessionId === fx.forkView)).toBe(true);
    // Its own lines only: its state comes from its reply, not from the main session's copied turn
    expect(before.views.find((v) => v.id === fx.forkView)?.state).toBe("done");

    sideChatRecords.set(`local_${sideId}`, true);
    const after = await scanSessions(fx.roots);
    expect(after.views.map((v) => v.id)).toEqual([fx.mainView]);
    expect(after.events.filter((e) => e.sessionId === fx.forkView)).toEqual([]);
    // Leaving made no event of its own (no ended row, nothing to read aloud)
    expect(after.events.length).toBe(before.events.filter((e) => e.sessionId !== fx.forkView).length);
  });

  test("a new side chat whose sessions file isn't there yet is dropped on its first load by its own id", async () => {
    const mainId = sid(5);
    const sideId = sid(6);
    const fx = forkFixture("btwnew", mainId, sideId);
    sideChatRecords.set(`local_${mainId}`, false);
    liveRead(fx.config, [live(mainId, 5, `local_${mainId}`)]);
    await scanTwice(fx.roots);
    // The transcript appears after the first listing (within the grace), before its process is seen
    fx.writeFork();
    sideChatRecords.set(`local_${sideId}`, true);
    const shown = await scanSessions(fx.roots);
    expect(shown.views.map((v) => v.id)).toEqual([fx.mainView]);
  });

  test("a fork another session started is shown, judged from its own lines; the main session is unchanged", async () => {
    const mainId = sid(7);
    const forkId = sid(8);
    const fx = forkFixture("fork", mainId, forkId);
    fx.writeFork();
    sideChatRecords.set(`local_${mainId}`, false);
    sideChatRecords.set(`local_${forkId}`, false);
    liveRead(fx.config, [live(mainId, 7, `local_${mainId}`), live(forkId, 8, `local_${forkId}`)]);
    const shown = await scanTwice(fx.roots);
    expect(shown.views.map((v) => v.id).sort()).toEqual([fx.mainView, fx.forkView].sort());
    expect(shown.views.find((v) => v.id === fx.forkView)?.state).toBe("done");
    expect(shown.views.find((v) => v.id === fx.mainView)?.state).toBe("done");
  });

  test("a session whose record isn't found is shown as usual, and asked about again on the next load", async () => {
    const id = sid(9);
    const fx = claudeFixture("norecord", id, 2 * MIN);
    liveRead(fx.config, [live(id, 9, `local_${id}`)]);
    sideChatAsks.length = 0;
    const shown = await scanTwice(fx.roots);
    expect(shown.views.map((v) => v.id)).toEqual([`norecord/-tmp-norecord/${id}.jsonl`]);
    expect(sideChatAsks).toEqual([[`local_${id}`], [`local_${id}`]]);
    // A terminal session (no hostSessionId) is never asked about
    const cli = sid(10);
    const fx2 = claudeFixture("terminal", cli, 2 * MIN);
    liveRead(fx2.config, [{ pid: 10, sessionId: cli, status: "idle" }]);
    sideChatAsks.length = 0;
    expect((await scanTwice(fx2.roots)).views.length).toBe(1);
    expect(sideChatAsks).toEqual([]);
  });
});

describe("a Claude desktop app session that leaves a proposal card", () => {
  // The reported scene: the parent proposed a session as a card and ended asking the user to start it (docs/design.md "The "?"
  // for sessions waiting on you"). It waits on the user until the desktop app's record of a session says it came from
  // that card, and that stays after the session ends and after this app restarts
  const PARENT_HOST = "local_0a1b2c3d-0000-4000-8000-000000000001";
  const CHILD_HOST = "local_0a1b2c3d-0000-4000-8000-000000000002";
  const TITLE = "検索結果に画像を出す";
  let scene = 0;

  /** A parent whose last turn left the card task_id; returns how to scan it and how to start a child from the card */
  function parentWithCard(taskId: string, opts: { hostInSessionsFile?: boolean } = {}) {
    const name = `proposal-${++scene}`;
    const config = path.join(base, name);
    const proj = path.join(config, "projects", `-tmp-${name}`);
    fs.mkdirSync(proj, { recursive: true });
    const parentId = `99999999-0000-4000-8000-${String(scene * 2).padStart(12, "0")}`;
    const childId = `99999999-0000-4000-8000-${String(scene * 2 + 1).padStart(12, "0")}`;
    const parentFile = path.join(proj, `${parentId}.jsonl`);
    const at = (msAgo: number, o: object) => line({ timestamp: iso(msAgo), cwd: `/tmp/${name}`, ...o });
    fs.writeFileSync(
      parentFile,
      at(3 * MIN, { type: "user", turnOrigin: "human", message: { content: "直して" } }) +
        at(2 * MIN + 10_000, {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "t1", name: "mcp__ccd_session__start_session", input: { initiation: "own_initiative", title: TITLE } }] },
        }) +
        at(2 * MIN + 9_000, {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: `Proposed "${TITLE}" (task_id: ${taskId}). The user sees a card` }] }] },
        }) +
        at(2 * MIN, { type: "assistant", message: { content: [{ type: "text", text: "カードを出しました。押してください。" }] } }),
    );
    const parentLive = {
      pid: 1,
      sessionId: parentId,
      status: "idle",
      ...(opts.hostInSessionsFile !== false && { hostSessionId: PARENT_HOST }),
      startedAt: Date.now() - 60 * MIN,
    };
    desktopHosts.set(parentId, PARENT_HOST);
    liveOverride.set(config, { sessions: [parentLive], reliable: true });
    const roots = [rootOf(name, "claude", path.join(config, "projects"))];
    const scan = async () => {
      const r = await scanSessions(roots);
      return { parent: r.views.find((v) => v.id.endsWith(`${parentId}.jsonl`)), child: r.views.find((v) => v.id.endsWith(`${childId}.jsonl`)) };
    };
    /** The user starts the card: the app writes the child's record and its first prompt naming the parent's notes folder */
    const startChild = (fromTask: string) => {
      spawnedRecords.push({ parent: PARENT_HOST, taskId: fromTask, writtenAt: Date.now() });
      const childFile = path.join(proj, `${childId}.jsonl`);
      fs.writeFileSync(
        childFile,
        at(0, {
          type: "user",
          turnOrigin: "host_synthetic",
          message: { content: `Shared notes folder for this group of sessions: /Users/x/Library/Application Support/Claude/side-session-notes/${PARENT_HOST}` },
        }),
      );
      peerScans.set(childFile, { names: [], firstPrompt: { turnOrigin: "host_synthetic", namedAtLaunch: false, at: iso(0) }, end: 0 });
      const childLive = { pid: 2, sessionId: childId, status: "busy", hostSessionId: CHILD_HOST, startedAt: Date.now() - 1_000 };
      liveOverride.set(config, { sessions: [parentLive, childLive], reliable: true });
    };
    const childEnds = () => liveOverride.set(config, { sessions: [parentLive], reliable: true });
    const nextTurn = () =>
      fs.appendFileSync(
        parentFile,
        at(60_000, { type: "user", turnOrigin: "human", message: { content: "ここでやって" } }) +
          at(30_000, { type: "assistant", message: { content: [{ type: "text", text: "ここで進めました。" }] } }),
      );
    return { scan, startChild, childEnds, nextTurn, childId, parentId };
  }

  test("it needs a reply until a session started from the card; that stays after the session ends and a restart", async () => {
    const p = parentWithCard("task_0000aaaa");
    const waiting = (await p.scan()).parent;
    expect(waiting?.state).toBe("waiting");
    expect(waiting?.waitingOn).toBe("proposal");
    expect(waiting?.question).toBe(TITLE);

    p.startChild("task_0000aaaa");
    const started = await p.scan();
    expect(started.parent?.state).toBe("done");
    expect(started.parent?.waitingOn).toBeUndefined();
    // The child is linked from its first prompt and taken over by its parent from its start
    expect(started.parent?.peers?.map((x) => x.sessionId)).toEqual([p.childId]);
    expect(started.child?.parentTakesOver).toBe(true);

    // The child's process ends: the link is gone, the card stays started
    p.childEnds();
    // Its bird leaves after MISSES_TO_END (2) reads without it
    await p.scan();
    const ended = (await p.scan()).parent;
    expect(ended?.peers).toBeUndefined();
    expect(ended?.state).toBe("done");

    // This app restarts: what it remembered is gone, the app's record is still there
    startedCardCache.clear();
    cardReadSince.clear();
    expect((await p.scan()).parent?.state).toBe("done");
  });

  test("a parent whose sessions file has no local id (its process ended, say) is looked up in the app's records", async () => {
    const p = parentWithCard("task_0000eeee", { hostInSessionsFile: false });
    cardReads.length = 0;
    expect((await p.scan()).parent?.waitingOn).toBe("proposal");
    expect(cardReads.at(-1)?.parents).toEqual([{ cli: p.parentId, host: null }]);
    p.startChild("task_0000eeee");
    expect((await p.scan()).parent?.state).toBe("done");
    // Looked up once: later reads pass the local id found
    expect(cardReads.at(-1)?.parents).toEqual([{ cli: p.parentId, host: PARENT_HOST }]);
  });

  test("the first read goes back to the card, later ones ask only for records written since", async () => {
    const p = parentWithCard("task_0000ffff");
    cardReads.length = 0;
    await p.scan();
    await p.scan();
    await p.scan();
    const sinces = cardReads.map((r) => r.sinceMs);
    expect(sinces).toHaveLength(3);
    // The card's time first (2 minutes and 9 seconds ago), then each read's start less the overlap
    expect(sinces[0]).toBeLessThan(Date.now() - 2 * MIN);
    expect(sinces[1]).toBeGreaterThan(Date.now() - 10_000);
    expect(sinces[2]).toBeGreaterThanOrEqual(sinces[1]);
    // A record written before the last read's start, less the overlap, isn't read again
    spawnedRecords.push({ parent: PARENT_HOST, taskId: "task_old", writtenAt: Date.now() - MIN });
    await p.scan();
    expect(cardReads.at(-1)?.sinceMs).toBeGreaterThan(Date.now() - MIN);
  });

  test("what is remembered about cards goes with the session's bird", () => {
    startedCardCache.add(cardKey("gone/-tmp-gone/x.jsonl", "task_z"));
    cardReadSince.set(cardKey("gone/-tmp-gone/x.jsonl", "task_y"), 1);
    pruneCaches([], new Set());
    expect(startedCardCache.has(cardKey("gone/-tmp-gone/x.jsonl", "task_z"))).toBe(false);
    expect(cardReadSince.size).toBe(0);
  });

  test("a session from another card, or linked without a record, doesn't start it", async () => {
    const p = parentWithCard("task_0000bbbb");
    p.startChild("task_0000cccc");
    const r = await p.scan();
    expect(r.parent?.peers?.map((x) => x.sessionId)).toEqual([p.childId]);
    expect(r.parent?.waitingOn).toBe("proposal");
  });

  test("the next turn ends the wait, also when the app's records can't be read", async () => {
    const p = parentWithCard("task_0000dddd");
    spawnedUnreadable = true;
    try {
      expect((await p.scan()).parent?.waitingOn).toBe("proposal");
      p.nextTurn();
      const next = (await p.scan()).parent;
      expect(next?.state).toBe("done");
      expect(next?.waitingOn).toBeUndefined();
    } finally {
      spawnedUnreadable = false;
    }
  });
});

describe("Codex", () => {
  const codexDir = path.join(base, "codex");
  const pad = (n: number) => String(n).padStart(2, "0");
  const dayPath = (d: Date) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  /** UUIDv7 whose timestamp is `msAgo` ago, like Codex thread ids */
  const threadIdAt = (msAgo: number, tail: string) => {
    const h = (Date.now() - msAgo).toString(16).padStart(12, "0");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-7abc-8def-${tail}`;
  };
  const addThread = (threadId: string, msAgo: number, cwd = "/tmp/codex-fixture") => {
    const dir = path.join(codexDir, "sessions", dayPath(new Date(Date.now() - msAgo)));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-x-${threadId}.jsonl`);
    fs.writeFileSync(
      file,
      line({ timestamp: iso(msAgo), type: "session_meta", payload: { id: threadId, cwd, source: "cli", thread_source: "user" } }) +
        line({ timestamp: iso(msAgo), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }),
    );
    setMtime(file, msAgo);
    const lock = path.join(codexDir, "thread-writer-locks", `${threadId}.lock`);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    return lock;
  };
  const roots = [rootOf("cx", "codex", path.join(codexDir, "sessions"))];

  test("a thread held by a live codex is shown even days later; the lock file left behind after exit does not keep it", async () => {
    const oldId = threadIdAt(5 * 24 * 60 * MIN, "000000000001");
    const lock = addThread(oldId, 5 * 24 * 60 * MIN);
    const deadId = threadIdAt(60 * MIN, "000000000002");
    addThread(deadId, 60 * MIN); // lock file exists, nobody holds it
    const proc = startProcess(`exec 3<"${lock}"; exec sleep 600`);
    await Bun.sleep(200);

    const alive = await scanTwice(roots);
    expect(alive.views.map((v) => v.id)).toEqual([expect.stringContaining(oldId)]);
    // The codex holding the lock is the one to jump to
    expect(focusTargetOf(alive.views[0].id, roots)).toEqual({ kind: "pid", pid: proc.pid });

    await stop(proc);
    expect(fs.existsSync(lock)).toBe(true);
    expect((await scanTwice(roots)).views).toEqual([]);
  });

  test("0.163.0: locks held by the shared app-server; each thread is alive while its TUI is, and jumps to that TUI", async () => {
    const cwd = path.join(fs.realpathSync(base), "work", "codex-shared");
    fs.mkdirSync(cwd, { recursive: true });
    /** A codex TUI in cwd, started `msAgo` ago */
    const startTui = (msAgo: number) => {
      const child = spawn("sh", ["-c", "exec sleep 600"], { stdio: "ignore", cwd });
      children.push(child);
      agentCommands.set(child.pid!, { command: "codex", startedAtMs: Date.now() - msAgo });
      return child;
    };
    // Two TUIs in one cwd; each thread is created ~9 s after its TUI started (measured)
    const tui1 = startTui(60_000);
    const tui2 = startTui(20_000);
    const first = threadIdAt(51_000, "00000000000a");
    const second = threadIdAt(11_000, "00000000000b");
    const exited = threadIdAt(120_000, "00000000000c"); // its TUI exited; the app-server still holds the lock
    const locks = [addThread(first, 8_000, cwd), addThread(second, 4_000, cwd), addThread(exited, 100_000, cwd)];
    const server = startProcess(`exec 3<"${locks[0]}" 4<"${locks[1]}" 5<"${locks[2]}"; exec sleep 600`);
    appServerPids.add(server.pid!);
    await Bun.sleep(200);

    const shown = await scanTwice(roots);
    const byThread = (views: { id: string }[], threadId: string) => views.find((v) => v.id.includes(threadId));
    expect(byThread(shown.views, first)).toBeDefined();
    expect(byThread(shown.views, second)).toBeDefined();
    expect(byThread(shown.views, exited)).toBeUndefined();
    expect(focusTargetOf(byThread(shown.views, first)!.id, roots)).toEqual({ kind: "pid", pid: tui1.pid });
    expect(focusTargetOf(byThread(shown.views, second)!.id, roots)).toEqual({ kind: "pid", pid: tui2.pid });

    // Quitting a TUI ends its bird although the app-server keeps the lock
    await stop(tui2);
    const afterQuit = await scanTwice(roots);
    expect(byThread(afterQuit.views, second)).toBeUndefined();
    // and stays gone while the app-server still holds its lock
    expect(byThread((await scanSessions(roots)).views, second)).toBeUndefined();
    expect(focusTargetOf(byThread(afterQuit.views, first)!.id, roots)).toEqual({ kind: "pid", pid: tui1.pid });
    await stop(tui1);
    const none = (await scanTwice(roots)).views;
    expect([first, second, exited].map((t) => byThread(none, t))).toEqual([undefined, undefined, undefined]);
    const later = (await scanSessions(roots)).views;
    expect([first, second, exited].map((t) => byThread(later, t))).toEqual([undefined, undefined, undefined]);

    await stop(server);
    appServerPids.delete(server.pid!);
  });
});

describe("agents matched by process and cwd", () => {
  /** A stand-in for the agent's process, running in cwd, that ps shows as command */
  const startAgent = (command: string, cwd: string) => {
    const child = spawn("sh", ["-c", "exec sleep 600"], { stdio: "ignore", cwd });
    children.push(child);
    agentCommands.set(child.pid!, { command, startedAtMs: Date.now() - 1000 });
    return child;
  };
  const workDir = (name: string) => {
    const dir = path.join(fs.realpathSync(base), "work", name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  test("OpenCode: a session in the process's cwd is a bird with its pid, and is removed two reads after it ends", async () => {
    const cwd = workDir("oc-app");
    const home = path.join(base, "opencode");
    fs.mkdirSync(home, { recursive: true });
    const now = Date.now();
    openCodeDbs.set(path.join(home, "opencode.db"), {
      sessions: [
        { id: "ses_live", directory: cwd, parentId: null, timeCreated: now, lastWriteAt: now },
        { id: "ses_sub", directory: cwd, parentId: "ses_live", timeCreated: now, lastWriteAt: now },
        { id: "ses_yesterday", directory: cwd, parentId: null, timeCreated: now - 86_400_000, lastWriteAt: now - 86_400_000 },
      ],
      tails: new Map([
        ["ses_live", [
          { id: "m1", timeCreated: now - 500, timeUpdated: now - 500, data: { role: "user", time: { created: now - 500 } }, parts: [{ type: "text", text: { head: "hi", tail: "hi" } }] },
          { id: "m2", timeCreated: now - 400, timeUpdated: now, data: { role: "assistant", finish: "stop", time: { created: now - 400, completed: now } }, parts: [{ type: "text", text: { head: "Hello.", tail: "Hello." } }] },
        ]],
      ]),
    });
    const roots = [rootOf("oc", "opencode", home)];
    const proc = startAgent("/opt/homebrew/bin/opencode", cwd);

    const shown = await scanTwice(roots);
    expect(shown.views.map((v) => [v.id, v.project, v.state])).toEqual([["oc/opencode/ses_live", "oc-app", "working"]]);
    expect(jumpPidOf("oc/opencode/ses_live")).toBe(proc.pid!);
    // Clicking the bird jumps to that pid (focus_pid); the subagent and yesterday's session have no bird to click
    expect(focusTargetOf("oc/opencode/ses_live", roots)).toEqual({ kind: "pid", pid: proc.pid! });
    focusCalls.length = 0;
    await focusSession("oc/opencode/ses_live", roots);
    expect(focusCalls).toEqual([`pid=${proc.pid}+app`]);

    await stop(proc);
    expect((await scanSessions(roots)).views.length).toBe(1);
    expect((await scanSessions(roots)).views).toEqual([]);
    // Once the process is gone there is nothing to jump to
    expect(focusTargetOf("oc/opencode/ses_live", roots)).toBeNull();
  });

  test("Cursor CLI: the project folder is found from the process's cwd; nothing is removed on a read where ps failed", async () => {
    const cwd = workDir("cursor-app");
    const slug = cwd.replace(/[^A-Za-z0-9]/g, "-").replace(/^-+/, "");
    const id = "61a18a76-2dcd-4e2b-afd0-4a7c488bc1e4";
    const dir = path.join(base, "cursor", "projects", slug, "agent-transcripts", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      line({ role: "user", message: { content: [{ type: "text", text: "hi" }] } }) +
        line({ role: "assistant", message: { content: [{ type: "text", text: "Hello." }] } }) +
        line({ type: "turn_ended", status: "success" }),
    );
    const roots = [rootOf("cu", "cursor", path.join(base, "cursor", "projects"))];
    const proc = startAgent(
      "/Users/me/.local/share/cursor-agent/versions/2025.09.18-7ae6800/node --use-system-ca /Users/me/.local/share/cursor-agent/versions/2025.09.18-7ae6800/index.js",
      cwd,
    );

    const shown = await scanTwice(roots);
    expect(shown.views.map((v) => [v.project, v.cwd])).toEqual([["cursor-app", cwd]]);
    expect(jumpPidOf(shown.views[0].id)).toBe(proc.pid!);

    await stop(proc);
    psFails = true;
    expect((await scanTwice(roots)).views.length).toBe(1);
    psFails = false;
    expect((await scanSessions(roots)).views.length).toBe(1);
    expect((await scanSessions(roots)).views).toEqual([]);
  });

  test("Cursor CLI 2026.10.18: the session's process is a bird; the worker-server it leaves behind is not", async () => {
    // A cwd with a run of symbols: Cursor's folder name has one "-" for it
    const cwd = workDir("cu_.next");
    const slug = cursorProjectSlug(cwd);
    expect(slug.endsWith("-work-cu-next")).toBe(true);
    const id = "b0f9ecf2-2f0a-4ceb-9305-5ef778ead769";
    const dir = path.join(base, "cursor", "projects", slug, "agent-transcripts", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      line({ role: "user", message: { content: [{ type: "text", text: "<timestamp>Tuesday, Oct 20, 2026, 8:59 AM (UTC+9)</timestamp>\n<user_query>\nhi\n</user_query>" }] } }) +
        line({ role: "assistant", message: { content: [{ type: "text", text: "Hello.\n\n[REDACTED]" }] } }) +
        line({ type: "turn_ended", status: "success" }),
    );
    const roots = [rootOf("cu", "cursor", path.join(base, "cursor", "projects"))];
    const version = "/Users/me/.local/share/cursor-agent/versions/2026.10.18-ea085cb";
    // Started by the name `agent`: argv[0] is that name, not cursor-agent
    const proc = startAgent(`/Users/me/.local/bin/agent --use-system-ca ${version}/index.js`, cwd);
    const worker = startAgent(`${version}/node ${version}/index.js worker-server`, cwd);

    const shown = await scanTwice(roots);
    expect(shown.views.map((v) => [v.project, v.cwd])).toEqual([["cu_.next", cwd]]);
    expect(jumpPidOf(shown.views[0].id)).toBe(proc.pid!);

    // Quitting cursor-agent leaves the worker-server running in the same cwd; the bird still goes away
    await stop(proc);
    expect((await scanTwice(roots)).views).toEqual([]);
    await stop(worker);
  });

  test("Copilot CLI and Gemini CLI: sessions written since the process started are birds", async () => {
    const cwd = workDir("cli-app");
    const copilotDir = path.join(base, "copilot", "session-state", "8abb87fa-4187-49e0-ba62-ded536d9ba99");
    fs.mkdirSync(copilotDir, { recursive: true });
    fs.writeFileSync(
      path.join(copilotDir, "events.jsonl"),
      line({ type: "session.start", data: { sessionId: "8abb", context: { cwd } }, id: "e1", timestamp: iso(0), parentId: null }) +
        line({ type: "user.message", data: { content: "hi" }, id: "e2", timestamp: iso(0), parentId: "e1" }),
    );
    const geminiHome = path.join(base, "gemini");
    const chats = path.join(geminiHome, "tmp", "cli-app", "chats");
    fs.mkdirSync(chats, { recursive: true });
    fs.writeFileSync(path.join(geminiHome, "projects.json"), JSON.stringify({ projects: { [cwd]: "cli-app" } }));
    fs.writeFileSync(
      path.join(chats, "session-2026-10-18T01-00-1b9d6bcd.jsonl"),
      line({ sessionId: "1b9d", projectHash: "x", startTime: iso(0), lastUpdated: iso(0) }) +
        line({ id: "m1", timestamp: iso(0), type: "user", content: [{ text: "hi" }] }),
    );
    const roots = [
      rootOf("cp", "copilot", path.join(base, "copilot", "session-state")),
      rootOf("ge", "gemini", path.join(geminiHome, "tmp")),
    ];
    const copilot = startAgent("node /opt/homebrew/bin/copilot", cwd);
    const gemini = startAgent("node --no-warnings /opt/homebrew/bin/gemini", cwd);

    const shown = await scanTwice(roots);
    expect(shown.views.map((v) => [v.id.split("/")[1], v.project]).sort()).toEqual([
      // The same project seen from two watched folders gets the folder's label, as for Claude Code and Codex
      ["copilot", "cli-app (cp)"],
      ["gemini", "cli-app (ge)"],
    ]);
    expect(jumpPidOf(shown.views.find((v) => v.id.startsWith("cp/"))!.id)).toBe(copilot.pid!);
    expect(jumpPidOf(shown.views.find((v) => v.id.startsWith("ge/"))!.id)).toBe(gemini.pid!);

    await stop(copilot);
    await stop(gemini);
    expect((await scanTwice(roots)).views).toEqual([]);
  });

  test("Qwen Code: the pid comes from <sessionId>.runtime.json, which stays after qwen exits", async () => {
    const chats = path.join(base, "qwen", "projects", "-work-qwen-app", "chats");
    fs.mkdirSync(chats, { recursive: true });
    const sid = "0d6f3c1e-1111-4000-8000-000000000001";
    fs.writeFileSync(
      path.join(chats, `${sid}.jsonl`),
      line({ uuid: "u1", parentUuid: null, sessionId: sid, timestamp: iso(MIN), type: "user", cwd: "/work/qwen-app", version: "0.15.0", message: { role: "user", parts: [{ text: "hi" }] } }) +
        line({ uuid: "u2", parentUuid: "u1", sessionId: sid, timestamp: iso(MIN - 1000), type: "assistant", cwd: "/work/qwen-app", version: "0.15.0", message: { role: "model", parts: [{ text: "Hello." }] } }),
    );
    const proc = startProcess();
    fs.writeFileSync(
      path.join(chats, `${sid}.runtime.json`),
      JSON.stringify({ schema_version: 1, pid: proc.pid, session_id: sid, work_dir: "/work/qwen-app", hostname: "h", started_at: 1, qwen_version: "0.15.0" }),
    );
    const roots = [rootOf("qw", "qwen", path.join(base, "qwen", "projects"))];

    const shown = await scanTwice(roots);
    expect(shown.views.map((v) => [v.project, v.state])).toEqual([["qwen-app", "done"]]);
    expect(jumpPidOf(shown.views[0].id)).toBe(proc.pid!);

    await stop(proc);
    expect((await scanTwice(roots)).views).toEqual([]);
  });
});
