// "Concierge only" mode (docs/design.md "Concierge"; issue #6): the Garden shows only the concierge, the right-click
// menu has a check item for it, the handle says how many birds are hidden and how many need a reply, and the floating
// window shrinks to the concierge and its bubble
import { describe, expect, test } from "bun:test";
import type { SessionView } from "../src/lib/sessions.ts";
import {
  conciergeOnlyAfter,
  conciergeOnlyCounts,
  conciergeOnlyEntryShown,
  conciergeOnlyWindowSize,
  gardenMenuModel,
} from "../src/perch/concierge-only.ts";

const bird = (id: string, patch: Partial<SessionView> = {}): SessionView => ({
  id,
  project: id,
  slug: id,
  state: "working",
  sinceMs: 1000,
  ...patch,
});

describe("hidden birds on the handle's label", () => {
  test("counts every bird and the ones that need a reply", () => {
    const sessions = [
      bird("a", { state: "waiting" }),
      bird("b"),
      bird("c", { state: "done", ask: { status: "asking" } as SessionView["ask"] }),
      bird("d", { state: "done" }),
      bird("e", { state: "dozing" }),
    ];
    expect(conciergeOnlyCounts(sessions)).toEqual({ hidden: 5, waiting: 2 });
  });

  test("none", () => {
    expect(conciergeOnlyCounts([])).toEqual({ hidden: 0, waiting: 0 });
  });
});

describe("the Garden's right-click menu", () => {
  test("without the concierge: only Arrange", () => {
    expect(gardenMenuModel({ conciergeAvailable: false, conciergeOnly: false })).toEqual({
      arrangeEnabled: true,
      conciergeOnly: undefined,
    });
  });

  test("with the concierge: Concierge only below Arrange, checked while on, and Arrange disabled then", () => {
    expect(gardenMenuModel({ conciergeAvailable: true, conciergeOnly: false })).toEqual({
      arrangeEnabled: true,
      conciergeOnly: { checked: false },
    });
    expect(gardenMenuModel({ conciergeAvailable: true, conciergeOnly: true })).toEqual({
      arrangeEnabled: false,
      conciergeOnly: { checked: true },
    });
  });
});

describe("the mode turns off when the concierge stops being shown", () => {
  test("a key deleted while on turns it off", () => {
    expect(conciergeOnlyAfter({ on: true, available: false, loaded: true })).toBe(false);
  });

  test("stays on while the concierge is shown", () => {
    expect(conciergeOnlyAfter({ on: true, available: true, loaded: true })).toBe(true);
  });

  test("not turned off before the settings are loaded (the key isn't known yet at launch)", () => {
    expect(conciergeOnlyAfter({ on: true, available: false, loaded: false })).toBe(true);
  });

  test("off stays off", () => {
    expect(conciergeOnlyAfter({ on: false, available: true, loaded: true })).toBe(false);
  });
});

describe("the floating window's size while on", () => {
  // A 340x480 window whose garden is 312x380: 28px around it across, 100px above and below
  const window = { innerW: 340, innerH: 480, gardenW: 312, gardenH: 380 };

  test("the window's room around the garden, plus what the concierge and its bubble need", () => {
    expect(conciergeOnlyWindowSize({ ...window, contentW: 196, contentH: 150, handleW: 200 })).toEqual({
      width: 224,
      height: 250,
    });
  });

  test("wide enough for the handle and its label", () => {
    expect(conciergeOnlyWindowSize({ ...window, contentW: 196, contentH: 150, handleW: 300 })).toEqual({
      width: 300,
      height: 250,
    });
  });

  test("a longer bubble makes it taller", () => {
    const short = conciergeOnlyWindowSize({ ...window, contentW: 196, contentH: 150, handleW: 200 });
    const long = conciergeOnlyWindowSize({ ...window, contentW: 196, contentH: 220, handleW: 200 });
    expect(long.height - short.height).toBe(70);
  });

  test("whole px, rounded up so nothing is cut", () => {
    expect(conciergeOnlyWindowSize({ ...window, contentW: 196.2, contentH: 150.4, handleW: 200 })).toEqual({
      width: 225,
      height: 251,
    });
  });
});

describe("the header's button into the mode, the counterpart of \"Show all\"", () => {
  const base = { conciergeAvailable: true, conciergeOnly: false, onGarden: true, overlay: false };

  test("shown on the Garden while the concierge is shown and the mode is off", () => {
    expect(conciergeOnlyEntryShown(base)).toBe(true);
  });

  test("not without the concierge, while on, on another tab, or with settings or the debug log open", () => {
    expect(conciergeOnlyEntryShown({ ...base, conciergeAvailable: false })).toBe(false);
    expect(conciergeOnlyEntryShown({ ...base, conciergeOnly: true })).toBe(false);
    expect(conciergeOnlyEntryShown({ ...base, onGarden: false })).toBe(false);
    expect(conciergeOnlyEntryShown({ ...base, overlay: true })).toBe(false);
  });
});
