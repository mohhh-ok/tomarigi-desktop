export const WINDOW_MODES = ["floating", "normal"] as const;
export type WindowMode = (typeof WINDOW_MODES)[number];
/** The same as WINDOW_MODE's start value in src-tauri/src/window.rs */
export const DEFAULT_WINDOW_MODE: WindowMode = "floating";
