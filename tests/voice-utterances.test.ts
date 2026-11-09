// What the voice queues for each readout: the display name, then the body, as two utterances, and no utterance for a
// text that is empty after sanitizing (docs/design.md "Readout in the Concierge tab")
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isReadAloudType, speakEvent, speakSuggestions } from "../src/lib/voice.ts";
import type { SessionEvent } from "../src/lib/session-types.ts";

const g = globalThis as Record<string, unknown>;
const spoken: string[] = [];

beforeEach(() => {
  g.location = { search: "" };
  g.speechSynthesis = { speak: (u: { text: string }) => spoken.push(u.text), cancel: () => {} };
  g.SpeechSynthesisUtterance = class {
    lang = "";
    volume = 1;
    constructor(public text: string) {}
  };
});

afterEach(() => {
  spoken.length = 0;
  delete g.location;
  delete g.speechSynthesis;
  delete g.SpeechSynthesisUtterance;
});

function event(over: Partial<SessionEvent>): SessionEvent {
  return { type: "done", project: "app", ...over } as SessionEvent;
}

describe("isReadAloudType", () => {
  test("done and needs reply are read, started and closed are not", () => {
    expect(["done", "waiting", "started", "closed"].map((t) => isReadAloudType(t as SessionEvent["type"]))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("speakSuggestions", () => {
  test("reads each suggestion as its name, then its text, in the order given", () => {
    speakSuggestions([
      { name: "app", text: "Review the diff" },
      { name: "site", text: "Answer the question" },
    ]);
    expect(spoken).toEqual(["app", "Review the diff", "site", "Answer the question"]);
  });

  test("a text that is empty after sanitizing is not queued", () => {
    speakSuggestions([{ name: "app", text: "``" }]);
    expect(spoken).toEqual(["app"]);
  });
});

describe("speakEvent done", () => {
  test("reads the project name, then the snippet", () => {
    speakEvent(event({ snippet: "fix the bug" }));
    expect(spoken).toEqual(["app", "fix the bug"]);
  });

  test("a project name that is empty after sanitizing is not queued", () => {
    speakEvent(event({ project: "…", snippet: "fix the bug" }));
    expect(spoken).toEqual(["fix the bug"]);
  });
});
