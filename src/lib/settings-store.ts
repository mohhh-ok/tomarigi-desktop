// Settings kept in the WebView's IndexedDB: watched folders, sound and readout settings, and the event log
import { invoke } from "@tauri-apps/api/core";
import { openDB, type IDBPDatabase } from "idb";
import { isReadableDir, NativeDirectoryHandle } from "./native-fs";

const DB_NAME = "tomarigi";
const STORE = "kv";
const KEY_ROOTS = "roots";
const KEY_MUTED = "muted";
const KEY_VOICE_ENABLED = "voiceEnabled";
const KEY_VOICE_VOLUME = "voiceVolume";
const KEY_CHIRP_VOLUME = "chirpVolume";

function db(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore(STORE);
    },
  });
}

/** Reads one value of the settings store (lib/api-keys.ts also keeps its entries here) */
export async function kvGet(key: string): Promise<unknown> {
  return (await db()).get(STORE, key);
}

export async function kvPut(key: string, value: unknown): Promise<void> {
  await (await db()).put(STORE, value, key);
}

export async function kvDelete(key: string): Promise<void> {
  await (await db()).delete(STORE, key);
}

export type RootKind = "claude" | "codex";
export interface RootEntry {
  id: string;
  kind: RootKind;
  label: string; // display name the user gives it (the folder name alone isn't enough to tell them apart)
  path: string; // absolute path of the watched folder
  // A folder always watched by default (~/.claude/projects etc.). Can't be removed and isn't put into the saved list
  builtin: boolean;
  // read handle built from path. Not persisted (saveRoots drops it and loadRoots rebuilds it)
  handle: NativeDirectoryHandle;
}

// Only what the user added is saved
type StoredRoot = Omit<RootEntry, "handle" | "builtin">;

interface DefaultRoot {
  key: string;
  kind: RootKind;
  path: string;
  exists: boolean;
}

// Display names of the default folders. Keys correspond to default_roots in Rust
const DEFAULT_LABEL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
};
// Where edited labels of default folders are saved (defaults aren't in the saved list, so they're kept separately). key → label
const KEY_DEFAULT_ROOT_LABELS = "defaultRootLabels";

function withHandle(root: Omit<RootEntry, "handle">): RootEntry {
  return { ...root, handle: new NativeDirectoryHandle(root.path) };
}

/**
 * Watched folders = default folders (those that exist) + folders the user added.
 * Defaults are received from Rust on every launch (not saved). Entries that older versions saved with "auto-register on first
 * launch" and that match a default path are dropped and the list is saved again (no double watching). See docs/design.md "Watched folders"
 */
export async function loadRoots(): Promise<RootEntry[]> {
  const defaults = await invoke<DefaultRoot[]>("default_roots");
  const labels = ((await kvGet(KEY_DEFAULT_ROOT_LABELS)) as Record<string, string> | undefined) ?? {};
  const builtins = defaults
    .filter((d) => d.exists)
    .map((d) =>
      withHandle({
        id: `default:${d.key}`,
        kind: d.kind,
        label: labels[d.key] ?? DEFAULT_LABEL[d.key] ?? d.path,
        path: d.path,
        builtin: true,
      }),
    );

  const defaultPaths = new Set(defaults.map((d) => d.path));
  const saved = ((await kvGet(KEY_ROOTS)) as StoredRoot[] | undefined) ?? [];
  const added = saved.filter((root) => !defaultPaths.has(root.path));
  if (added.length !== saved.length) await kvPut(KEY_ROOTS, added);
  return [...builtins, ...added.map((root) => withHandle({ ...root, builtin: false }))];
}

/** Added folders go into the saved list; for defaults only the label is saved */
export async function saveRoots(roots: RootEntry[]): Promise<void> {
  const stored: StoredRoot[] = roots
    .filter((root) => !root.builtin)
    .map(({ id, kind, label, path }) => ({ id, kind, label, path }));
  const labels: Record<string, string> = {};
  for (const root of roots) {
    if (root.builtin) labels[root.id.replace(/^default:/, "")] = root.label;
  }
  await kvPut(KEY_ROOTS, stored);
  await kvPut(KEY_DEFAULT_ROOT_LABELS, labels);
}

