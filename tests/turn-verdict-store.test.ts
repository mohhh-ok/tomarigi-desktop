// One verdict per turn, kept across a reload and a restart (docs/design.md "Turn verdicts"). The reported case: the
// same reply was asked about on three reloads and answered asking, asking, then not asking, and the last answer won
import { describe, expect, test } from "bun:test";
import type { TurnOutcome } from "../src/lib/summarize.ts";
import {
  keepTurnVerdict,
  keptAnger,
  MAX_KEPT_TURN_VERDICTS,
  newerAnger,
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

// A kept turn isn't asked again, so after a reload or a restart the anger mark comes from the kept answers
// (docs/design.md "Anger mark for abuse toward the AI": it stays until the next turn's verdict)
describe("anger mark from kept verdicts", () => {
  const abusive: TurnOutcome = { ...notAsking, abusive: true };

  test("the latest kept turn of the session decides, whatever order they were kept in", () => {
    const list: KeptTurnVerdicts = [
      ["s:300", abusive],
      ["s:100", notAsking],
      ["other:400", notAsking],
    ];
    expect(keptAnger(list, "s")).toEqual({ at: 300, angry: true });
    expect(keptAnger([...list, ["s:500", notAsking]], "s")).toEqual({ at: 500, angry: false });
  });

  test("turns of another session, or a session whose id starts the same, don't count", () => {
    const list: KeptTurnVerdicts = [["s:x:200", abusive], ["sx:300", abusive]];
    expect(keptAnger(list, "s")).toBeUndefined();
    expect(keptAnger(list, "s:x")).toEqual({ at: 200, angry: true });
  });

  test("a verdict without abusive leaves the earlier turn's mark", () => {
    const { abusive: _, ...noAbusive } = notAsking;
    const list: KeptTurnVerdicts = [["s:100", abusive], ["s:200", noAbusive]];
    expect(keptAnger(list, "s")).toEqual({ at: 100, angry: true });
  });

  test("the newer of the kept and the just answered turn is shown", () => {
    const kept = { at: 100, angry: true };
    expect(newerAnger(kept, { at: 200, angry: false })).toEqual({ at: 200, angry: false });
    expect(newerAnger({ at: 300, angry: true }, { at: 200, angry: false })).toEqual({ at: 300, angry: true });
    expect(newerAnger(undefined, kept)).toEqual(kept);
    expect(newerAnger(kept, undefined)).toEqual(kept);
  });
});
