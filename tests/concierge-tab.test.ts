// The Concierge tab (docs/design.md "Concierge"): first in the tab row, with or without a provider; without one it says
// what it needs and the readout stays per session; the label under the handle says how many other birds there are and how many need a reply, and
// the floating window shrinks to the concierge and its bubble
import { describe, expect, test } from "bun:test";
import type { SessionView } from "../src/lib/sessions.ts";
import {
  conciergeTabCounts,
  conciergeTabWindowSize,
  conciergeTabContent,
  conciergeWantsSuggestions,
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
  test("Concierge, Garden, Perch, Recent activity, in that order, with or without a provider", () => {
    expect(tabsShown()).toEqual(["concierge", "garden", "perch", "events"]);
  });
});

describe("what the Concierge tab shows", () => {
  const scenes: [string, { available: boolean; sessions: number }, string][] = [
    ["no provider, sessions on screen: what it needs", { available: false, sessions: 3 }, "setup"],
    ["no provider, no session: what it needs all the same", { available: false, sessions: 0 }, "setup"],
    ["a provider and sessions: the state lines and suggestions", { available: true, sessions: 3 }, "report"],
    ["a provider, no session: the Garden's empty message", { available: true, sessions: 0 }, "empty"],
  ];
  for (const [name, input, want] of scenes) {
    test(name, () => expect(conciergeTabContent(input)).toBe(want));
  }
});

describe("suggestions are asked for, and the tab's readout takes over, only in the tab with a provider", () => {
  const scenes: [string, Parameters<typeof conciergeWantsSuggestions>[0], boolean][] = [
    ["the tab open with a provider", { tab: "concierge", available: true }, true],
    ["the tab open without a provider: the per-session readout, as outside the tab", { tab: "concierge", available: false }, false],
    ["the Garden with a provider", { tab: "garden", available: true }, false],
    ["Perch without a provider", { tab: "perch", available: false }, false],
    ["Recent activity with a provider", { tab: "events", available: true }, false],
  ];
  for (const [name, input, want] of scenes) {
    test(name, () => expect(conciergeWantsSuggestions(input)).toBe(want));
  }
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
