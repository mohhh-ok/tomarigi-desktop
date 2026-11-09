// Where a chick's completion record is found: a chick started by another chick (spawnDepth 2 or more) has it in the
// transcript of the chick that started it, not in the parent's (docs/design.md "Removing birds of ended sessions")
import { describe, expect, test } from "bun:test";
import type { NativeDirectoryHandle, NativeFile } from "../src/lib/native-fs.ts";
import { callerCandidates, scanChicks } from "../src/lib/session-chicks.ts";

const T0 = Date.parse("2026-11-09T07:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = T0 + 60 * 60_000; // an hour later: no recent writes anywhere

interface FakeFile {
  file: NativeFile;
  reads: number;
}

function fakeFile(name: string, lines: object[]): FakeFile {
  const bytes = new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const f: FakeFile = { reads: 0, file: undefined as unknown as NativeFile };
  f.file = {
    path: `/fake/${name}`,
    name,
    size: bytes.length,
    lastModified: T0,
    slice: (start = 0, end = bytes.length) => ({
      text: async () => {
        f.reads++;
        const norm = (v: number) => Math.min(bytes.length, Math.max(0, v < 0 ? bytes.length + v : v));
        return new TextDecoder().decode(bytes.slice(norm(start), norm(end)));
      },
    }),
    text: async () => new TextDecoder().decode(bytes),
  } as unknown as NativeFile;
  return f;
}

/** A subagents/ folder holding agent-<id>.jsonl and agent-<id>.meta.json */
function fakeProjectDir(sessionId: string, files: Map<string, FakeFile>, metas: Map<string, object>): NativeDirectoryHandle {
  const subagents = {
    async *values() {
      for (const [name, f] of files) yield { kind: "file", name, getFile: async () => f.file };
    },
    async getFileHandle(name: string) {
      const meta = metas.get(name);
      if (!meta) throw new DOMException(name, "NotFoundError");
      return { getFile: async () => ({ text: async () => JSON.stringify(meta) }) };
    },
  };
  const sessionDir = {
    async getDirectoryHandle(name: string) {
      if (name !== "subagents") throw new DOMException(name, "NotFoundError");
      return subagents;
    },
  };
  return {
    async getDirectoryHandle(name: string) {
      if (name !== sessionId) throw new DOMException(name, "NotFoundError");
      return sessionDir;
    },
  } as unknown as NativeDirectoryHandle;
}

// Lines of a transcript
const agentCall = (at: number, toolUseId: string, sidechain: boolean) => ({
  type: "assistant",
  isSidechain: sidechain,
  timestamp: iso(at),
  message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: {} }] },
});
const toolResult = (at: number, toolUseId: string, sidechain: boolean) => ({
  type: "user",
  isSidechain: sidechain,
  timestamp: iso(at),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
});
const reply = (at: number, sidechain: boolean) => ({
  type: "assistant",
  isSidechain: sidechain,
  timestamp: iso(at),
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
});
const notification = (at: number, taskId: string) => ({
  type: "queue-operation",
  operation: "enqueue",
  timestamp: iso(at),
  content: `<task-notification><task-id>${taskId}</task-id><status>completed</status></task-notification>`,
});

interface ChickSpec {
  id: string;
  depth?: number;
  toolUseId?: string;
  lines: object[];
}

let run = 0;
async function scan(parentLines: object[], chicks: ChickSpec[]) {
  run++;
  const sessionId = `parent-${run}`;
  const files = new Map<string, FakeFile>();
  const metas = new Map<string, object>();
  for (const c of chicks) {
    files.set(`agent-${c.id}.jsonl`, fakeFile(`agent-${c.id}.jsonl`, c.lines));
    metas.set(`agent-${c.id}.meta.json`, {
      description: c.id,
      ...(c.toolUseId && { toolUseId: c.toolUseId }),
      ...(c.depth !== undefined && { spawnDepth: c.depth }),
    });
  }
  const parent = fakeFile(`${sessionId}.jsonl`, parentLines);
  const result = await scanChicks(
    fakeProjectDir(sessionId, files, metas),
    `${sessionId}.jsonl`,
    `p${run}`,
    NOW,
    new Map(),
    parent.file,
  );
  const states = Object.fromEntries(result.map((c) => [c.view.name, c.view.state]));
  const reads = Object.fromEntries([...files].map(([name, f]) => [name.replace(/^agent-|\.jsonl$/g, ""), f.reads]));
  return { states, reads };
}

