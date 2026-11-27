import { describe, expect, test } from "bun:test";
import { FROM_SETTINGS_FILE, wantsReload } from "../src/lib/settings-sync.ts";

describe("wantsReload (docs/design/settings-window.md \"Settings window\")", () => {
  test("a key this window shows, saved by another window, is reloaded", () => {
    expect(wantsReload({ key: "muted", from: "main" }, ["muted", "chirpVolume"], "settings")).toBe(true);
  });

  test("its own save isn't reloaded, so a slider being dragged isn't pulled back", () => {
    expect(wantsReload({ key: "chirpVolume", from: "settings" }, ["chirpVolume"], "settings")).toBe(false);
  });

  test("an edit of the settings file is reloaded by every window, the one that applied it included", () => {
    expect(wantsReload({ key: "muted", from: FROM_SETTINGS_FILE }, ["muted"], "main")).toBe(true);
    expect(wantsReload({ key: "muted", from: FROM_SETTINGS_FILE }, ["muted"], "settings")).toBe(true);
  });

  test("keys the window doesn't show are ignored", () => {
    expect(wantsReload({ key: "eventLog", from: "main" }, ["muted"], "settings")).toBe(false);
  });
});
