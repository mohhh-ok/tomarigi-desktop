// Clicking a bird or row moves to the Ghostty pane where that claude / codex is running (not in the tomarigi Chrome
// extension; a feature added in the desktop version. docs/design.md "Jumping to the Ghostty pane").
// The mapping is done on the Rust side: session → pid → tty from ps → Ghostty's `tty of terminal`. The pid comes from
// sessionId in <config>/sessions/<pid>.json for Claude Code (focus_session), and from the process that has
// thread-writer-locks/<threadId>.lock open for Codex (focus_codex). Anything that can't be mapped (ended sessions,
// mock) does nothing.
import { invoke } from "@tauri-apps/api/core";
import type { RootEntry } from "./fsa";
import { codexDirOf, codexThreadIdOf, configDirOf, predecessorsOf } from "./sessions";

type FocusTarget =
  | {
      kind: "claude";
      configDir: string; // ~/.claude etc. (parent of the watched folder <config>/projects)
      sessionId: string;
    }
  | {
      kind: "codex";
      codexDir: string; // ~/.codex (parent of the watched folder ~/.codex/sessions, or the watched folder itself)
      threadId: string;
    };

/**
 * Builds the target from SessionView.id / SessionEvent.sessionId / ChickView.id.
 * Claude Code ids are `<rootId>/<slug>/<sessionId>.jsonl` from lib/sessions.ts (chicks have `/<file name>` after
 * it); chicks move to their parent's session. Codex ids are `<rootId>/codex/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl`.
 */
export function focusTargetOf(id: string, roots: RootEntry[]): FocusTarget | null {
  const parts = id.split("/");
  const root = roots.find((r) => r.id === parts[0]);
  if (!root) return null;
  if (root.kind === "codex") {
    const threadId = codexThreadIdOf(parts[parts.length - 1]);
    if (parts[1] !== "codex" || !threadId) return null;
    return { kind: "codex", codexDir: codexDirOf(root), threadId };
  }
  const file = parts[2];
  if (root.kind !== "claude" || !file?.endsWith(".jsonl")) return null;
  return { kind: "claude", configDir: configDirOf(root), sessionId: file.slice(0, -".jsonl".length) };
}

export async function focusSession(id: string, roots: RootEntry[]): Promise<void> {
  const target = focusTargetOf(id, roots);
  if (!target) return;
  if (target.kind === "codex") {
    await invoke("focus_codex", { codexDir: target.codexDir, threadId: target.threadId });
    return;
  }
  // A conversation handed over to another session may run in a Claude Code background process whose tty isn't
  // a Ghostty pane; the pane showing it is the process of a session it came from, so try those in turn.
  // focus_session returns "front=<tty>" only when Ghostty had that tty
  for (const sessionId of [target.sessionId, ...predecessorsOf(target.sessionId)]) {
    const result = await invoke<string>("focus_session", { configDir: target.configDir, sessionId });
    if (result.startsWith("pid=") && result.includes(" front=")) return;
  }
}
