// The rules a setting must pass before it is saved, one function per rule, shared by the settings screen and the AI
// agent's tools (docs/design.md "Settings by an AI agent (MCP)"). Each returns a problem code, or undefined when the
// value passes; PROBLEM_MESSAGE says it in words (the screen in the UI language, the tools in English)
import { isAbsolutePath, samePath } from "./paths";

export type SettingsProblem =
  | "url-invalid"
  | "model-missing"
  | "tts-model-missing"
  | "voice-missing"
  | "no-voice"
  | "no-key"
  | "local-not-set-up"
  | "volume-range"
  | "duplicate"
  | "path-not-absolute"
  | "not-readable"
  | "label-empty"
  | "builtin"
  | "unknown-option";

/** The message key that says each problem: the screen's own message where it has one */
export const PROBLEM_MESSAGE = {
  "url-invalid": "localAiUrlInvalid",
  "model-missing": "localAiNeedsModel",
  "tts-model-missing": "readoutNeedsModel",
  "voice-missing": "readoutNeedsVoice",
  "no-voice": "readoutTestNoVoice",
  "no-key": "agentProblemNoKey",
  "local-not-set-up": "agentProblemLocalNotSetUp",
  "volume-range": "agentProblemVolumeRange",
  duplicate: "duplicateRootMessage",
  "path-not-absolute": "agentProblemPathNotAbsolute",
  "not-readable": "agentProblemNotReadable",
  "label-empty": "agentProblemLabelEmpty",
  builtin: "agentProblemBuiltinRoot",
  "unknown-option": "agentProblemUnknownOption",
} as const satisfies Record<SettingsProblem, string>;

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

/** A folder to watch: absolute, not already watched (defaults included), and readable */
export function checkNewRoot(
  existing: readonly { path: string }[],
  path: string,
  readable: boolean,
): SettingsProblem | undefined {
  if (!isAbsolutePath(path)) return "path-not-absolute";
  if (existing.some((root) => samePath(root.path, path))) return "duplicate";
  if (!readable) return "not-readable";
  return undefined;
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
