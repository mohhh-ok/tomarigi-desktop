// A turn Claude Code marked as over (`system` / `turn_duration` last) is done at once, not working for 6 seconds after
// its last write (docs/design.md "Bird states"). The reported case: a child ended its turn asking the user, the app
// still showed it working for 6 seconds, and the concierge was asked during them with the session working
import { describe, expect, test } from "bun:test";
import { deriveState } from "../src/lib/bird-state.ts";
import type { NativeFile } from "../src/lib/native-fs.ts";
import { readTail } from "../src/lib/transcript.ts";

function fileOf(lines: object[]): NativeFile {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const bytes = new TextEncoder().encode(text);
  return {
    path: "/tmp/t.jsonl",
    name: "t.jsonl",
    size: bytes.length,
    lastModified: 0,
    slice: (start = 0, end = bytes.length) => ({
      text: async () => new TextDecoder().decode(bytes.slice(start < 0 ? bytes.length + start : start, end)),
    }),
  } as unknown as NativeFile;
}

const reply = {
  type: "assistant",
  timestamp: "2026-11-23T00:51:50.853Z",
  message: { content: [{ type: "text", text: "手元のターミナルでコマンドを打ち、パスワードを入れてください。" }] },
};
const hook = { type: "system", subtype: "stop_hook_summary", timestamp: "2026-11-23T00:51:51.451Z" };
const end = { type: "system", subtype: "turn_duration", timestamp: "2026-11-23T00:51:51.453Z" };
const stateAfter = async (lines: object[], ms: number) => {
  const tail = await readTail(fileOf(lines));
  return deriveState(tail, ms, false);
};

describe("a turn marked as over", () => {
  test("is done one second after its last write (it was working for 6 seconds)", async () => {
    expect(await stateAfter([reply, hook, end], 1_000)).toBe("done");
    expect(await stateAfter([reply, hook, end], 4_000)).toBe("done");
  });

  test("without the end line, a reply written a second ago is still working", async () => {
    expect(await stateAfter([reply, hook], 1_000)).toBe("working");
    expect(await stateAfter([reply], 1_000)).toBe("working");
  });

  test("the next prompt after it is working again", async () => {
    const prompt = { type: "user", timestamp: "2026-11-23T00:52:50.000Z", origin: { kind: "human" }, message: { content: "打ちました" } };
    expect(await stateAfter([reply, hook, end, prompt], 1_000)).toBe("working");
  });

  test("another session's message or a queued one after it is a write again, so the 6 seconds hold", async () => {
    const peer = {
      type: "user",
      isMeta: true,
      timestamp: "2026-11-23T00:52:00.000Z",
      origin: { kind: "peer", name: "hub-1" },
      message: { content: "Another Claude session sent a message: …" },
    };
    const queued = { type: "queue-operation", operation: "enqueue", timestamp: "2026-11-23T00:52:00.000Z", content: "x" };
    expect(await stateAfter([reply, hook, end, peer], 1_000)).toBe("working");
    expect(await stateAfter([reply, hook, end, queued], 1_000)).toBe("working");
  });

  test("the away recap after it doesn't undo it", async () => {
    const away = { type: "system", subtype: "away_summary", timestamp: "2026-11-23T00:55:00.000Z", content: "x" };
    const tail = await readTail(fileOf([reply, hook, end, away]));
    expect(tail.turnEnded).toBe(true);
  });
});