/**
 * Opens the native folder picker and returns the chosen folder as a new root.
 * Returns "cancelled" on cancel, and "duplicate" for a folder that is already registered (including defaults).
 * Doesn't save. The caller must call saveRoots.
 */
export async function pickNewRoot(
  existing: RootEntry[],
  kind: RootKind,
): Promise<RootEntry | "duplicate" | "cancelled"> {
  const path = await invoke<string | null>("pick_folder", {
    defaultPath: kind === "claude" ? "~/.claude/projects" : "~/.codex/sessions",
  });
  if (!path) return "cancelled";
  const normalized = path.replace(/\/+$/, "");
  if (existing.some((root) => root.path.replace(/\/+$/, "") === normalized)) return "duplicate";
  return withHandle({
    id: crypto.randomUUID(),
    kind,
    label: nextAutomaticLabel(existing, kind),
    path,
    builtin: false,
  });
}

function nextAutomaticLabel(existing: StoredRoot[], kind: RootKind): string {
  const base = kind === "claude" ? "Claude Code" : "Codex";
  const labels = new Set(existing.map((root) => root.label));
  if (!labels.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!labels.has(candidate)) return candidate;
  }
}

/** Whether the folder can be read now. Returns "granted" if readable (the same value as tomarigi's queryPermission) */
export async function queryRead(root: RootEntry): Promise<PermissionState> {
  return (await isReadableDir(root.path)) ? "granted" : "denied";
}

/** Mute setting for chirps. Sound is on by default */
export async function loadMuted(): Promise<boolean> {
  return (await kvGet(KEY_MUTED)) === true;
}

export async function saveMuted(muted: boolean): Promise<void> {
  await kvPut(KEY_MUTED, muted);
}

/** Opt-in setting for event readout (speechSynthesis). Fully off by default (same off-by-default pattern as loadMuted) */
export async function loadVoiceEnabled(): Promise<boolean> {
  return (await kvGet(KEY_VOICE_ENABLED)) === true;
}

export async function saveVoiceEnabled(enabled: boolean): Promise<void> {
  await kvPut(KEY_VOICE_ENABLED, enabled);
}

/**
 * Volume of event readout (equivalent to SpeechSynthesisUtterance.volume) and of chirps (WebAudio synthesis in
 * lib/chirp.ts). The two are separate, independent settings, the same idea as separate SE/BGM volumes in games.
 * Range 0–1, default 1, full volume (so that for existing users "not set" keeps sounding as loud as before; unlike
 * loadMuted/loadVoiceEnabled this defaults to full instead of off). A saved value that is not a number, is NaN, or
 * is out of range (below 0 or above 1) is treated as broken and falls back to 1.
 */
async function loadVolume(key: string): Promise<number> {
  const saved = await kvGet(key);
  if (typeof saved !== "number" || Number.isNaN(saved) || saved < 0 || saved > 1) return 1;
  return saved;
}

export const loadVoiceVolume = () => loadVolume(KEY_VOICE_VOLUME);
export const saveVoiceVolume = (volume: number) => kvPut(KEY_VOICE_VOLUME, volume);
export const loadChirpVolume = () => loadVolume(KEY_CHIRP_VOLUME);
export const saveChirpVolume = (volume: number) => kvPut(KEY_CHIRP_VOLUME, volume);

// History of fired event decisions (for debugging). A persistent log viewed in the debug log screen.
// The in-memory sessionEventCache has a 30-minute TTL and at most 30 entries and is lost on reload, so
// this is persisted separately so you can check later "did a done fire at this time". Not removed by TTL;
// only the last 500 entries are kept (the count limit is managed by the caller, lib/session-event-log.ts).
// The value type is owned by lib/session-event-log.ts (this is only the container)
const KEY_EVENT_LOG = "eventLog";

export async function loadEventLog<T>(): Promise<T[] | undefined> {
  return (await kvGet(KEY_EVENT_LOG)) as T[] | undefined;
}

export async function saveEventLog<T>(log: T[]): Promise<void> {
  await kvPut(KEY_EVENT_LOG, log);
}
