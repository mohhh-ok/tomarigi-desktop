import { invoke } from "@tauri-apps/api/core";
import { openDB, type IDBPDatabase } from "idb";
import { isReadableDir, NativeDirectoryHandle } from "./native-fs";

const DB_NAME = "tomarigi";
const STORE = "kv";
const KEY_ROOTS = "roots";
const KEY_MUTED = "muted";
// Names the API keys are saved under in IndexedDB. Used for the dev store and for migrating keys left by older versions (initApiKeys).
// Anthropic keeps its old name "judgeApiKey" (so keys from older versions can be read)
const KEY_AI_API_KEY = "judgeApiKey";
const KEY_OPENAI_API_KEY = "openAiApiKey";
const KEY_TYPESAFE_API_KEY = "typeSafeApiKey";
const KEY_AI_PROVIDER = "aiProvider";
const KEY_VOICE_ENABLED = "voiceEnabled";
const KEY_VOICE_VOLUME = "voiceVolume";
const KEY_CHIRP_VOLUME = "chirpVolume";

export type RootKind = "claude" | "codex";
export type AiProvider = "anthropic" | "openai";
// Providers listed under BYOK on the settings screen. typesafe is not used for summaries; it is only for the needs-reply verdict (lib/jev.ts)
export type ApiKeyProvider = AiProvider | "typesafe";

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

function db(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore(STORE);
    },
  });
}

function withHandle(root: Omit<RootEntry, "handle">): RootEntry {
  return { ...root, handle: new NativeDirectoryHandle(root.path) };
}

/**
 * Watched folders = default folders (those that exist) + folders the user added.
 * Defaults are received from Rust on every launch (not saved). Entries that older versions saved with "auto-register on first
 * launch" and that match a default path are dropped and the list is saved again (no double watching). See docs/design.md "How the desktop app works"
 */
export async function loadRoots(): Promise<RootEntry[]> {
  const database = await db();
  const defaults = await invoke<DefaultRoot[]>("default_roots");
  const labels =
    ((await database.get(STORE, KEY_DEFAULT_ROOT_LABELS)) as Record<string, string> | undefined) ??
    {};
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
  const saved = ((await database.get(STORE, KEY_ROOTS)) as StoredRoot[] | undefined) ?? [];
  const added = saved.filter((root) => !defaultPaths.has(root.path));
  if (added.length !== saved.length) await database.put(STORE, added, KEY_ROOTS);
  return [...builtins, ...added.map((root) => withHandle({ ...root, builtin: false }))];
}

/** Added folders go into the saved list; for defaults only the label is saved */
export async function saveRoots(roots: RootEntry[]): Promise<void> {
  const database = await db();
  const stored: StoredRoot[] = roots
    .filter((root) => !root.builtin)
    .map(({ id, kind, label, path }) => ({ id, kind, label, path }));
  const labels: Record<string, string> = {};
  for (const root of roots) {
    if (root.builtin) labels[root.id.replace(/^default:/, "")] = root.label;
  }
  await database.put(STORE, stored, KEY_ROOTS);
  await database.put(STORE, labels, KEY_DEFAULT_ROOT_LABELS);
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
  return (await (await db()).get(STORE, KEY_MUTED)) === true;
}

export async function saveMuted(muted: boolean): Promise<void> {
  await (await db()).put(STORE, muted, KEY_MUTED);
}

// ---- BYOK API keys (docs/design.md "BYOK API keys") ----
// Where keys are stored is decided by Rust at launch from the identifier (KeyStore in src-tauri). Everyday and verify builds use the Keychain,
// dev uses IndexedDB. API calls that use keys are made from Rust, so JS never reads key values.
// All JS does is ask Rust to save, delete, or check whether a key is saved, plus saving to IndexedDB in dev

const API_KEY_IDB_KEYS: Record<ApiKeyProvider, string> = {
  anthropic: KEY_AI_API_KEY,
  openai: KEY_OPENAI_API_KEY,
  typesafe: KEY_TYPESAFE_API_KEY,
};
const API_KEY_PROVIDERS = Object.keys(API_KEY_IDB_KEYS) as ApiKeyProvider[];

export type ApiKeyBackend = "keychain" | "webview";

async function apiKeyBackend(): Promise<ApiKeyBackend> {
  return (await invoke<ApiKeyBackend>("key_backend")) === "webview" ? "webview" : "keychain";
}

/**
 * Called once at launch. dev (webview) passes the keys in IndexedDB to Rust (Rust keeps them only in memory).
 * Keychain builds move keys that older versions left in IndexedDB to the Keychain and delete them from IndexedDB
 */
export async function initApiKeys(): Promise<void> {
  const backend = await apiKeyBackend();
  const store = await db();
  for (const provider of API_KEY_PROVIDERS) {
    const idbKey = API_KEY_IDB_KEYS[provider];
    const saved = (await store.get(STORE, idbKey)) as string | undefined;
    if (!saved) continue;
    await invoke("key_set", { provider, value: saved });
    if (backend === "keychain") {
      await store.delete(STORE, idbKey);
      void invoke("log", { line: `[keys] migrated ${provider} from IndexedDB to keychain` });
    }
  }
  if (backend === "webview") {
    // Import for verification (import_key_from_stdin in src-tauri). Goes into IndexedDB, same as dev
    const { listen } = await import("@tauri-apps/api/event");
    await listen<[ApiKeyProvider, string]>("key-imported", ({ payload: [provider, value] }) => {
      void store.put(STORE, value, API_KEY_IDB_KEYS[provider]);
    });
  }
}

