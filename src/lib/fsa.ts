import { invoke } from "@tauri-apps/api/core";
import { openDB, type IDBPDatabase } from "idb";
import { isReadableDir, NativeDirectoryHandle } from "./native-fs";

const DB_NAME = "tomarigi";
const STORE = "kv";
const KEY_ROOTS = "roots";
const KEY_MUTED = "muted";
// IndexedDB での API キーの保存名。dev の保存先と、以前の版が残したキーの移行(initApiKeys)に使う。
// Anthropic は旧称 "judgeApiKey" のまま(以前の版のキーを読めるように)
const KEY_AI_API_KEY = "judgeApiKey";
const KEY_OPENAI_API_KEY = "openAiApiKey";
const KEY_TYPESAFE_API_KEY = "typeSafeApiKey";
const KEY_AI_PROVIDER = "aiProvider";
const KEY_VOICE_ENABLED = "voiceEnabled";
const KEY_VOICE_VOLUME = "voiceVolume";
const KEY_CHIRP_VOLUME = "chirpVolume";

export type RootKind = "claude" | "codex";
export type AiProvider = "anthropic" | "openai";
// 設定画面の BYOK に並ぶ提供元。typesafe は要約には使わず、判断待ちの判定(lib/jev.ts)専用
export type ApiKeyProvider = AiProvider | "typesafe";

export interface RootEntry {
  id: string;
  kind: RootKind;
  label: string; // ユーザーが付ける表示名(フォルダ名だけでは区別に使えない)
  path: string; // 監視フォルダの絶対パス
  // 既定で常に監視するフォルダ(~/.claude/projects 等)。削除できず、保存した登録リストには入れない
  builtin: boolean;
  // path から作る読み取り handle。永続化しない(saveRoots で落とし loadRoots で作り直す)
  handle: NativeDirectoryHandle;
}

// 保存するのはユーザーが追加したものだけ
type StoredRoot = Omit<RootEntry, "handle" | "builtin">;

interface DefaultRoot {
  key: string;
  kind: RootKind;
  path: string;
  exists: boolean;
}

// 既定フォルダの表示名。key は Rust の default_roots と対応する
const DEFAULT_LABEL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
};
// 既定フォルダのラベル編集の保存先(既定は登録リストに入れないので別に持つ)。key → label
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
 * 監視フォルダ一覧 = 既定フォルダ(実在するもの)+ ユーザーが追加したもの。
 * 既定は起動のたびに Rust から受け取る(保存しない)。以前の版が「初回に自動登録」で保存した
 * 既定と同じパスの登録は捨てて保存し直す(二重に監視しない)。docs/design.md の監視フォルダ参照
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

/** 追加したものは登録リストへ、既定はラベルだけを保存する */
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
 * ネイティブのフォルダ選択を開き、選んだフォルダを新しいルートとして返す。
 * キャンセルは "cancelled"、登録済み(既定を含む)と同じフォルダは "duplicate"。
 * 保存はしない。呼び出し側が saveRoots すること。
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

/** フォルダが今読めるか。読めれば "granted"(tomarigi の queryPermission と同じ値で返す) */
export async function queryRead(root: RootEntry): Promise<PermissionState> {
  return (await isReadableDir(root.path)) ? "granted" : "denied";
}

/** 鳴き声のミュート設定。デフォルトは音あり */
export async function loadMuted(): Promise<boolean> {
  return (await (await db()).get(STORE, KEY_MUTED)) === true;
}

export async function saveMuted(muted: boolean): Promise<void> {
  await (await db()).put(STORE, muted, KEY_MUTED);
}

// ---- BYOK の API キー(docs/design.md「BYOK の API キー…」) ----
// キーの保存先は Rust が起動時に identifier で決める(src-tauri の KeyStore)。普段使い・verify はキーチェーン、
// dev は IndexedDB。キーを使う API 呼び出しは Rust から出すので、JS はキーの値を読まない。
// JS がするのは、保存・削除・保存済みかどうかを Rust に頼むことと、dev のときの IndexedDB への保存だけ

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
 * 起動時に 1 回呼ぶ。dev(webview)は IndexedDB のキーを Rust に渡す(Rust はメモリにだけ持つ)。
 * キーチェーンの版は、以前の版が IndexedDB に残したキーをキーチェーンへ移し、IndexedDB から消す
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
    // 検証用の取り込み(src-tauri の import_key_from_stdin)。dev と同じく IndexedDB に入れる
    const { listen } = await import("@tauri-apps/api/event");
    await listen<[ApiKeyProvider, string]>("key-imported", ({ payload: [provider, value] }) => {
      void store.put(STORE, value, API_KEY_IDB_KEYS[provider]);
    });
  }
}

