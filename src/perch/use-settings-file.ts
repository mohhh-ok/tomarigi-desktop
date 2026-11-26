// The settings file in the floating window, which owns the running state (docs/design.md "Settings file", Detailed
// design (d)(e)): reading it at launch (and making it from the earlier settings once), taking each edit through the
// screen's checks (lib/settings-file.ts), and the note, this launch's list and the `[settings-file]` log lines
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "@/lib/i18n";
import { AGENTS } from "@/lib/agents";
import { idbGet, kvPut, loadVoiceInfo, saveVoiceInfo } from "@/lib/kv";
import { loadApiKeyStatus } from "@/lib/api-keys";
import { isReadableDir } from "@/lib/native-fs";
import { fetchIsVoicevoxEngine, fetchTtsVoices } from "@/lib/tts-server";
import { FROM_SETTINGS_FILE, notifySettingChanged } from "@/lib/settings-sync";
import { problemMessage, problemText } from "@/lib/settings-checks";
import { applyFileDoc, type ApplyResult, type FileDoc } from "@/lib/settings-file";
import { FILE_FIELDS, STORE_KEY_OF, toFile, type FileField } from "@/lib/settings-file-fields";

/** Whether the settings show the note that the MCP server was removed: "shown" until the user closes it */
export const KEY_MCP_REMOVED_NOTE = "mcpRemovedNote";

interface Opened {
  state: "ok" | "missing" | "unreadable";
  doc: FileDoc | null;
  line: number | null;
  column: number | null;
  applied: FileDoc;
}

/** One line of the note and of this launch's list */
export interface FileNoteLine {
  id: number;
  at: number;
  text: string;
  /** A refused value or a file that couldn't be read (said in the error color) */
  problem: boolean;
  /** The file couldn't be read: nothing changed, so the note doesn't say it did */
  unreadable?: boolean;
}

const RECENT_LIMIT = 10;
const NOTE_MS = 6_000;

function log(line: string) {
  void invoke("log", { line }).catch(() => {});
}

async function readApplied(): Promise<FileDoc> {
  const values = await Promise.all(FILE_FIELDS.map((field) => invoke<unknown>("settings_get", { field })));
  return Object.fromEntries(FILE_FIELDS.map((field, i) => [field, values[i]]).filter(([, v]) => v !== null && v !== undefined));
}

/** The file as the earlier version's settings in IndexedDB make it (left there for going back to that version) */
async function fileDocFromStore(): Promise<FileDoc> {
  const doc: FileDoc = {};
  for (const field of FILE_FIELDS) {
    if (field === "windowMode") doc.windowMode = await invoke<string>("get_window_mode").catch(() => "floating");
    else doc[field] = toFile(field, await idbGet(STORE_KEY_OF[field]));
  }
  return doc;
}

function defaultsDoc(): FileDoc {
  const doc: FileDoc = { windowMode: "floating" };
  for (const field of FILE_FIELDS) if (field !== "windowMode") doc[field] = toFile(field, undefined);
  return doc;
}

async function applyDeps() {
  const [keySaved, defaults] = await Promise.all([
    loadApiKeyStatus(),
    invoke<{ path: string; exists: boolean }[]>("default_roots", {
      candidates: AGENTS.map((a) => ({ key: a.kind, kind: a.kind, rel: a.home })),
    }).catch(() => []),
  ]);
  return {
    keySaved,
    defaultRootPaths: defaults.map((d) => d.path),
    readable: isReadableDir,
    fetchTtsVoices,
    fetchIsVoicevoxEngine,
    say: t,
  };
}

/** Accepts what passed: Rust keeps it (the file isn't written) and every window reloads it */
async function accept(result: ApplyResult): Promise<void> {
  if (result.voiceInfo) await saveVoiceInfo(...result.voiceInfo);
  for (const { field, value } of result.accepted) {
    await invoke("settings_accept", { field, value });
    log(`[settings-file] applied ${field}`);
    if (field !== "windowMode") notifySettingChanged(STORE_KEY_OF[field as Exclude<FileField, "windowMode">], FROM_SETTINGS_FILE);
  }
  for (const r of result.refused) log(`[settings-file] refused ${r.key} ${r.value}: ${problemText(r.problem)}`);
}

