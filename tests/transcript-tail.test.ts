// readTail's time basis (lastEventAt): lines Claude Code writes while the session sits idle must not make a finished
// session look like it just wrote something (docs/design.md "Bird states")
import { describe, expect, test } from "bun:test";
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
  timestamp: "2026-10-22T23:18:01.118Z",
  message: { content: [{ type: "text", text: "写真の候補が届いたら、すぐお見せします。" }] },
};

describe("readTail lastEventAt", () => {
  test("an away_summary line written minutes after the last reply doesn't move it", async () => {
    // The recap Claude Code writes while the user is away. Before, it made a finished session working for 6 seconds,
    // so its turn was summarized again and the concierge asked again
    const tail = await readTail(
      fileOf([
        reply,
        {
          type: "system",
          subtype: "away_summary",
          timestamp: "2026-10-22T23:21:04.559Z",
          content: "候補が届いたら、1 枚選んでいただきます。",
        },
      ]),
    );
    expect(tail.kind).toBe("assistant_text");
    expect(tail.lastEventAt).toBe(Date.parse("2026-10-22T23:18:01.118Z"));
  });

  test("other lines without a turn still count, as before", async () => {
    const tail = await readTail(
      fileOf([
        reply,
        { type: "system", subtype: "turn_duration", timestamp: "2026-10-22T23:18:02.000Z" },
        { type: "queue-operation", operation: "enqueue", timestamp: "2026-10-22T23:19:00.000Z", content: "x" },
      ]),
    );
    expect(tail.lastEventAt).toBe(Date.parse("2026-10-22T23:19:00.000Z"));
  });
});