/** Whether a key is saved for each provider (values are not received) */
export async function loadApiKeyStatus(): Promise<Record<ApiKeyProvider, boolean>> {
  // When Rust can't be asked (e.g. a check screen that opens dist outside Tauri), proceed as if nothing is saved
  const status = await invoke<Partial<Record<ApiKeyProvider, boolean>>>("key_status").catch(
    () => ({}) as Partial<Record<ApiKeyProvider, boolean>>,
  );
  return {
    anthropic: status.anthropic === true,
    openai: status.openai === true,
    typesafe: status.typesafe === true,
  };
}

/** Saves a key (replacing works the same way). dev also writes to IndexedDB */
export async function saveApiKey(provider: ApiKeyProvider, value: string): Promise<void> {
  await invoke("key_set", { provider, value });
  if ((await apiKeyBackend()) === "webview") {
    await (await db()).put(STORE, value, API_KEY_IDB_KEYS[provider]);
  }
}

export async function deleteApiKey(provider: ApiKeyProvider): Promise<void> {
  await invoke("key_delete", { provider });
  // If it's still in IndexedDB (dev, or left from before migration), delete it
  await (await db()).delete(STORE, API_KEY_IDB_KEYS[provider]);
}

/** Provider used for summaries when both keys exist. Saved independently of the keys themselves. */
export async function loadAiProvider(): Promise<AiProvider | undefined> {
  const saved = await (await db()).get(STORE, KEY_AI_PROVIDER);
  return saved === "anthropic" || saved === "openai" ? saved : undefined;
}

export async function saveAiProvider(provider: AiProvider): Promise<void> {
  await (await db()).put(STORE, provider, KEY_AI_PROVIDER);
}

export async function deleteAiProvider(): Promise<void> {
  await (await db()).delete(STORE, KEY_AI_PROVIDER);
}

/** Respect the saved choice if it's available; if only one key exists, pick that provider automatically. */
export function resolveAiProvider(
  preferred: AiProvider | undefined,
  hasAnthropic: boolean,
  hasOpenAi: boolean,
): AiProvider | undefined {
  if (preferred === "anthropic" && hasAnthropic) return preferred;
  if (preferred === "openai" && hasOpenAi) return preferred;
  if (hasAnthropic) return "anthropic";
  if (hasOpenAi) return "openai";
  return undefined;
}

/** Provider used for summaries (decided from saved keys and the choice). Only Rust holds key values */
export async function loadActiveAiProvider(): Promise<AiProvider | undefined> {
  const [preferred, status] = await Promise.all([loadAiProvider(), loadApiKeyStatus()]);
  return resolveAiProvider(preferred, status.anthropic, status.openai);
}

/** Opt-in setting for event readout (speechSynthesis). Fully off by default (same off-by-default pattern as loadMuted) */
export async function loadVoiceEnabled(): Promise<boolean> {
  return (await (await db()).get(STORE, KEY_VOICE_ENABLED)) === true;
}

export async function saveVoiceEnabled(enabled: boolean): Promise<void> {
  await (await db()).put(STORE, enabled, KEY_VOICE_ENABLED);
}

/**
 * Volume of event readout (equivalent to SpeechSynthesisUtterance.volume). Range 0–1, default is
 * 1, full volume (so that for existing users "not set" keeps sounding as loud as before,
 * unlike loadMuted/loadVoiceEnabled this defaults to full instead of off). A saved value that is
 * not a number, is NaN, or is out of range (below 0 or above 1) is treated as broken and falls back to 1.
 */
export async function loadVoiceVolume(): Promise<number> {
  const saved = await (await db()).get(STORE, KEY_VOICE_VOLUME);
  if (typeof saved !== "number" || Number.isNaN(saved) || saved < 0 || saved > 1) return 1;
  return saved;
}

export async function saveVoiceVolume(volume: number): Promise<void> {
  await (await db()).put(STORE, volume, KEY_VOICE_VOLUME);
}

/**
 * Volume of chirps (WebAudio synthesis in lib/chirp.ts). A separate, independent setting from readout
 * (voiceVolume), the same idea as separate SE/BGM volumes in games. Range, default, and fallback for invalid values are
 * the same as loadVoiceVolume (0–1, default 1 = existing users keep the same volume as before).
 */
export async function loadChirpVolume(): Promise<number> {
  const saved = await (await db()).get(STORE, KEY_CHIRP_VOLUME);
  if (typeof saved !== "number" || Number.isNaN(saved) || saved < 0 || saved > 1) return 1;
  return saved;
}

export async function saveChirpVolume(volume: number): Promise<void> {
  await (await db()).put(STORE, volume, KEY_CHIRP_VOLUME);
}

// History of fired event decisions (for debugging). A persistent log viewed in the debug dialog.
// The in-memory sessionEventCache has a 30-minute TTL and at most 30 entries and is lost on reload, so
// this is persisted separately so you can check later "did a done fire at this time". Not removed by TTL;
// only the last 500 entries are kept (the count limit is managed by the caller, lib/sessions.ts).
// The value type is owned by lib/sessions.ts (this is only the container)
const KEY_EVENT_LOG = "eventLog";

export async function loadEventLog<T>(): Promise<T[] | undefined> {
  return (await (await db()).get(STORE, KEY_EVENT_LOG)) as T[] | undefined;
}

export async function saveEventLog<T>(log: T[]): Promise<void> {
  await (await db()).put(STORE, log, KEY_EVENT_LOG);
}