// A chick whose transcript ends on a tool_result (a sync chick that returned from its last tool): the tail alone keeps
// it working, so only a completion record makes it done
const endsOnToolResult = (at: number) => [agentCall(at - 1000, `own-${at}`, true), toolResult(at, `own-${at}`, true)];

describe("scanChicks: where a chick's completion record is", () => {
  const cases: {
    name: string;
    parent: object[];
    chicks: ChickSpec[];
    want: Record<string, string>;
  }[] = [
    {
      name: "the parent has the record (a chick the parent started)",
      parent: [agentCall(T0, "tu-a", false), toolResult(T0 + 60_000, "tu-a", false)],
      chicks: [{ id: "a", depth: 1, toolUseId: "tu-a", lines: endsOnToolResult(T0 + 59_000) }],
      want: { a: "dozing" },
    },
    {
      name: "the chick that started it has the record (a grandchild, sync)",
      parent: [agentCall(T0, "tu-a", false), toolResult(T0 + 600_000, "tu-a", false)],
      chicks: [
        { id: "a", depth: 1, toolUseId: "tu-a", lines: [agentCall(T0 + 1000, "tu-b", true), toolResult(T0 + 60_000, "tu-b", true), reply(T0 + 599_000, true)] },
        { id: "b", depth: 2, toolUseId: "tu-b", lines: endsOnToolResult(T0 + 59_000) },
      ],
      want: { a: "dozing", b: "dozing" },
    },
    {
      name: "the chick that started it has the record (a grandchild, async: task-notification)",
      parent: [agentCall(T0, "tu-a", false), toolResult(T0 + 600_000, "tu-a", false)],
      chicks: [
        { id: "a", depth: 1, toolUseId: "tu-a", lines: [agentCall(T0 + 1000, "tu-b", true), notification(T0 + 60_000, "b"), reply(T0 + 599_000, true)] },
        { id: "b", depth: 2, toolUseId: "tu-b", lines: endsOnToolResult(T0 + 59_000) },
      ],
      want: { a: "dozing", b: "dozing" },
    },
    {
      name: "no record anywhere: the grandchild is still working",
      parent: [agentCall(T0, "tu-a", false)],
      chicks: [
        { id: "a", depth: 1, toolUseId: "tu-a", lines: [agentCall(T0 + 1000, "tu-b", true)] },
        { id: "b", depth: 2, toolUseId: "tu-b", lines: endsOnToolResult(T0 + 59_000) },
      ],
      want: { a: "working", b: "working" },
    },
    {
      name: "a great-grandchild: the record is in the grandchild's transcript",
      parent: [agentCall(T0, "tu-a", false), toolResult(T0 + 900_000, "tu-a", false)],
      chicks: [
        { id: "a", depth: 1, toolUseId: "tu-a", lines: [agentCall(T0 + 1000, "tu-b", true), toolResult(T0 + 800_000, "tu-b", true), reply(T0 + 899_000, true)] },
        { id: "b", depth: 2, toolUseId: "tu-b", lines: [agentCall(T0 + 2000, "tu-c", true), toolResult(T0 + 60_000, "tu-c", true), reply(T0 + 799_000, true)] },
        { id: "c", depth: 3, toolUseId: "tu-c", lines: endsOnToolResult(T0 + 59_000) },
      ],
      want: { a: "dozing", b: "dozing", c: "dozing" },
    },
    {
      name: "older Claude Code without spawnDepth: the record is still found in the chick that started it",
      parent: [agentCall(T0, "tu-a", false), toolResult(T0 + 600_000, "tu-a", false)],
      chicks: [
        { id: "a", toolUseId: "tu-a", lines: [agentCall(T0 + 1000, "tu-b", true), toolResult(T0 + 60_000, "tu-b", true), reply(T0 + 599_000, true)] },
        { id: "b", toolUseId: "tu-b", lines: endsOnToolResult(T0 + 59_000) },
      ],
      want: { a: "dozing", b: "dozing" },
    },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      expect((await scan(c.parent, c.chicks)).states).toEqual(c.want);
    });
  }
});

