// 窓のモード(浮遊窓 / 通常の窓。docs/design.md)。正は Rust 側(src-tauri/src/lib.rs の WindowMode)が保存して持ち、
// メニューバーのメニューから変えたときも "window-mode" イベントで届く。
// <html data-window-mode> に写して、CSS(perch.css)と窓のドラッグ(App.tsx)が見る。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export type WindowMode = "floating" | "normal";

function apply(mode: WindowMode) {
  document.documentElement.dataset.windowMode = mode;
}

export function currentWindowMode(): WindowMode {
  return document.documentElement.dataset.windowMode === "normal" ? "normal" : "floating";
}

export function useWindowMode(): [WindowMode, (mode: WindowMode) => void] {
  const [mode, setMode] = useState<WindowMode>(currentWindowMode);
  useEffect(() => {
    const update = (m: WindowMode) => {
      apply(m);
      setMode(m);
    };
    void invoke<WindowMode>("get_window_mode").then(update);
    const unlisten = listen<WindowMode>("window-mode", (e) => update(e.payload));
    return () => void unlisten.then((f) => f());
  }, []);
  // 見た目は Rust から "window-mode" が返ってきた時点で変える(切り替えに失敗したときに食い違わないように)
  return [mode, (m) => void invoke("set_window_mode", { mode: m })];
}
