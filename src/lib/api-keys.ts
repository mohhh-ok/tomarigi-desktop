// BYOK API keys, the Local AI settings, and the provider used for summaries (docs/design.md "BYOK API keys")
import { invoke } from "@tauri-apps/api/core";
import { kvDelete, kvGet, kvPut } from "./settings-store";

// Names the API keys are saved under in IndexedDB. Used for the dev store and for migrating keys left by older versions (initApiKeys).
// Anthropic keeps its old name "judgeApiKey" (so keys from older versions can be read)
const KEY_AI_API_KEY = "judgeApiKey";
const KEY_OPENAI_API_KEY = "openAiApiKey";
const KEY_TYPESAFE_API_KEY = "typeSafeApiKey";
const KEY_AI_PROVIDER = "aiProvider";
const KEY_LOCAL_AI = "localAi";

// Providers that run summaries and the concierge. local is an OpenAI-compatible server and has no key (lib/local-judge.ts)
export type AiProvider = "anthropic" | "openai" | "local";
// Providers with a key
export type ApiKeyProvider = "anthropic" | "openai";
// Providers no longer used. A key still saved for one can only be seen and deleted (docs/design.md "BYOK API keys":
// TypeSafe (Jev) is no longer used); nothing is sent to it
export const RETIRED_KEY_PROVIDERS = ["typesafe"] as const;
export type RetiredKeyProvider = (typeof RETIRED_KEY_PROVIDERS)[number];
// The rows of the AI settings: the providers with a key, and Local
export type AiSettingsProvider = ApiKeyProvider | "local";

// Where keys are stored is decided by Rust at launch from the identifier (KeyStore in src-tauri/src/keys.rs). Everyday and verify builds use the Keychain,
// dev uses IndexedDB. API calls that use keys are made from Rust, so JS never reads key values.
// All JS does is ask Rust to save, delete, or check whether a key is saved, plus saving to IndexedDB in dev

const API_KEY_IDB_KEYS: Record<ApiKeyProvider, string> = {
  anthropic: KEY_AI_API_KEY,
  openai: KEY_OPENAI_API_KEY,
};
const RETIRED_KEY_IDB_KEYS: Record<RetiredKeyProvider, string> = {
  typesafe: KEY_TYPESAFE_API_KEY,
};
const API_KEY_PROVIDERS = Object.keys(API_KEY_IDB_KEYS) as ApiKeyProvider[];

// unavailable: the OS has no store to save to (Linux without Secret Service). Keys can't be saved and the settings
// say so; there is no plaintext fallback (docs/design.md "Platforms")
export type ApiKeyBackend = "keychain" | "webview" | "unavailable";

async function apiKeyBackend(): Promise<ApiKeyBackend> {
  const backend = await invoke<ApiKeyBackend>("key_backend");
  return backend === "webview" || backend === "unavailable" ? backend : "keychain";
}

/** For the settings screen. ?keystore=unavailable shows the state without a key store (for screenshot checks) */
export async function loadApiKeyBackend(): Promise<ApiKeyBackend> {
  if (new URLSearchParams(location.search).get("keystore") === "unavailable") return "unavailable";
  return apiKeyBackend().catch((): ApiKeyBackend => "keychain");
}

/**
 * Called once at launch. dev (webview) passes the keys in IndexedDB to Rust (Rust keeps them only in memory).
 * Keychain builds move keys that older versions left in IndexedDB to the Keychain and delete them from IndexedDB
 */
export async function initApiKeys(): Promise<void> {
  const backend = await apiKeyBackend();
  // Keys an older version left in IndexedDB stay there until a store can take them
  if (backend === "unavailable") return;
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
  };
}

/** The retired providers that still have a key saved, in the OS store or (dev, or left by an older version) in
 * IndexedDB. Values are not received */
export async function loadRetiredKeysSaved(): Promise<RetiredKeyProvider[]> {
  const status = await invoke<Partial<Record<RetiredKeyProvider, boolean>>>("key_status").catch(
    () => ({}) as Partial<Record<RetiredKeyProvider, boolean>>,
  );
  const saved: RetiredKeyProvider[] = [];
  for (const provider of RETIRED_KEY_PROVIDERS) {
    if (status[provider] === true || Boolean(await kvGet(RETIRED_KEY_IDB_KEYS[provider]))) saved.push(provider);
  }
  return saved;
}

/** Deletes a retired provider's key from the OS store and IndexedDB */
export async function deleteRetiredKey(provider: RetiredKeyProvider): Promise<void> {
  await invoke("key_delete", { provider });
  await kvDelete(RETIRED_KEY_IDB_KEYS[provider]);
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

/** Provider used for summaries and the concierge when more than one is set up. Saved independently of the keys themselves. */
export async function loadAiProvider(): Promise<AiProvider | undefined> {
  const saved = await kvGet(KEY_AI_PROVIDER);
  return saved === "anthropic" || saved === "openai" || saved === "local" ? saved : undefined;
}

export async function saveAiProvider(provider: AiProvider): Promise<void> {
  await kvPut(KEY_AI_PROVIDER, provider);
}

export async function deleteAiProvider(): Promise<void> {
  await kvDelete(KEY_AI_PROVIDER);
}

// ---- Local AI (docs/design.md "BYOK API keys", Local AI). Settings, not secrets: kept in IndexedDB with the others ----

export interface LocalAiConfig {
  baseUrl: string;
  model: string;
}

/** Ollama's default */
export const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";

/** The saved base URL and model, or undefined when Local isn't set up */
export async function loadLocalAiConfig(): Promise<LocalAiConfig | undefined> {
  const saved = (await kvGet(KEY_LOCAL_AI)) as Partial<LocalAiConfig> | undefined;
  const baseUrl = typeof saved?.baseUrl === "string" ? saved.baseUrl.trim() : "";
  const model = typeof saved?.model === "string" ? saved.model.trim() : "";
  return baseUrl && model ? { baseUrl, model } : undefined;
}

export async function saveLocalAiConfig(config: LocalAiConfig): Promise<void> {
  await kvPut(KEY_LOCAL_AI, { baseUrl: config.baseUrl.trim(), model: config.model.trim() });
}

export async function deleteLocalAiConfig(): Promise<void> {
  await kvDelete(KEY_LOCAL_AI);
}

/** Which of the summary providers are set up (a key saved, or Local's base URL and model saved) */
export type AiProviderSetUp = Record<AiProvider, boolean>;

/**
 * Respect the saved choice if it's set up; otherwise the first one set up, in this order. Local comes last, so
 * someone who already used OpenAI / Anthropic keeps it until they choose Local
 */
export function resolveAiProvider(
  preferred: AiProvider | undefined,
  setUp: AiProviderSetUp,
): AiProvider | undefined {
  if (preferred && setUp[preferred]) return preferred;
  return (["anthropic", "openai", "local"] as const).find((p) => setUp[p]);
}

/** Whether any summary provider is set up (speech bubbles and the concierge are shown only then) */
export function anyAiProviderSetUp(setUp: AiProviderSetUp): boolean {
  return setUp.anthropic || setUp.openai || setUp.local;
}

/** Provider used for summaries and the concierge (decided from what is set up and the choice). Only Rust holds key values */
export async function loadActiveAiProvider(): Promise<AiProvider | undefined> {
  const [preferred, status, local] = await Promise.all([loadAiProvider(), loadApiKeyStatus(), loadLocalAiConfig()]);
  return resolveAiProvider(preferred, { anthropic: status.anthropic, openai: status.openai, local: local !== undefined });
}
