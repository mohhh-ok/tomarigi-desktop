// Closing the label edit of a watched folder (docs/design.md "Clarity of the settings window"): only the first close
// counts, and Cancel / Esc never save, even when a blur follows
import { describe, expect, test } from "bun:test";
import { finishEdit, type EditSession } from "../src/perch/settings/edit-session.ts";

const open = (): EditSession => ({ current: { id: "r1", draft: "typed" } });

describe("finishEdit", () => {
  test("saving returns the edit once", () => {
    const s = open();
    expect(finishEdit(s, true)).toEqual({ id: "r1", draft: "typed" });
    expect(finishEdit(s, true)).toBeNull();
  });

  test("canceling saves nothing, and the blur that follows (a save request) saves nothing either", () => {
    const s = open();
    expect(finishEdit(s, false)).toBeNull();
    expect(finishEdit(s, true)).toBeNull();
  });

  test("Enter followed by a blur saves once", () => {
    const s = open();
    expect(finishEdit(s, true)).not.toBeNull();
    expect(finishEdit(s, true)).toBeNull();
  });

  test("with no edit open nothing is saved", () => {
    expect(finishEdit({ current: null }, true)).toBeNull();
  });
});
