// The menu bar menu's "Read aloud" item and the settings' checkbox show the same value (docs/design.md "Window and
// menu bar"): the settings report their value to Rust, and a click on the menu item comes back as the new value
import { afterEach, describe, expect, mock, test } from "bun:test";

const invoked: { cmd: string; args: unknown }[] = [];
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    invoked.push({ cmd, args });
  },
}));

const listeners = new Map<string, (e: { payload: unknown }) => void>();
mock.module("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  },
}));

const { listenVoiceMenu, reportVoiceMenu } = await import("../src/perch/voice-menu.ts");

const g = globalThis as Record<string, unknown>;

function withSpeech(available: boolean) {
  if (available) g.speechSynthesis = {};
  else delete g.speechSynthesis;
  g.location = { search: "" };
}

afterEach(() => {
  invoked.length = 0;
  delete g.speechSynthesis;
  delete g.location;
});

describe("reportVoiceMenu", () => {
  test("puts the saved value on the menu item", () => {
    withSpeech(true);
    reportVoiceMenu(true);
    reportVoiceMenu(false);
    expect(invoked).toEqual([
      { cmd: "set_voice_menu", args: { checked: true, available: true } },
      { cmd: "set_voice_menu", args: { checked: false, available: true } },
    ]);
  });

  test("without a speech engine the item is disabled and unchecked, as the settings checkbox is", () => {
    withSpeech(false);
    reportVoiceMenu(true);
    expect(invoked).toEqual([{ cmd: "set_voice_menu", args: { checked: false, available: false } }]);
  });
});

describe("listenVoiceMenu", () => {
  test("a click on the menu item hands its new value to the settings", async () => {
    const got: boolean[] = [];
    const unlisten = listenVoiceMenu((on) => got.push(on));
    await Promise.resolve();
    listeners.get("voice-enabled")?.({ payload: true });
    listeners.get("voice-enabled")?.({ payload: false });
    expect(got).toEqual([true, false]);
    unlisten();
    await Promise.resolve();
    expect(listeners.has("voice-enabled")).toBe(false);
  });
});
