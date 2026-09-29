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

// focus_session calls from focusSession, and what each sessionId answers (Rust's focus_session result strings)
const focusCalls: string[] = [];
const focusResults = new Map<string, string>();
// live_sessions answers by configDir that bypass ps, to drive reads exactly (sessions listed as alive, reliable or not)
const liveOverride = new Map<string, { sessions: object[]; reliable: boolean }>();

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
        if (override) return { present: true, unreadable: 0, ...override };
        const dir = path.join(args.configDir, "sessions");
        if (!fs.existsSync(dir)) return { present: false, sessions: [], reliable: true, unreadable: 0 };
        const sessions = fs
          .readdirSync(dir)
          .filter((n) => n.endsWith(".json"))
          .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")));
        return { present: true, sessions: sessions.filter((s) => isAlive(s.pid)), reliable: true, unreadable: 0 };
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
        const threads: { threadId: string; pid: number }[] = [];
        let pid = 0;
        for (const line of out.split("\n")) {
          if (line.startsWith("p")) pid = Number(line.slice(1));
          const file = line.startsWith("n") ? path.basename(line.slice(1)) : "";
          if (file.endsWith(".lock") && !file.startsWith(".")) threads.push({ threadId: file.slice(0, -5), pid });
        }
        return { threads, reliable: true };
      }
      case "scan_peer_names":
        return { names: [], end: 0 };
      case "scan_log_enabled":
        return false;
      case "log":
        return;
      case "focus_session":
        focusCalls.push(args.sessionId);
        return focusResults.get(args.sessionId) ?? "no session file";
      default:
        throw `unmocked ${cmd}`;
    }
  },
}));

const { NativeDirectoryHandle } = await import("../src/lib/native-fs.ts");
const { scanSessions } = await import("../src/lib/sessions.ts");
const { focusTargetOf, focusSession } = await import("../src/lib/ghostty.ts");
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
const rootOf = (id: string, kind: "claude" | "codex", p: string) =>
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
    // The new session runs in a background process whose tty Ghostty doesn't have; the old process's pane shows it
    focusResults.set(newSid, "pid=2 tty=/dev/ttys003 NOT FOUND");
    focusResults.set(oldSid, "pid=1 tty=/dev/ttys002 front=/dev/ttys002");
    focusCalls.length = 0;
    await focusSession(`jump/-tmp-jump/${newSid}.jsonl`, fx.roots);
    expect(focusCalls).toEqual([newSid, oldSid]);

    // When the new session's own pane is found, it stops there
    focusResults.set(newSid, "pid=2 tty=/dev/ttys003 front=/dev/ttys003");
    focusCalls.length = 0;
    await focusSession(`jump/-tmp-jump/${newSid}.jsonl`, fx.roots);
    expect(focusCalls).toEqual([newSid]);
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

describe("Codex", () => {
  const codexDir = path.join(base, "codex");
  const pad = (n: number) => String(n).padStart(2, "0");
  const dayPath = (d: Date) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  /** UUIDv7 whose timestamp is `msAgo` ago, like Codex thread ids */
  const threadIdAt = (msAgo: number, tail: string) => {
    const h = (Date.now() - msAgo).toString(16).padStart(12, "0");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-7abc-8def-${tail}`;
  };
  const addThread = (threadId: string, msAgo: number) => {
    const dir = path.join(codexDir, "sessions", dayPath(new Date(Date.now() - msAgo)));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-x-${threadId}.jsonl`);
    fs.writeFileSync(
      file,
      line({ timestamp: iso(msAgo), type: "session_meta", payload: { id: threadId, cwd: "/tmp/codex-fixture", source: "cli", thread_source: "user" } }) +
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
    expect(focusTargetOf(alive.views[0].id, roots)).toEqual({ kind: "codex", codexDir, threadId: oldId });

    await stop(proc);
    expect(fs.existsSync(lock)).toBe(true);
    expect((await scanTwice(roots)).views).toEqual([]);
  });
});
