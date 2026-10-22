// The menu bar menu's "Read aloud" item (docs/design.md "Window and menu bar"). The setting stays in IndexedDB
// (voiceEnabled in lib/settings-store.ts); the settings report it to Rust (tray.rs set_voice_menu), which checks the
// item, and a click on the item comes back as the "voice-enabled" event with the new value
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { speechAvailable } from "@/lib/voice";

/** Puts the readout setting on the menu item. Without a speech engine the item is disabled and unchecked, as the
 * settings checkbox is */
export function reportVoiceMenu(enabled: boolean): void {
  const available = speechAvailable();
  void invoke("set_voice_menu", { checked: enabled && available, available }).catch(() => {});
}

/** Calls apply with the new value when the menu item is clicked. Returns the function that stops listening */
export function listenVoiceMenu(apply: (enabled: boolean) => void): () => void {
  const unlisten = listen<boolean>("voice-enabled", (e) => apply(e.payload));
  return () => void unlisten.then((f) => f());
}
