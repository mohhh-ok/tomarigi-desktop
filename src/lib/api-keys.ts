// BYOK API keys and the provider used for summaries (docs/design.md "BYOK API keys")
import { invoke } from "@tauri-apps/api/core";
import { kvDelete, kvGet, kvPut } from "./settings-store";

// Names the API keys are saved under in IndexedDB. Used for the dev store and for migrating keys left by older versions (initApiKeys).
// Anthropic keeps its old name "judgeApiKey" (so keys from older versions can be read)
const KEY_AI_API_KEY = "judgeApiKey";
const KEY_OPENAI_API_KEY = "openAiApiKey";
const KEY_TYPESAFE_API_KEY = "typeSafeApiKey";
const KEY_AI_PROVIDER = "aiProvider";

export type AiProvider = "anthropic" | "openai";
// Providers listed under BYOK on the settings screen. typesafe is not used for summaries; it is only for the needs-reply verdict (lib/jev.ts)
export type ApiKeyProvider = AiProvider | "typesafe";

// Where keys are stored is decided by Rust at launch from the identifier (KeyStore in src-tauri/src/keys.rs). Everyday and verify builds use the Keychain,
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
  for (const provider of API_KEY_PROVIDERS) {
    const idbKey = API_KEY_IDB_KEYS[provider];
    const saved = (await kvGet(idbKey)) as string | undefined;
    if (!saved) continue;
    await invoke("key_set", { provider, value: saved });
    if (backend === "keychain") {
      await kvDelete(idbKey);
      void invoke("log", { line: `[keys] migrated ${provider} from IndexedDB to keychain` });
    }
  }
  if (backend === "webview") {
    // Import for verification (import_key_from_stdin in src-tauri). Goes into IndexedDB, same as dev
    const { listen } = await import("@tauri-apps/api/event");
    await listen<[ApiKeyProvider, string]>("key-imported", ({ payload: [provider, value] }) => {
      void kvPut(API_KEY_IDB_KEYS[provider], value);
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
    await kvPut(API_KEY_IDB_KEYS[provider], value);
  }
}

export async function deleteApiKey(provider: ApiKeyProvider): Promise<void> {
  await invoke("key_delete", { provider });
  // If it's still in IndexedDB (dev, or left from before migration), delete it
  await kvDelete(API_KEY_IDB_KEYS[provider]);
}

/** Provider used for summaries when both keys exist. Saved independently of the keys themselves. */
export async function loadAiProvider(): Promise<AiProvider | undefined> {
  const saved = await kvGet(KEY_AI_PROVIDER);
  return saved === "anthropic" || saved === "openai" ? saved : undefined;
}

export async function saveAiProvider(provider: AiProvider): Promise<void> {
  await kvPut(KEY_AI_PROVIDER, provider);
}

export async function deleteAiProvider(): Promise<void> {
  await kvDelete(KEY_AI_PROVIDER);
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
