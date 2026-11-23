// One verdict per turn, kept across a reload and a restart (docs/design.md "Turn verdicts"). The reported case: the
// same reply was asked about on three reloads and answered asking, asking, then not asking, and the last answer won
import { describe, expect, test } from "bun:test";
import type { TurnOutcome } from "../src/lib/summarize.ts";
import {
  keepTurnVerdict,
  MAX_KEPT_TURN_VERDICTS,
  parseKeptTurnVerdicts,
  shouldAskTurn,
  type KeptTurnVerdicts,
} from "../src/lib/turn-verdict-store.ts";

const asking: TurnOutcome = { line: "URL を開いて許可", ask: { status: "asking" }, abusive: false, continuing: true };
const notAsking: TurnOutcome = { line: "許可を待っている", ask: { status: "not_asking" }, abusive: false, continuing: true };

describe("kept turn verdicts", () => {
  test("a turn keeps its first answer when it is answered again", () => {
    let list: KeptTurnVerdicts = [];
    list = keepTurnVerdict(list, "s:1", asking);
    list = keepTurnVerdict(list, "s:1", asking);
    list = keepTurnVerdict(list, "s:1", notAsking);
    expect(list).toEqual([["s:1", asking]]);
  });

  test("what was saved comes back after a reload as it was", () => {
    const list = keepTurnVerdict(keepTurnVerdict([], "a:1", asking), "b:2", notAsking);
    expect(parseKeptTurnVerdicts(JSON.parse(JSON.stringify(list)))).toEqual(list);
  });

  test("past the limit the oldest turns go first", () => {
    let list: KeptTurnVerdicts = [];
    for (let i = 0; i < MAX_KEPT_TURN_VERDICTS + 5; i++) list = keepTurnVerdict(list, `s:${i}`, asking);
    expect(list.length).toBe(MAX_KEPT_TURN_VERDICTS);
    expect(list[0][0]).toBe("s:5");
  });

  test("a saved value that isn't a list of answered verdicts is dropped", () => {
    expect(parseKeptTurnVerdicts(undefined)).toEqual([]);
    expect(parseKeptTurnVerdicts({ "s:1": asking })).toEqual([]);
    expect(
      parseKeptTurnVerdicts([
        ["s:1", { ask: { status: "pending" } }],
        ["s:2", { ask: { status: "error" } }],
        [3, asking],
        ["s:4", asking],
      ]),
    ).toEqual([["s:4", asking]]);
  });

  test("after a reload a turn with a kept answer isn't asked again, and nothing is asked before they are loaded", () => {
    const kept: KeptTurnVerdicts = [["s:1", asking]];
    expect(shouldAskTurn("s:1", true, new Set(), kept)).toBe(false);
    expect(shouldAskTurn("s:2", true, new Set(), kept)).toBe(true);
    expect(shouldAskTurn("s:2", true, new Set(), null)).toBe(false);
    expect(shouldAskTurn("s:2", true, new Set(["s:2"]), kept)).toBe(false);
    expect(shouldAskTurn("s:2", false, new Set(), kept)).toBe(false);
  });
});
