// Calls to a local TTS server through Rust (src-tauri/src/tts.rs) and what is read from its answers (docs/design/readout-voice.md
// "Readout voice (local TTS server)")
import { invoke } from "@tauri-apps/api/core";
import type { HttpReply } from "./judge";
import type { LocalTtsConfig, TtsKind } from "./readout-voice";
import type { SynthesisResult } from "./readout-queue";

/** One utterance's audio, or the error (`timeout`, `network: …`, `http-<status>: …`, `not-audio`) */
export async function synthesize(config: LocalTtsConfig, text: string, timeoutMs: number): Promise<SynthesisResult> {
  try {
    const audio = await invoke<ArrayBuffer>("tts_speech", {
      kind: config.kind,
      baseUrl: config.baseUrl,
      model: config.model ?? null,
      voice: config.voice,
      text,
      timeoutMs,
    });
    return { ok: true, audio };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export interface TtsVoiceOption {
  value: string;
  label: string;
  /** VOICEVOX: the speaker's name alone, for the credit */
  speaker?: string;
}

/** VOICEVOX `/speakers`: one option per style, the style id as the value */
export function parseVoicevoxSpeakers(body: string): TtsVoiceOption[] | undefined {
  try {
    const data = JSON.parse(body) as unknown;
    if (!Array.isArray(data)) return undefined;
    const options: TtsVoiceOption[] = [];
    for (const speaker of data as Array<{ name?: unknown; styles?: unknown }>) {
      if (typeof speaker?.name !== "string" || !Array.isArray(speaker.styles)) continue;
      for (const style of speaker.styles as Array<{ name?: unknown; id?: unknown }>) {
        if (typeof style?.id !== "number") continue;
        const styleName = typeof style.name === "string" ? style.name : String(style.id);
        options.push({ value: String(style.id), label: `${speaker.name}（${styleName}）`, speaker: speaker.name });
      }
    }
    return options;
  } catch {
    return undefined;
  }
}

/** An OpenAI-compatible server's `/audio/voices`: `{ voices: [...] }` or a bare array, of names or `{ id | name }` */
export function parseOpenAiVoices(body: string): TtsVoiceOption[] | undefined {
  try {
    const data = JSON.parse(body) as unknown;
    const list = Array.isArray(data) ? data : (data as { voices?: unknown })?.voices;
    if (!Array.isArray(list)) return undefined;
    return list
      .map((v) => (typeof v === "string" ? v : typeof v?.id === "string" ? v.id : typeof v?.name === "string" ? v.name : ""))
      .filter((v): v is string => v !== "")
      .map((v) => ({ value: v, label: v }));
  } catch {
    return undefined;
  }
}

/** Whether VOICEVOX's engine manifest says the server is VOICEVOX ENGINE itself (AivisSpeech says AivisSpeech) */
export function isVoicevoxEngineManifest(body: string): boolean {
  try {
    return (JSON.parse(body) as { brand_name?: unknown }).brand_name === "VOICEVOX";
  } catch {
    return false;
  }
}

async function list(kind: TtsKind, baseUrl: string, path: string): Promise<string | undefined> {
  try {
    const reply = await invoke<HttpReply>("tts_list", { kind, baseUrl, path });
    return reply.status >= 200 && reply.status < 300 ? reply.body : undefined;
  } catch {
    return undefined;
  }
}

/** The server's voices, or undefined when the list can't be read (then the voice is typed) */
export async function fetchTtsVoices(kind: TtsKind, baseUrl: string): Promise<TtsVoiceOption[] | undefined> {
  const body = await list(kind, baseUrl, kind === "voicevox" ? "speakers" : "audio/voices");
  if (body === undefined) return undefined;
  const options = kind === "voicevox" ? parseVoicevoxSpeakers(body) : parseOpenAiVoices(body);
  return options && options.length > 0 ? options : undefined;
}

/** An OpenAI-compatible server's model ids (`/models`) */
export async function fetchTtsModels(baseUrl: string): Promise<string[] | undefined> {
  const body = await list("openai", baseUrl, "models");
  if (body === undefined) return undefined;
  try {
    const data = JSON.parse(body) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(data.data)) return undefined;
    const ids = data.data.map((m) => m.id).filter((id): id is string => typeof id === "string" && id !== "");
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a VOICEVOX-compatible server is VOICEVOX ENGINE itself; false when it doesn't say */
export async function fetchIsVoicevoxEngine(baseUrl: string): Promise<boolean> {
  const body = await list("voicevox", baseUrl, "engine_manifest");
  return body !== undefined && isVoicevoxEngineManifest(body);
}

export type TtsTestFailure = "unreachable" | "wrong-server" | "no-voice" | "timeout" | "server";

/** What a failed Test says, from the error of synthesize */
export function classifyTestError(kind: TtsKind, error: string): { reason: TtsTestFailure; status?: number } {
  if (error.startsWith("timeout")) return { reason: "timeout" };
  if (error.startsWith("network")) return { reason: "unreachable" };
  if (error.startsWith("not-audio")) return { reason: "wrong-server" };
  const http = /^http-(\d+):?\s*([\s\S]*)$/.exec(error);
  if (!http) return { reason: "server" };
  const status = Number(http[1]);
  const message = http[2].toLowerCase();
  if (status === 404 || status === 405) {
    // A server of this kind answers an unknown voice with a 404 that says so; any other 404 is a wrong path
    if (mentionsVoice(kind, message)) return { reason: "no-voice", status };
    return { reason: "wrong-server", status };
  }
  if ([400, 422].includes(status) && mentionsVoice(kind, message)) return { reason: "no-voice", status };
  return { reason: "server", status };
}

function mentionsVoice(kind: TtsKind, message: string): boolean {
  return kind === "voicevox" ? /speaker|style|スタイル|話者/.test(message) : /voice/.test(message);
}
