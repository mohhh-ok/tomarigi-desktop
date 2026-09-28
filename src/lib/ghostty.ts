// Clicking a bird or row moves to the Ghostty pane where that Claude Code is running (not in the tomarigi Chrome extension;
// a feature added in the desktop version. docs/design.md "Jumping to the Ghostty pane").
// The mapping is done on the Rust side (focus_session): sessionId in <config>/sessions/<pid>.json → pid → tty from ps
// → Ghostty's `tty of terminal`. Anything that can't be mapped (Codex, ended sessions, mock) does nothing.
import { invoke } from "@tauri-apps/api/core";
import type { RootEntry } from "./fsa";

export interface FocusTarget {
  configDir: string; // ~/.claude etc. (parent of the watched folder <config>/projects)
  sessionId: string;
}

/**
 * Builds the target from SessionView.id / SessionEvent.sessionId / ChickView.id.
 * id is `<rootId>/<slug>/<sessionId>.jsonl` from lib/sessions.ts (chicks have `/<file name>` after it).
 * Chicks move to their parent's session.
 */
export function focusTargetOf(id: string, roots: RootEntry[]): FocusTarget | null {
  const [rootId, , file] = id.split("/");
  const root = roots.find((r) => r.id === rootId);
  if (!root || root.kind !== "claude" || !file?.endsWith(".jsonl")) return null;
  const projectsDir = root.path.replace(/\/+$/, "");
  const configDir = projectsDir.slice(0, projectsDir.lastIndexOf("/"));
  return { configDir, sessionId: file.slice(0, -".jsonl".length) };
}

export async function focusSession(id: string, roots: RootEntry[]): Promise<void> {
  const target = focusTargetOf(id, roots);
  if (!target) return;
  await invoke("focus_session", { ...target });
}
