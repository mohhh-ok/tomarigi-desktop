// What the voice reads while the Concierge tab is open (docs/design.md "Readout in the Concierge tab"). Each scene feeds
// the app's own ConciergeReadout the same calls use-concierge.ts and App.tsx make, in order, and checks what is read
import { describe, expect, test } from "bun:test";
import type { ConciergeSuggestion } from "../src/lib/concierge.ts";
import { ConciergeReadout, newSuggestions } from "../src/lib/concierge-readout.ts";
import type { SessionEvent } from "../src/lib/session-types.ts";

const sug = (sessionId: string, kind: ConciergeSuggestion["kind"], text = `${kind} ${sessionId}`): ConciergeSuggestion => ({
  sessionId,
  kind,
  text,
});
const ev = (type: SessionEvent["type"], sessionId: string): SessionEvent => ({
  key: `${type}:${sessionId}`,
  sessionId,
  project: sessionId,
  type,
  at: 0,
});

/** One call into the readout, as the app makes it */
type Step =
  | { open: ConciergeSuggestion[]; asking: boolean }
  | { close: true }
  | { event: SessionEvent }
  | { answer: ConciergeSuggestion[] }
  | { fail: true }
  | { clear: true };

/** Runs the steps and returns, in order, what each one says: events routed, suggestions read, held events read */
function run(steps: Step[]): string[] {
  const r = new ConciergeReadout();
  const out: string[] = [];
  for (const step of steps) {
    if ("open" in step) r.opened(step.open, step.asking);
    else if ("close" in step) r.closed();
    else if ("event" in step) out.push(`${step.event.type} ${step.event.sessionId}: ${r.event(step.event)}`);
    else if ("answer" in step) for (const s of r.answered(step.answer)) out.push(`read ${s.sessionId} ${s.text}`);
    else if ("fail" in step) for (const e of r.failed()) out.push(`read ${e.type} ${e.sessionId}`);
    else r.cleared();
  }
  return out;
}

describe("newSuggestions", () => {
  const cases: [string, ConciergeSuggestion[], ConciergeSuggestion[], string[]][] = [
    ["none before: all are new, in order", [], [sug("b", "reply"), sug("a", "check_result")], ["b", "a"]],
    ["the same session and kind with other text is not new", [sug("a", "reply", "old")], [sug("a", "reply", "new")], []],
    ["the same session with another kind is new", [sug("a", "reply")], [sug("a", "check_result")], ["a"]],
    ["only the new one of several", [sug("a", "reply")], [sug("a", "reply"), sug("b", "reply")], ["b"]],
    ["none now", [sug("a", "reply")], [], []],
  ];
  for (const [name, prev, next, want] of cases) {
    test(name, () => expect(newSuggestions(prev, next).map((s) => s.sessionId)).toEqual(want));
  }
});

describe("ConciergeReadout", () => {
  const cases: [string, Step[], string[]][] = [
    [
      "outside the tab, done and needs reply are read as before; started and closed are not read",
      [{ event: ev("done", "a") }, { event: ev("waiting", "b") }, { event: ev("started", "c") }, { event: ev("closed", "c") }],
      ["done a: speak", "waiting b: speak", "started c: skip", "closed c: skip"],
    ],
    [
      "in the tab, done and needs reply are held, and an answer reads only new suggestions",
      [
        { open: [sug("a", "reply")], asking: false },
        { event: ev("done", "b") },
        { answer: [sug("a", "reply", "answer a again"), sug("b", "check_result", "look at b")] },
      ],
      ["done b: held", "read b look at b"],
    ],
    [
      "the suggestions shown on opening are taken as seen",
      [{ open: [sug("a", "reply")], asking: false }, { answer: [sug("a", "reply")] }],
      [],
    ],
    [
      "the answer to the request opening asked is taken as seen; the next one is compared",
      [
        { open: [], asking: true },
        { answer: [sug("a", "reply")] },
        { answer: [sug("a", "reply"), sug("b", "reply")] },
      ],
      ["read b reply b"],
    ],
    [
      "opening asked nothing: the first answer is compared with what was shown",
      [{ open: [], asking: false }, { answer: [sug("a", "reply")] }],
      ["read a reply a"],
    ],
    [
      "a suggestion that went away and came back is read again",
      [
        { open: [], asking: false },
        { answer: [sug("a", "reply")] },
        { answer: [] },
        { answer: [sug("a", "reply")] },
      ],
      ["read a reply a", "read a reply a"],
    ],
    [
      "several new suggestions are read in the order shown",
      [{ open: [], asking: false }, { answer: [sug("c", "reply"), sug("a", "reply"), sug("b", "check_result")] }],
      ["read c reply c", "read a reply a", "read b check_result b"],
    ],
    [
      "a failed request reads the held events as outside the tab, once",
      [
        { open: [], asking: false },
        { event: ev("done", "a") },
        { event: ev("waiting", "b") },
        { fail: true },
        { fail: true },
      ],
      ["done a: held", "waiting b: held", "read done a", "read waiting b"],
    ],
    [
      "an answer drops the held events, with or without a new suggestion for them",
      [
        { open: [sug("a", "check_result")], asking: false },
        { event: ev("done", "a") },
        { answer: [sug("a", "check_result")] },
        { fail: true },
      ],
      ["done a: held"],
    ],
    [
      "a failure keeps the answer before as the one to compare with",
      [
        { open: [sug("a", "reply")], asking: false },
        { fail: true },
        { answer: [sug("a", "reply"), sug("b", "reply")] },
      ],
      ["read b reply b"],
    ],
    [
      "the request opening asked fails: its held events are read, and the next answer is compared with what was shown",
      [
        { open: [sug("a", "reply")], asking: true },
        { event: ev("waiting", "b") },
        { fail: true },
        { answer: [sug("a", "reply"), sug("b", "reply")] },
      ],
      ["waiting b: held", "read waiting b", "read b reply b"],
    ],
    [
      "leaving the tab drops the held events; events after it are read as before",
      [
        { open: [], asking: false },
        { event: ev("done", "a") },
        { close: true },
        { fail: true },
        { event: ev("done", "b") },
      ],
      ["done a: held", "done b: speak"],
    ],
    [
      "answers that come after leaving the tab read nothing",
      [{ open: [], asking: false }, { close: true }, { answer: [sug("a", "reply")] }],
      [],
    ],
    [
      "the suggestions going away (nothing to do) drops the held events, and one that comes back is new",
      [
        { open: [sug("a", "reply")], asking: false },
        { event: ev("done", "b") },
        { clear: true },
        { fail: true },
        { answer: [sug("a", "reply")] },
      ],
      ["done b: held", "read a reply a"],
    ],
    [
      "opening again takes the suggestions shown then as seen",
      [
        { open: [], asking: false },
        { close: true },
        { open: [sug("a", "reply")], asking: false },
        { answer: [sug("a", "reply")] },
      ],
      [],
    ],
  ];
  for (const [name, steps, want] of cases) {
    test(name, () => expect(run(steps)).toEqual(want));
  }
});
