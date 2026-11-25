// The rules a setting must pass before it is saved, one function per rule, shared by the settings screen and the AI
// agent's tools (docs/design.md "Settings by an AI agent (MCP)"). Each returns a problem code, or undefined when the
// value passes; problemText says it in English for the tools
import { englishText, type MessageName } from "./i18n";
import { isAbsolutePath, samePath } from "./paths";

export type SettingsProblem =
  | "url-invalid"
  | "server-not-local"
  | "model-missing"
  | "tts-model-missing"
  | "voice-missing"
  | "no-voice"
  | "no-key"
  | "local-not-set-up"
  | "volume-range"
  | "duplicate"
  | "path-not-absolute"
  | "network-path"
  | "not-readable"
  | "label-empty"
  | "builtin"
  | "unknown-option";

/** What each problem says: the screen's own message where the screen can meet it (the tool answers with its English
 * text), else an English sentence for the agent alone, since the screen can't hit it (a path typed, a value outside
 * the choices, a provider without a key, which the screen's radio doesn't offer) */
const PROBLEM_MESSAGE: Record<SettingsProblem, { key: MessageName } | { en: string }> = {
  "url-invalid": { key: "localAiUrlInvalid" },
  "model-missing": { key: "localAiNeedsModel" },
  "tts-model-missing": { key: "readoutNeedsModel" },
  "voice-missing": { key: "readoutNeedsVoice" },
  "no-voice": { key: "readoutTestNoVoice" },
  duplicate: { key: "duplicateRootMessage" },
  "no-key": {
    en: "No API key is saved for this provider. Ask the user to paste it in Tomarigi's settings (Settings → AI); keys can't be set through these tools.",
  },
  "local-not-set-up": { en: "Local AI isn't set up yet. Set its server URL and model first (set_local_ai)." },
  "volume-range": { en: "A volume is a whole number from 0 to 100 (percent, as the slider shows)." },
  "path-not-absolute": { en: "Give the folder as an absolute path without \"..\" (e.g. /Users/me/.claude-work/projects)." },
  "server-not-local": {
    en: "Through these tools a server must be on this computer or the local network: localhost, a .local name, or a private IP address. Ask the user to enter any other server on Tomarigi's settings screen.",
  },
  "network-path": { en: "Network paths can't be watched. Give a folder on this computer." },
  "not-readable": { en: "That folder doesn't exist or can't be read." },
  "label-empty": { en: "A label can't be empty." },
  builtin: { en: "The default folders are always watched and can't be removed. Their label can be changed." },
  "unknown-option": { en: "That isn't one of the choices. get_settings lists them." },
};

/** The problem in English, for the AI agent's tools */
export function problemText(problem: SettingsProblem): string {
  const message = PROBLEM_MESSAGE[problem];
  return "key" in message ? englishText(message.key) : message.en;
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

/** A path typed by the AI agent, before the file system is touched: a network path (`\\server\share`, `//server`)
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

/** What a failed connection test says, by the failure kind of lib/judge.ts (the screen's line and the tool's answer) */
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

function ipv4Local(a: number, b: number): boolean {
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** The 8 groups of an IPv6 address as the URL parser writes it (compressed, lowercase hex), or undefined */
function ipv6Groups(text: string): number[] | undefined {
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const part = (h: string) => (h === "" ? [] : h.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail] : head;
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : undefined;
}

/**
 * A server URL the AI agent gives (Local AI, a TTS server): only this computer or the local network, so an agent that
 * was talked into it can't send the transcripts the summaries read to a server outside. `localhost`, a `.local` name,
 * or a loopback / private / link-local IP address written as such; any other name is refused without being looked up
 * (a name can resolve to a local address and still be the outside's). The settings screen doesn't use this rule
 */
export function checkAgentServerUrl(value: string): SettingsProblem | undefined {
  let host: string;
  try {
    host = new URL(value.trim()).hostname.toLowerCase();
  } catch {
    return "url-invalid";
  }
  if (host === "localhost" || (host.endsWith(".local") && host.length > ".local".length)) return undefined;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) return ipv4Local(Number(v4[1]), Number(v4[2])) ? undefined : "server-not-local";
  if (host.startsWith("[") && host.endsWith("]")) {
    const g = ipv6Groups(host.slice(1, -1));
    if (!g) return "server-not-local";
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return undefined;
    // An IPv4 address written as IPv6 (::ffff:a.b.c.d) is read as that IPv4 address
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return ipv4Local(g[6] >> 8, g[6] & 0xff) ? undefined : "server-not-local";
    }
    if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80) return undefined;
  }
  return "server-not-local";
}