describe("scanChicks: chick transcripts are read only when needed", () => {
  test("a chick the parent started that is still running: no chick transcript is read past its tail", async () => {
    const { reads } = await scan(
      [agentCall(T0, "tu-a", false)],
      [
        { id: "a", depth: 1, toolUseId: "tu-a", lines: endsOnToolResult(T0 + 59_000) },
        { id: "z", depth: 1, toolUseId: "tu-z", lines: endsOnToolResult(T0 + 59_000) },
      ],
    );
    // readTail reads each small file once; the ledger would read it a second time
    expect(reads).toEqual({ a: 1, z: 1 });
  });

  test("every chick has a record in the parent: no chick transcript is read past its tail", async () => {
    const { reads } = await scan(
      [toolResult(T0 + 60_000, "tu-a", false), toolResult(T0 + 60_000, "tu-b", false)],
      [
        { id: "a", depth: 1, toolUseId: "tu-a", lines: endsOnToolResult(T0 + 59_000) },
        { id: "b", depth: 2, toolUseId: "tu-b", lines: endsOnToolResult(T0 + 59_000) },
      ],
    );
    expect(reads).toEqual({ a: 1, b: 1 });
  });
});

describe("callerCandidates", () => {
  const cases: {
    name: string;
    chicks: { id: string; meta: { spawnDepth?: number }; resolved: boolean }[];
    want: string[];
  }[] = [
    { name: "nothing without a record", chicks: [{ id: "a", meta: { spawnDepth: 2 }, resolved: true }], want: [] },
    {
      name: "only depth-1 chicks without a record: their record can only be in the parent's",
      chicks: [
        { id: "a", meta: { spawnDepth: 1 }, resolved: false },
        { id: "b", meta: { spawnDepth: 1 }, resolved: true },
      ],
      want: [],
    },
    {
      name: "a depth-2 chick without a record: the depth-1 chicks",
      chicks: [
        { id: "a", meta: { spawnDepth: 1 }, resolved: true },
        { id: "b", meta: { spawnDepth: 2 }, resolved: false },
        { id: "c", meta: { spawnDepth: 2 }, resolved: true },
      ],
      want: ["a"],
    },
    {
      name: "a depth-3 chick without a record: the depth-2 chicks",
      chicks: [
        { id: "a", meta: { spawnDepth: 1 }, resolved: true },
        { id: "b", meta: { spawnDepth: 2 }, resolved: true },
        { id: "c", meta: { spawnDepth: 3 }, resolved: false },
      ],
      want: ["b"],
    },
    {
      name: "a chick without depth and without a record: every chick",
      chicks: [
        { id: "a", meta: {}, resolved: true },
        { id: "b", meta: {}, resolved: false },
      ],
      want: ["a", "b"],
    },
    {
      name: "a candidate without depth is kept, since it could be the one that started it",
      chicks: [
        { id: "a", meta: {}, resolved: true },
        { id: "b", meta: { spawnDepth: 2 }, resolved: false },
        { id: "c", meta: { spawnDepth: 3 }, resolved: true },
      ],
      want: ["a"],
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect([...callerCandidates(c.chicks)].sort()).toEqual(c.want);
    });
  }
});
