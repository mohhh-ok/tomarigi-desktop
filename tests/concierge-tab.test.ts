// The Concierge tab (docs/design.md "Concierge"): first in the tab row while the concierge is shown, the Garden in its
// place once it isn't, the label under the handle says how many other birds there are and how many need a reply, and
// the floating window shrinks to the concierge and its bubble
import { describe, expect, test } from "bun:test";
import type { SessionView } from "../src/lib/sessions.ts";
import {
  conciergeTabCounts,
  conciergeTabWindowSize,
  tabAfter,
  tabOf,
  tabsShown,
} from "../src/perch/concierge-tab.ts";

const bird = (id: string, patch: Partial<SessionView> = {}): SessionView => ({
  id,
  project: id,
  slug: id,
  state: "working",
  sinceMs: 1000,
  ...patch,
});

describe("the tab row", () => {
  test("Concierge, Garden, Perch, Recent activity, in that order, with the concierge shown", () => {
    expect(tabsShown(true)).toEqual(["concierge", "garden", "perch", "events"]);
  });

  test("without the concierge (no key, no Local): no Concierge tab", () => {
    expect(tabsShown(false)).toEqual(["garden", "perch", "events"]);
  });
});

describe("the Concierge tab goes when the concierge stops being shown", () => {
  test("a key deleted while it is open opens the Garden", () => {
    expect(tabAfter({ tab: "concierge", available: false, loaded: true })).toBe("garden");
  });

  test("stays while the concierge is shown", () => {
    expect(tabAfter({ tab: "concierge", available: true, loaded: true })).toBe("concierge");
  });

  test("not before the settings are loaded (the key isn't known yet at launch)", () => {
    expect(tabAfter({ tab: "concierge", available: false, loaded: false })).toBe("concierge");
  });

  test("the other tabs don't depend on it", () => {
    expect(tabAfter({ tab: "perch", available: false, loaded: true })).toBe("perch");
  });
});

describe("the saved tab", () => {
  test("read back as a tab; anything else isn't one", () => {
    expect(tabOf("concierge")).toBe("concierge");
    expect(tabOf("events")).toBe("events");
    expect(tabOf(true)).toBeUndefined();
    expect(tabOf("settings")).toBeUndefined();
    expect(tabOf(undefined)).toBeUndefined();
  });
});

describe("the other birds on the label under the handle", () => {
  test("counts every bird and the ones that need a reply", () => {
    const sessions = [
      bird("a", { state: "waiting" }),
      bird("b"),
      bird("c", { state: "done", ask: { status: "asking" } as SessionView["ask"] }),
      bird("d", { state: "done" }),
      bird("e", { state: "dozing" }),
    ];
    expect(conciergeTabCounts(sessions)).toEqual({ others: 5, waiting: 2 });
  });

  test("none", () => {
    expect(conciergeTabCounts([])).toEqual({ others: 0, waiting: 0 });
  });
});

describe("the floating window's size while the tab is open", () => {
  // A 340x480 window whose garden is 312x380: 28px around it across, 100px above and below
  const window = { innerW: 340, innerH: 480, gardenW: 312, gardenH: 380 };

  test("the window's room around the garden, plus what the concierge and its bubble need", () => {
    expect(conciergeTabWindowSize({ ...window, contentW: 196, contentH: 150, handleW: 200 })).toEqual({
      width: 224,
      height: 250,
    });
  });

  test("wide enough for the handle's row", () => {
    expect(conciergeTabWindowSize({ ...window, contentW: 196, contentH: 150, handleW: 300 })).toEqual({
      width: 300,
      height: 250,
    });
  });

  test("a longer bubble makes it taller", () => {
    const short = conciergeTabWindowSize({ ...window, contentW: 196, contentH: 150, handleW: 200 });
    const long = conciergeTabWindowSize({ ...window, contentW: 196, contentH: 220, handleW: 200 });
    expect(long.height - short.height).toBe(70);
  });

  test("whole px, rounded up so nothing is cut", () => {
    expect(conciergeTabWindowSize({ ...window, contentW: 196.2, contentH: 150.4, handleW: 200 })).toEqual({
      width: 225,
      height: 251,
    });
  });
});
