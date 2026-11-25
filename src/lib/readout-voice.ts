// Which voice reads aloud: the system's (speechSynthesis) or a local TTS server (docs/design.md "Readout voice (local
// TTS server)"). Settings, not secrets: kept in IndexedDB with the others, like Local AI's base URL and model
import { kvGet, kvPut } from "./settings-store";

export type TtsKind = "openai" | "voicevox";

export interface LocalTtsConfig {
  kind: TtsKind;
  baseUrl: string;
  /** OpenAI-compatible: the voice name; VOICEVOX-compatible: the style id */
  voice: string;
  /** The voice as the list showed it (VOICEVOX: 「<speaker>（<style>）」) */
  voiceLabel?: string;
  /** VOICEVOX-compatible: the speaker's name alone, for the credit */
  speaker?: string;
  /** OpenAI-compatible only */
  model?: string;
  /** The server said it is VOICEVOX ENGINE itself (engine manifest), so the VOICEVOX credit is shown */
  voicevoxCredit?: boolean;
}

export interface ReadoutVoice {
  source: "system" | "local";
  /** Kept when the source goes back to system, so switching back doesn't retype it */
  local?: LocalTtsConfig;
}

export const SYSTEM_VOICE: ReadoutVoice = { source: "system" };

export const DEFAULT_TTS_BASE_URL: Record<TtsKind, string> = {
  openai: "http://localhost:8880/v1",
  voicevox: "http://localhost:50021",
};

export const KEY_READOUT_VOICE = "readoutVoice";

function asLocalConfig(value: unknown): LocalTtsConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.kind !== "openai" && v.kind !== "voicevox") return undefined;
  if (typeof v.baseUrl !== "string" || typeof v.voice !== "string" || !v.baseUrl || !v.voice) return undefined;
  if (v.kind === "openai" && (typeof v.model !== "string" || !v.model)) return undefined;
  const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
  return {
    kind: v.kind,
    baseUrl: v.baseUrl,
    voice: v.voice,
    voiceLabel: str(v.voiceLabel),
    speaker: str(v.speaker),
    model: v.kind === "openai" ? (v.model as string) : undefined,
    voicevoxCredit: v.kind === "voicevox" && v.voicevoxCredit === true,
  };
}

/** Saved data that is missing or broken reads as the system voice, today's readout */
export function parseReadoutVoice(saved: unknown): ReadoutVoice {
  if (typeof saved !== "object" || saved === null) return SYSTEM_VOICE;
  const v = saved as Record<string, unknown>;
  const local = asLocalConfig(v.local);
  return { source: v.source === "local" ? "local" : "system", ...(local && { local }) };
}

export async function loadReadoutVoice(): Promise<ReadoutVoice> {
  return parseReadoutVoice(await kvGet(KEY_READOUT_VOICE));
}

export async function saveReadoutVoice(voice: ReadoutVoice): Promise<void> {
  await kvPut(KEY_READOUT_VOICE, voice);
}

/** VOICEVOX-compatible servers read Japanese only */
export function serverReadsLanguage(kind: TtsKind, lang: string): boolean {
  return kind === "openai" || lang.toLowerCase().startsWith("ja");
}

export type ReadoutRoute = "server" | "system" | "none";

/** How one utterance in `lang` is read: through the server, with the system voice, or not at all */
export function routeOf(voice: ReadoutVoice, lang: string, systemAvailable: boolean): ReadoutRoute {
  if (voice.source === "local" && voice.local && serverReadsLanguage(voice.local.kind, lang)) return "server";
  return systemAvailable ? "system" : "none";
}

/**
 * The base URL to show after the kind is changed in the form: the new kind's default when the field still holds the
 * previous kind's default or is empty; a URL the user typed stays
 */
export function baseUrlForKind(current: string, from: TtsKind, to: TtsKind): string {
  const trimmed = current.trim();
  return trimmed === "" || trimmed === DEFAULT_TTS_BASE_URL[from] ? DEFAULT_TTS_BASE_URL[to] : current;
}

/** The credit VOICEVOX's terms ask for, shown only for VOICEVOX ENGINE itself */
export function voicevoxCreditOf(config: Pick<LocalTtsConfig, "kind" | "speaker" | "voicevoxCredit">): string | undefined {
  return config.kind === "voicevox" && config.voicevoxCredit && config.speaker ? `VOICEVOX:${config.speaker}` : undefined;
}
