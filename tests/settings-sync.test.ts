import { describe, expect, test } from "bun:test";
import { wantsReload } from "../src/lib/settings-sync.ts";

describe("wantsReload (docs/design.md \"Settings window\")", () => {
  test("a key this window shows, saved by another window, is reloaded", () => {
    expect(wantsReload({ key: "muted", from: "main" }, ["muted", "chirpVolume"], "settings")).toBe(true);
  });

  test("its own save isn't reloaded, so a slider being dragged isn't pulled back", () => {
    expect(wantsReload({ key: "chirpVolume", from: "settings" }, ["chirpVolume"], "settings")).toBe(false);
  });

  test("keys the window doesn't show are ignored", () => {
    expect(wantsReload({ key: "eventLog", from: "main" }, ["muted"], "settings")).toBe(false);
  });
});
