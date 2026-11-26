// The app's one key-value store, shared by every window of the app. The settings of the settings file
// (docs/design.md "Settings file") live in Rust, which keeps the values that passed and writes ~/.tomarigi/settings.json;
// every other key (the last section shown, notes closed, the event log, turn verdicts, garden positions, caches) is in
// the "tomarigi" IndexedDB, store "kv" (the windows load the same origin). Every write goes through kvPut / kvDelete,
// which tell the other windows (lib/settings-sync.ts). Outside the app (the browser mock) everything is in IndexedDB
import { openDB, type IDBPDatabase } from "idb";
import { notifySettingChanged } from "./settings-sync";
import { FIELD_OF_STORE_KEY, fromFile, toFile, voiceInfoOf, type FileField, type VoiceInfo } from "./settings-file-fields";

const DB_NAME = "tomarigi";
const STORE = "kv";
/** The readout voice's label, speaker and credit by server and voice (settings-file-fields.ts VoiceInfo) */
export const KEY_READOUT_VOICE_INFO = "readoutVoiceInfo";

function db(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    },
  });
}

function inApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type RoutedField = Exclude<FileField, "windowMode">;

function routed(key: string): RoutedField | undefined {
  const field = FIELD_OF_STORE_KEY[key];
  return field && field !== "windowMode" && inApp() ? field : undefined;
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

/** IndexedDB itself, whatever the key: the settings an earlier version saved there (read once, to make the file) */
export async function idbGet(key: string): Promise<unknown> {
  return (await db()).get(STORE, key);
}

async function idbPut(key: string, value: unknown): Promise<void> {
  await (await db()).put(STORE, value, key);
}

export async function loadVoiceInfo(): Promise<Record<string, VoiceInfo>> {
  const saved = await idbGet(KEY_READOUT_VOICE_INFO);
  return saved && typeof saved === "object" ? (saved as Record<string, VoiceInfo>) : {};
}

export async function saveVoiceInfo(key: string, info: VoiceInfo): Promise<void> {
  await idbPut(KEY_READOUT_VOICE_INFO, { ...(await loadVoiceInfo()), [key]: info });
}

export async function kvGet(key: string): Promise<unknown> {
  const field = routed(key);
  if (!field) return idbGet(key);
  const value = await invoke<unknown>("settings_get", { field });
  return fromFile(field, value, field === "readoutVoice" ? await loadVoiceInfo() : undefined);
}

export async function kvPut(key: string, value: unknown): Promise<void> {
  const field = routed(key);
  if (field) {
    if (field === "readoutVoice") {
      const info = voiceInfoOf(value);
      if (info) await saveVoiceInfo(...info);
    }
    await invoke("settings_set", { field, value: toFile(field, value) });
  } else {
    await idbPut(key, value);
  }
  notifySettingChanged(key);
}

export async function kvDelete(key: string): Promise<void> {
  const field = routed(key);
  if (field) await invoke("settings_set", { field, value: null });
  else await (await db()).delete(STORE, key);
  notifySettingChanged(key);
}
