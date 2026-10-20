// Clicking a bird or row moves to the terminal pane where that agent is running (not in the tomarigi Chrome
// extension; a feature added in the desktop version. docs/design.md "Jumping to the terminal pane").
// The mapping is done on the Rust side (src-tauri/src/focus): pid → tty and ancestor processes from ps → the terminal
// app that owns them → that terminal's adapter (Ghostty, iTerm2, Terminal.app, WezTerm, kitty, through tmux).
// The pid comes from sessionId in <config>/sessions/<pid>.json for Claude Code (focus_session), and from the process
// that has thread-writer-locks/<threadId>.lock open for Codex (focus_codex), or the TUI matched to the thread when the
// shared codex app-server holds the lock; other agents pass their pid to focusPid.
// Anything that can't be mapped (ended sessions, mock) does nothing.
import { invoke } from "@tauri-apps/api/core";
import type { RootEntry } from "./settings-store";
import { codexDirOf, codexThreadIdOf, configDirOf, jumpPidOf, predecessorsOf } from "./sessions";

/** pane: the pane was focused. app: only the terminal app was brought to the front. none: nothing was done */
export type FocusResult = { level: "pane" | "app" | "none"; detail: string };

/** Jumps to the terminal pane where pid runs. With fallbackToApp, the owning app is still brought to the front when
 * its pane can't be found */
export function focusPid(pid: number, fallbackToApp = true): Promise<FocusResult> {
  return invoke<FocusResult>("focus_pid", { pid, fallbackToApp });
}

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
    }
  | {
      // The other agents (docs/design.md "Agents"): the pid their adapter matched on the last scan
      kind: "pid";
      pid: number;
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
  // When several sessions share a cwd only the one written last has a pid; the others do nothing on click
  if (root.kind !== "claude" && root.kind !== "codex") {
    const pid = jumpPidOf(id);
    return pid === undefined ? null : { kind: "pid", pid };
  }
  if (root.kind === "codex") {
    const threadId = codexThreadIdOf(parts[parts.length - 1]);
    if (parts[1] !== "codex" || !threadId) return null;
    // A thread held by the shared app-server has its TUI's pid; the lock's holder has no terminal
    const pid = jumpPidOf(id);
    if (pid !== undefined) return { kind: "pid", pid };
    return { kind: "codex", codexDir: codexDirOf(root), threadId };
  }
  const file = parts[2];
  if (root.kind !== "claude" || !file?.endsWith(".jsonl")) return null;
  return { kind: "claude", configDir: configDirOf(root), sessionId: file.slice(0, -".jsonl".length) };
}

export async function focusSession(id: string, roots: RootEntry[]): Promise<void> {
  const target = focusTargetOf(id, roots);
  if (!target) return;
  if (target.kind === "pid") {
    await focusPid(target.pid);
    return;
  }
  if (target.kind === "codex") {
    await invoke<FocusResult>("focus_codex", { codexDir: target.codexDir, threadId: target.threadId, fallbackToApp: true });
    return;
  }
  // A conversation handed over to another session may run in a Claude Code background process whose tty isn't
  // a terminal pane; the pane showing it is the process of a session it came from, so try those in turn.
  // Only a pane-level focus counts as found; when none is, the app owning the first session is brought to the front
  const sessionIds = [target.sessionId, ...predecessorsOf(target.sessionId)];
  const focus = (sessionId: string, fallbackToApp: boolean) =>
    invoke<FocusResult>("focus_session", { configDir: target.configDir, sessionId, fallbackToApp });
  for (const sessionId of sessionIds) {
    const result = await focus(sessionId, sessionIds.length === 1);
    if (result.level === "pane") return;
  }
  if (sessionIds.length > 1) await focus(target.sessionId, true);
}
