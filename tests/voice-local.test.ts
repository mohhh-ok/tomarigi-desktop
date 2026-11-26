// With a local TTS server chosen, every readout reaches ReadoutQueue, tagged by what it is for (docs/design.md
// "Readout voice (local TTS server)"): the request goes to Rust's tts_speech and the log line says which readout it was
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
mock.module("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    // The server is down: every utterance falls back to the system voice
    if (cmd === "tts_speech") throw "network: connection refused";
  },
}));

const g = globalThis as Record<string, unknown>;
g.location = { search: "" };
g.navigator = { language: "ja-JP" };
const spoken: string[] = [];
g.speechSynthesis = {
  speak: (u: { text: string; onend?: () => void }) => {
    spoken.push(u.text);
    setTimeout(() => u.onend?.(), 0);
  },
  cancel: () => {},
};
g.SpeechSynthesisUtterance = class {
  lang = "";
  volume = 1;
  onend?: () => void;
  onerror?: () => void;
  constructor(public text: string) {}
};

const { setReadoutVoice, speakSuggestions, speakEvent } = await import("../src/lib/voice.ts");

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  invoked.length = 0;
  spoken.length = 0;
});

afterAll(() => setReadoutVoice({ source: "system" }));

describe("readout through a local TTS server", () => {
  test("concierge suggestions are sent to the server and logged as for=concierge", async () => {
    setReadoutVoice({ source: "local", local: { kind: "voicevox", baseUrl: "http://localhost:50021", voice: "3" } });
    speakSuggestions([{ name: "app", text: "Review the diff" }]);
    await settle();
    expect(invoked.filter((c) => c.cmd === "tts_speech").map((c) => c.args.text)).toEqual(["app", "Review the diff"]);
    const lines = invoked.filter((c) => c.cmd === "log").map((c) => String(c.args.line));
    expect(lines).toEqual([
      '[readout] for=concierge session="app" text="Review the diff"',
      expect.stringMatching(/^\[voice\] for=concierge server=voicevox ms=\d+ used=system error=network$/),
      expect.stringMatching(/^\[voice\] for=concierge server=voicevox ms=\d+ used=system error=network$/),
    ]);
    // Read with the system voice instead, in order
    expect(spoken).toEqual(["app", "Review the diff"]);
  });

  test("needs reply is tagged waiting", async () => {
    setReadoutVoice({ source: "local", local: { kind: "voicevox", baseUrl: "http://localhost:50021", voice: "3" } });
    speakEvent({ key: "k", sessionId: "s", type: "waiting", project: "app", snippet: "Which layout?", at: 0 });
    await settle();
    const lines = invoked.filter((c) => c.cmd === "log").map((c) => String(c.args.line));
    expect(lines[0]).toBe('[readout] for=waiting session="app" text="Which layout?"');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((l) => l.startsWith("[voice] for=waiting "))).toBe(true);
  });
});
