// 鳥・行のクリックで、その Claude Code が動いている Ghostty のペインへ移る(tomarigi に無く、
// デスクトップ版で足した機能。docs/design.md「tomarigi に無く、足すもの」)。
// 対応づけは Rust 側(focus_session): <config>/sessions/<pid>.json の sessionId → pid → ps の tty
// → Ghostty の `tty of terminal`。対応が取れないもの(Codex・終了済み・mock)は何もしない。
import { invoke } from "@tauri-apps/api/core";
import type { RootEntry } from "./fsa";

export interface FocusTarget {
  configDir: string; // ~/.claude など(監視フォルダ <config>/projects の親)
  sessionId: string;
}

/**
 * SessionView.id / SessionEvent.sessionId / ChickView.id から対応先を作る。
 * id は lib/sessions.ts の `<rootId>/<slug>/<sessionId>.jsonl`(ひなはその後ろに `/<ファイル名>`)。
 * ひなは親のセッションへ移る。
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
