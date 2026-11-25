// Window mode (floating / standard window; docs/design.md "Window and menu bar"). The Rust side (WindowMode in src-tauri/src/window.rs) is the source of truth and saves it;
// changes from the menu bar menu also arrive through the "window-mode" event.
// It's copied to <html data-window-mode>, which CSS (styles/base.css) and window dragging (App.tsx) look at.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { WindowMode } from "../lib/window-mode";

export type { WindowMode };

function apply(mode: WindowMode) {
  document.documentElement.dataset.windowMode = mode;
}

export function currentWindowMode(): WindowMode {
  return document.documentElement.dataset.windowMode === "normal" ? "normal" : "floating";
}

/** `applyToPage` false: the settings window shows the mode but is always a standard window itself, so its page
 * doesn't take the floating window's look */
export function useWindowMode(applyToPage = true): [WindowMode, (mode: WindowMode) => void] {
  const [mode, setMode] = useState<WindowMode>(currentWindowMode);
  useEffect(() => {
    const update = (m: WindowMode) => {
      if (applyToPage) apply(m);
      setMode(m);
    };
    void invoke<WindowMode>("get_window_mode").then(update, () => {});
    const unlisten = listen<WindowMode>("window-mode", (e) => update(e.payload));
    return () => void unlisten.then((f) => f(), () => {});
  }, [applyToPage]);
  // Change the look only once "window-mode" comes back from Rust (so they don't disagree when switching fails)
  return [mode, (m) => void invoke("set_window_mode", { mode: m })];
}
