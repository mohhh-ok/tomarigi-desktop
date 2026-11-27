// A chick that handed its report back, was sent one more request with SendMessage, resumed and handed back again, 18
// seconds after the parent's Agent tool_result. It stayed working and held its parent, which had ended its turn asking
// the user, at working, so the concierge didn't tell the user to answer (docs/design/finished-chicks.md "Chicks that have finished")
import { describe, expect, test } from "bun:test";
import type { NativeDirectoryHandle, NativeFile } from "../src/lib/native-fs.ts";
import { readTail } from "../src/lib/transcript.ts";
import { HAND_BACK_MARKER, scanChickSignals } from "../src/lib/transcript-chicks.ts";
import { scanChicks } from "../src/lib/session-chicks.ts";
import { escalateWithChicks } from "../src/lib/bird-state.ts";
import { buildConciergePayload } from "../src/lib/concierge.ts";
import type { SessionView } from "../src/lib/session-types.ts";

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SEC = 1000;
const MIN = 60 * SEC;

function fileOf(name: string, lines: object[]): NativeFile {
  const bytes = new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return {
    path: `/fake/${name}`,
    name,
    size: bytes.length,
    lastModified: T0,
    slice: (start = 0, end = bytes.length) => ({
      text: async () => {
        const norm = (v: number) => Math.min(bytes.length, Math.max(0, v < 0 ? bytes.length + v : v));
        return new TextDecoder().decode(bytes.slice(norm(start), norm(end)));
      },
    }),
    text: async () => new TextDecoder().decode(bytes),
  } as unknown as NativeFile;
}

function projectDir(sessionId: string, chickFile: string, chick: NativeFile, meta: object): NativeDirectoryHandle {
  const subagents = {
    async *values() {
      yield { kind: "file", name: chickFile, getFile: async () => chick };
    },
    async getFileHandle(name: string) {
      if (name !== chickFile.replace(/\.jsonl$/, ".meta.json")) throw new DOMException(name, "NotFoundError");
      return { getFile: async () => ({ text: async () => JSON.stringify(meta) }) };
    },
  };
  return {
    async getDirectoryHandle(name: string) {
      if (name !== sessionId) throw new DOMException(name, "NotFoundError");
      return { getDirectoryHandle: async () => subagents };
    },
  } as unknown as NativeDirectoryHandle;
}

