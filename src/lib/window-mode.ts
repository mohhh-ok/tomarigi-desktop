export const WINDOW_MODES = ["floating", "normal"] as const;
export type WindowMode = (typeof WINDOW_MODES)[number];