export function useSettingsFile() {
  const [recent, setRecent] = useState<FileNoteLine[]>([]);
  const [notes, setNotes] = useState<FileNoteLine[]>([]);
  const nextId = useRef(0);
  const reported = useRef(new Set<string>());
  const busy = useRef(Promise.resolve());

  const say = useCallback((lines: Omit<FileNoteLine, "id" | "at">[]) => {
    if (lines.length === 0) return;
    const at = Date.now();
    const entries = lines.map((l) => ({ ...l, id: ++nextId.current, at }));
    setRecent((prev) => [...[...entries].reverse(), ...prev].slice(0, RECENT_LIMIT));
    setNotes((prev) => [...prev, ...entries]);
    const ids = new Set(entries.map((e) => e.id));
    setTimeout(() => setNotes((prev) => prev.filter((n) => !ids.has(n.id))), NOTE_MS);
  }, []);

  const report = useCallback(
    (result: ApplyResult, withChanges: boolean) => {
      const lines: { text: string; problem: boolean }[] = [];
      if (withChanges) for (const c of result.changes) lines.push({ text: `${c.setting}: ${c.from} → ${c.to}`, problem: false });
      for (const r of result.refused) {
        lines.push({ text: t("settingsFileRefusedLine", [`${r.setting} (${r.key})`, r.value, problemMessage(r.problem), r.previous]), problem: true });
      }
      const fresh = (keys: string[]) => keys.filter((k) => !reported.current.has(k));
      const unknown = fresh(result.unknown);
      const secret = fresh(result.secret);
      for (const k of [...unknown, ...secret]) {
        reported.current.add(k);
        log(`[settings-file] ignored ${k}${secret.includes(k) ? " (looks like an API key; never read)" : ""}`);
      }
      if (unknown.length > 0) lines.push({ text: t("settingsFileIgnoredKeys", unknown.join(", ")), problem: false });
      if (secret.length > 0) lines.push({ text: t("settingsFileSecretKeys", secret.join(", ")), problem: true });
      say(lines);
    },
    [say],
  );

  const loading = useRef<Promise<void> | null>(null);

  /** At launch, before the folders and the settings are loaded. Outside the app it does nothing. Runs once even when
   * React runs the startup effect twice (StrictMode in dev) */
  const loadOnce = useCallback(async () => {
    const opened = await invoke<Opened | null>("settings_file_open").catch(() => null);
    if (!opened) return;
    let base: FileDoc = { ...defaultsDoc(), ...opened.applied };
    if (Object.keys(opened.applied).length === 0) {
      base = await fileDocFromStore();
      const access = (await idbGet("agentAccess")) as { enabled?: unknown } | undefined;
      if (access?.enabled === true && (await idbGet(KEY_MCP_REMOVED_NOTE)) === undefined) {
        await kvPut(KEY_MCP_REMOVED_NOTE, "shown");
      }
      log("[settings-file] taking the earlier settings");
    }
    if (opened.state === "ok" && opened.doc) {
      const result = await applyFileDoc(opened.doc, base, base, await applyDeps(), await loadVoiceInfo());
      await accept(result);
      report(result, false);
    } else if (opened.state === "unreadable") {
      say([{ text: t("settingsFileUnreadable", [String(opened.line), String(opened.column)]), problem: true, unreadable: true }]);
    }
    await invoke("settings_file_fill", { values: base });
  }, [report, say]);

  const load = useCallback(() => (loading.current ??= loadOnce()), [loadOnce]);

  const onEdited = useCallback(
    ({ doc, before }: { doc: FileDoc; before: FileDoc | null }) => {
      busy.current = busy.current.then(async () => {
        const applied = await readApplied();
        // Only the keys this edit changed: a refused value left in the file isn't refused again on the next edit
        const result = await applyFileDoc(doc, before ?? applied, applied, await applyDeps(), await loadVoiceInfo());
        await accept(result);
        report(result, true);
      }).catch((e) => log(`[settings-file] failed to apply: ${String(e).slice(0, 120)}`));
    },
    [report],
  );

  useEffect(() => {
    const stops = [
      listen<{ doc: FileDoc; before: FileDoc | null }>("settings-file-edited", (e) => onEdited(e.payload)),
      listen<[number, number]>("settings-file-unreadable", (e) =>
        say([{ text: t("settingsFileUnreadable", [String(e.payload[0]), String(e.payload[1])]), problem: true, unreadable: true }]),
      ),
      listen("settings-file-invalid-kept", () => say([{ text: t("settingsFileInvalidKept"), problem: true, unreadable: true }])),
    ];
    return () => stops.forEach((p) => void p.then((f) => f()).catch(() => {}));
  }, [onEdited, say]);

  const dismissNotes = useCallback(() => setNotes([]), []);

  return { load, recent, notes, dismissNotes };
}