const toolUse = (at: number, id: string, name: string, sidechain: boolean) => ({
  type: "assistant",
  isSidechain: sidechain,
  timestamp: iso(at),
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
});
const toolResult = (at: number, id: string, sidechain: boolean, text = "ok") => ({
  type: "user",
  isSidechain: sidechain,
  timestamp: iso(at),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] },
});
const prompt = (at: number, text: string, sidechain: boolean) => ({
  type: "user",
  isSidechain: sidechain,
  timestamp: iso(at),
  message: { role: "user", content: text },
});
const handBackNotice = (at: number, operation: string, from: string) => ({
  type: "queue-operation",
  operation,
  timestamp: iso(at),
  content: `<agent-message from="${from}">\n${HAND_BACK_MARKER} The text below is the final report of a subagent.`,
});
// Lines Claude Code writes with no time; they must not change anything
const untimed = [
  { type: "api-request-blob", hash: "h", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-agent", content: "x" }] } },
  { type: "data-flow-records", records: [{ response_id: "r" }], v: 1 },
];

const TASK = "a0chick";
const handBack = (at: number, id: string) => [
  toolUse(at, id, "SubagentHandback", true),
  toolResult(at + 400, id, true, '{"success":true,"message":"Report delivered to your caller."}'),
];
const chickLines = (withHandBack: boolean) => [
  prompt(T0, "Read these pages", true),
  toolUse(T0 + 10 * SEC, "c-fetch1", "WebFetch", true),
  toolResult(T0 + 12 * SEC, "c-fetch1", true),
  ...(withHandBack ? handBack(T0 + 29 * SEC, "c-hb1") : []),
  prompt(T0 + 37 * SEC, "The coordinator sent a message while you were working:\nPlease also read one more page", true),
  toolUse(T0 + 39 * SEC, "c-fetch2", "WebFetch", true),
  toolResult(T0 + 40 * SEC, "c-fetch2", true),
  ...(withHandBack ? handBack(T0 + 47.5 * SEC, "c-hb2") : []),
];
const parentLines = (withNotices: boolean) => [
  prompt(T0 - SEC, "Check the claims", false),
  toolUse(T0 - 500, "tu-agent", "Agent", false),
  ...(withNotices ? [handBackNotice(T0 + 29.7 * SEC, "enqueue", TASK)] : []),
  toolResult(T0 + 30 * SEC, "tu-agent", false, `This agent's report was delivered to you as a message from "${TASK}"`),
  ...(withNotices ? [handBackNotice(T0 + 31 * SEC, "remove", TASK)] : []),
  ...untimed,
  toolUse(T0 + 36.9 * SEC, "tu-send", "SendMessage", false),
  ...(withNotices ? [handBackNotice(T0 + 47.8 * SEC, "enqueue", TASK)] : []),
  toolResult(T0 + 48 * SEC, "tu-send", false, '{"success":true,"message":"Resumed agent. Its final report follows this JSON"}'),
  ...(withNotices ? [handBackNotice(T0 + 48.7 * SEC, "remove", TASK)] : []),
  { type: "assistant", timestamp: iso(T0 + 60 * SEC), message: { role: "assistant", content: [{ type: "text", text: "Shall I go on with 1?" }] } },
  ...untimed,
];

let run = 0;
async function chickOf(opts: { handBack: boolean; notices: boolean; now: number }) {
  run++;
  const sessionId = `parent-${run}`;
  const parent = fileOf(`${sessionId}.jsonl`, parentLines(opts.notices));
  // The parent's tail window is left empty: its lines leave the window as the parent writes on, so the records have to
  // come from the whole-transcript ledger
  const [scan] = await scanChicks(
    projectDir(sessionId, `agent-${TASK}.jsonl`, fileOf(`agent-${TASK}.jsonl`, chickLines(opts.handBack)), {
      description: "Verify claims",
      toolUseId: "tu-agent",
      spawnDepth: 1,
    }),
    `${sessionId}.jsonl`,
    sessionId,
    opts.now,
    new Map(),
    parent,
  );
  return scan;
}

// The parent ended its turn asking the user, about five minutes before
const NOW = T0 + 343 * SEC;

describe("a chick that handed back again after a SendMessage resume", () => {
  test("its own hand-back and the parent's hand-back notice each make it done", async () => {
    expect((await chickOf({ handBack: true, notices: true, now: NOW })).view.state).toBe("done");
    expect((await chickOf({ handBack: true, notices: false, now: NOW })).view.state).toBe("done");
    // its last write is 8 seconds earlier here, so it is already past DOZE_MS
    const byNotice = await chickOf({ handBack: false, notices: true, now: NOW });
    expect(byNotice.view.state).toBe("dozing");
    expect(byNotice.completed).toBe(true);
  });

  test("with neither, it is working only until CHICK_ABANDONED_MS after its last write", async () => {
    const lastWrite = T0 + 40 * SEC;
    expect((await chickOf({ handBack: false, notices: false, now: lastWrite + 10 * MIN - 1 })).view.state).toBe("working");
    expect((await chickOf({ handBack: false, notices: false, now: lastWrite + 10 * MIN })).view.state).toBe("dozing");
  });

  test("its parent, which ended its turn asking, is not held at working and the concierge is told it needs a reply", async () => {
    const chick = (await chickOf({ handBack: true, notices: true, now: NOW })).view;
    const state = escalateWithChicks("done", [chick]);
    expect(state).toBe("done");
    const view: SessionView = { id: "p", project: "P", slug: "p", state, sinceMs: NOW - (T0 + 60 * SEC), ask: { status: "asking" }, chicks: [chick] };
    const [session] = buildConciergePayload([{ view, agent: "claude", line: "Shall I go on with 1?" }], [], [], NOW, "ja").sessions;
    expect(session.chicks_working).toBeUndefined();
    expect(session.needs_reply).toBe(true);
  });
});

describe("readTail: hand-back, open tools and the hand-back notice", () => {
  const tailOf = (lines: object[]) => readTail(fileOf("t.jsonl", lines), { includeSidechain: true });

  test("handedBack on the hand-back's result and on its call alone; a later conversation line clears it", async () => {
    expect((await tailOf(handBack(T0, "hb"))).handedBack).toBe(true);
    expect((await tailOf([toolUse(T0, "hb", "SubagentHandback", true)])).handedBack).toBe(true);
    expect((await tailOf([...handBack(T0, "hb"), prompt(T0 + SEC, "one more", true)])).handedBack).toBeUndefined();
    expect((await tailOf([...handBack(T0, "hb"), toolResult(T0 + SEC, "other", true)])).handedBack).toBeUndefined();
  });

  test("toolOpen while a call has no result, also when the tail is a parallel call's result", async () => {
    expect((await tailOf([toolUse(T0, "a", "Bash", true)])).toolOpen).toBe(true);
    const parallel = {
      type: "assistant",
      isSidechain: true,
      timestamp: iso(T0),
      message: { content: [{ type: "tool_use", id: "a", name: "Bash", input: {} }, { type: "tool_use", id: "b", name: "Read", input: {} }] },
    };
    expect((await tailOf([parallel, toolResult(T0 + SEC, "b", true)])).toolOpen).toBe(true);
    expect((await tailOf([parallel, toolResult(T0 + SEC, "b", true), toolResult(T0 + 2 * SEC, "a", true)])).toolOpen).toBeUndefined();
  });

  test("the hand-back notice is a completion record of its chick; another agent-message is not", async () => {
    const tail = await readTail(fileOf("p.jsonl", [handBackNotice(T0, "enqueue", "x1"), handBackNotice(T0 + SEC, "remove", "x1")]));
    expect(tail.chickSignals.get("x1")).toBe(T0 + SEC);
    const other = { type: "queue-operation", operation: "enqueue", timestamp: iso(T0), content: '<agent-message from="x2">\nhello' };
    expect((await readTail(fileOf("p.jsonl", [other]))).chickSignals.has("x2")).toBe(false);
  });

  test("the tail window and the whole-transcript scan read the hand-back notice alike", async () => {
    const file = fileOf("p.jsonl", [handBackNotice(T0, "enqueue", "x1")]);
    expect((await readTail(file)).chickSignals.get("x1")).toBe(T0);
    expect((await scanChickSignals(file, 0)).signals.get("x1")).toBe(T0);
  });
});