/** 提供元ごとに保存済みかどうか(値は受け取らない) */
export async function loadApiKeyStatus(): Promise<Record<ApiKeyProvider, boolean>> {
  // Rust に聞けない(Tauri の外で dist を開いた確認用の画面など)ときは保存なしとして進む
  const status = await invoke<Partial<Record<ApiKeyProvider, boolean>>>("key_status").catch(
    () => ({}) as Partial<Record<ApiKeyProvider, boolean>>,
  );
  return {
    anthropic: status.anthropic === true,
    openai: status.openai === true,
    typesafe: status.typesafe === true,
  };
}

/** キーを保存する(差し替えも同じ)。dev は IndexedDB にも書く */
export async function saveApiKey(provider: ApiKeyProvider, value: string): Promise<void> {
  await invoke("key_set", { provider, value });
  if ((await apiKeyBackend()) === "webview") {
    await (await db()).put(STORE, value, API_KEY_IDB_KEYS[provider]);
  }
}

export async function deleteApiKey(provider: ApiKeyProvider): Promise<void> {
  await invoke("key_delete", { provider });
  // IndexedDB に残っていれば(dev、または移行前のもの)消す
  await (await db()).delete(STORE, API_KEY_IDB_KEYS[provider]);
}

/** 両方のキーがある場合に要約へ使うプロバイダー。キーそのものとは独立して保存する。 */
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

/** 保存済みの選択が利用可能なら尊重し、片方だけならそのプロバイダーを自動選択する。 */
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

/** 要約に使う提供元(保存済みのキーと選択から決める)。キーの値は Rust だけが持つ */
export async function loadActiveAiProvider(): Promise<AiProvider | undefined> {
  const [preferred, status] = await Promise.all([loadAiProvider(), loadApiKeyStatus()]);
  return resolveAiProvider(preferred, status.anthropic, status.openai);
}

/** イベント読み上げ(speechSynthesis)のオプトイン設定。デフォルトは完全オフ(loadMuted と同じ既定オフのパターン) */
export async function loadVoiceEnabled(): Promise<boolean> {
  return (await (await db()).get(STORE, KEY_VOICE_ENABLED)) === true;
}

export async function saveVoiceEnabled(enabled: boolean): Promise<void> {
  await (await db()).put(STORE, enabled, KEY_VOICE_ENABLED);
}

/**
 * イベント読み上げの音量(SpeechSynthesisUtterance.volume 相当)。範囲は 0〜1、デフォルトは
 * 最大音量の 1(既存ユーザーは「未設定」を今までどおりの音量として体験させたいため、
 * loadMuted/loadVoiceEnabled と違って既定オフではなく既定フルにする)。保存値が
 * number でない・NaN・範囲外(0未満または1超)の場合は壊れた値として 1 にフォールバックする。
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
 * 鳴き声(chirp、lib/chirp.ts の WebAudio 合成)の音量。読み上げ(voiceVolume)とは別軸の
 * 独立設定(ゲームの SE/BGM 音量分離と同じ発想)。範囲・デフォルト・不正値フォールバックは
 * loadVoiceVolume と同じ(0〜1、デフォルト1=既存ユーザーは今までどおりの音量のまま)。
 */
export async function loadChirpVolume(): Promise<number> {
  const saved = await (await db()).get(STORE, KEY_CHIRP_VOLUME);
  if (typeof saved !== "number" || Number.isNaN(saved) || saved < 0 || saved > 1) return 1;
  return saved;
}

export async function saveChirpVolume(volume: number): Promise<void> {
  await (await db()).put(STORE, volume, KEY_CHIRP_VOLUME);
}

// イベント判定の発火履歴(デバッグ用)。デバッグダイアログ で閲覧する永続ログ。
// インメモリの sessionEventCache は30分 TTL・最大30件でリロードすると消えるため、
// 「この時刻に done が出たか」を後から確認できるよう別途永続化する。TTL では消さず、
// 末尾500件のみ保持する(件数の上限は呼び出し側=lib/sessions.ts が管理する)。
// 値の型は lib/sessions.ts が所有する(ここは入れ物のみ)
const KEY_EVENT_LOG = "eventLog";

export async function loadEventLog<T>(): Promise<T[] | undefined> {
  return (await (await db()).get(STORE, KEY_EVENT_LOG)) as T[] | undefined;
}

export async function saveEventLog<T>(log: T[]): Promise<void> {
  await (await db()).put(STORE, log, KEY_EVENT_LOG);
}
