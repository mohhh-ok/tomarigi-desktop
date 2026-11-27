// The rules a setting must pass before it is saved, one function per rule, shared by the settings screen and the
// settings file (docs/design/settings-file.md "Settings file"). Each returns a problem code, or undefined when the value passes;
// problemMessage says it in the UI language (the note) and problemText in English (the log)
import { englishText, t, type MessageName } from "./i18n";
import { isAbsolutePath, samePath } from "./paths";

export type SettingsProblem =
  | "url-invalid"
  | "model-missing"
  | "tts-model-missing"
  | "voice-missing"
  | "no-voice"
  | "no-server"
  | "no-key"
  | "local-not-set-up"
  | "volume-range"
  | "duplicate"
  | "path-not-absolute"
  | "network-path"
  | "not-readable"
  | "label-empty"
  | "builtin"
  | "unknown-option"
  | "wrong-type";

/** What each problem says: the screen's own message where the screen can meet it, else one written for the file */
const PROBLEM_MESSAGE: Record<SettingsProblem, MessageName> = {
  "url-invalid": "localAiUrlInvalid",
  "model-missing": "localAiNeedsModel",
  "tts-model-missing": "readoutNeedsModel",
  "voice-missing": "readoutNeedsVoice",
  "no-voice": "readoutTestNoVoice",
  duplicate: "duplicateRootMessage",
  "no-server": "settingsProblemNoServer",
  "no-key": "settingsProblemNoKey",
  "local-not-set-up": "settingsProblemLocalNotSetUp",
  "volume-range": "settingsProblemVolumeRange",
  "path-not-absolute": "settingsProblemPathNotAbsolute",
  "network-path": "settingsProblemNetworkPath",
  "not-readable": "settingsProblemNotReadable",
  "label-empty": "settingsProblemLabelEmpty",
  builtin: "settingsProblemBuiltin",
  "unknown-option": "settingsProblemUnknownOption",
  "wrong-type": "settingsProblemWrongType",
};

/** The problem in the UI language */
export function problemMessage(problem: SettingsProblem): string {
  return t(PROBLEM_MESSAGE[problem]);
}

/** The problem in English, for the log */
export function problemText(problem: SettingsProblem): string {
  return englishText(PROBLEM_MESSAGE[problem]);
}

/** http(s), with no user name, password, query, or fragment. The same check as local_url in src-tauri/src/keys.rs */
export function isValidBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.includes("?") || trimmed.includes("#")) return false;
  try {
    const url = new URL(trimmed);
    return ["http:", "https:"].includes(url.protocol) && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** Local AI's base URL and model (Save and the connection test) */
export function checkLocalAi(config: { baseUrl: string; model: string }): SettingsProblem | undefined {
  if (!isValidBaseUrl(config.baseUrl)) return "url-invalid";
  if (config.model.trim() === "") return "model-missing";
  return undefined;
}

/** A local TTS server (Save and "Play a sample"). The OpenAI-compatible kind needs a model */
export function checkLocalTts(config: {
  kind: "openai" | "voicevox";
  baseUrl: string;
  voice: string;
  model?: string;
}): SettingsProblem | undefined {
  if (!isValidBaseUrl(config.baseUrl)) return "url-invalid";
  if (config.kind === "openai" && (config.model ?? "").trim() === "") return "tts-model-missing";
  if (config.voice.trim() === "") return "voice-missing";
  return undefined;
}

/** A voice the server's list doesn't have. The screen chooses from that list, so it can't save one that isn't there.
 * `options` is undefined when the list couldn't be read (then the voice is typed, on the screen too) */
export function checkVoiceInList(voice: string, options: readonly string[] | undefined): SettingsProblem | undefined {
  return options && !options.includes(voice) ? "no-voice" : undefined;
}

/** The summary provider: one with a saved key, or Local once it is set up */
export function checkProviderChoice(
  provider: "anthropic" | "openai" | "local",
  setUp: Record<"anthropic" | "openai" | "local", boolean>,
): SettingsProblem | undefined {
  if (setUp[provider]) return undefined;
  return provider === "local" ? "local-not-set-up" : "no-key";
}

/** A volume in percent, as the sliders show it */
export function checkVolume(percent: number): SettingsProblem | undefined {
  return Number.isInteger(percent) && percent >= 0 && percent <= 100 ? undefined : "volume-range";
}

/** A folder to watch: absolute with no `..`, not already watched (defaults included). The folder picker's choice
 * passes the path rules by construction and is checked for duplicates only */
export function checkNewRoot(existing: readonly { path: string }[], path: string): SettingsProblem | undefined {
  if (!isAbsolutePath(path) || path.split(/[\\/]/).includes("..")) return "path-not-absolute";
  if (existing.some((root) => samePath(root.path, path))) return "duplicate";
  return undefined;
}

/** A path written in the settings file, before the file system is touched: a network path (`\\server\share`, `//server`)
 * would make Windows reach that server (and offer it the user's credentials) just to see whether it is readable */
export function checkTypedRootPath(path: string): SettingsProblem | undefined {
  return /^[\\/]{2}/.test(path) ? "network-path" : undefined;
}

export function checkRootLabel(label: string): SettingsProblem | undefined {
  return label.trim() === "" ? "label-empty" : undefined;
}

/** The default folders are always watched */
export function checkRootRemovable(root: { builtin: boolean }): SettingsProblem | undefined {
  return root.builtin ? "builtin" : undefined;
}

/** A value that must be one of the choices (icon set, concierge look, window mode, ...) */
export function checkOption<T extends string>(value: unknown, options: readonly T[]): SettingsProblem | undefined {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? undefined : "unknown-option";
}

/** What a failed connection test says, by the failure kind of lib/judge.ts */
export const AI_TEST_FAILURE_MESSAGE = {
  auth: "byokTestFailedAuth",
  rate_limit: "byokTestFailedRateLimit",
  server: "byokTestFailedServer",
  network: "byokTestFailedNetwork",
  malformed: "byokTestFailedMalformed",
} as const;

/** What a failed "Play a sample" says, by classifyTestError's reason in lib/tts-server.ts, or "audio" */
export const TTS_TEST_FAILURE_MESSAGE = {
  unreachable: "readoutTestUnreachable",
  "wrong-server": "readoutTestWrongServer",
  "no-voice": "readoutTestNoVoice",
  timeout: "readoutTestTimeout",
  server: "readoutTestServerError",
  audio: "readoutTestAudio",
} as const;
