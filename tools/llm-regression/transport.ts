// The app's requests sent over fetch instead of Rust (src-tauri/src/keys.rs: anthropic_messages, openai_responses,
// local_chat), with keys from the environment. Only how a body reaches the API lives here: the bodies, the reading of
// the replies, and the verdicts are the app's own functions (src/lib/judge.ts, openai-judge.ts, local-judge.ts), run
// through judgeRunnerFor (src/lib/ai-judge.ts). The URLs, headers, and timeouts are the ones keys.rs uses.
import type { HttpReply, JudgeTransport } from "../../src/lib/judge.ts";

/** The values of src-tauri/src/keys.rs; tests/llm-transport.test.ts checks they still match */
export const KEYS_RS_VALUES = {
  openaiUrl: "https://api.openai.com/v1/responses",
  anthropicUrl: "https://api.anthropic.com/v1/messages",
  anthropicVersion: "2023-06-01",
  cloudTimeoutSeconds: 30,
  localTimeoutSeconds: 90,
  localChatPath: "chat/completions",
} as const;
const CLOUD_TIMEOUT_MS = KEYS_RS_VALUES.cloudTimeoutSeconds * 1000;
const LOCAL_TIMEOUT_MS = KEYS_RS_VALUES.localTimeoutSeconds * 1000;

async function post(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<HttpReply> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: r.status, body: await r.text() };
}

export interface Keys {
  openai?: string;
  anthropic?: string;
}

export function fetchTransport(keys: Keys): JudgeTransport {
  return {
    keyed(command, body) {
      if (command === "openai_responses") {
        // Rust refuses with "no-key"; runOpenAiJudge reads that as an auth failure
        if (!keys.openai) throw new Error("no-key");
        return post(KEYS_RS_VALUES.openaiUrl, { authorization: `Bearer ${keys.openai}` }, body, CLOUD_TIMEOUT_MS);
      }
      if (!keys.anthropic) throw new Error("no-key");
      return post(
        KEYS_RS_VALUES.anthropicUrl,
        { "x-api-key": keys.anthropic, "anthropic-version": KEYS_RS_VALUES.anthropicVersion },
        body,
        CLOUD_TIMEOUT_MS,
      );
    },
    local(baseUrl, body) {
      return post(`${baseUrl.trim().replace(/\/$/, "")}/${KEYS_RS_VALUES.localChatPath}`, {}, body, LOCAL_TIMEOUT_MS);
    },
  };
}

/** The model ids of a local server (`GET <base URL>/models`), or why they can't be read */
export async function localModels(baseUrl: string): Promise<{ ok: true; ids: string[] } | { ok: false; reason: string }> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(3_000) });
    if (!r.ok) return { ok: false, reason: `GET /models returned ${r.status}` };
    const data = (await r.json()) as { data?: { id?: unknown }[] };
    return { ok: true, ids: (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string") };
  } catch (e) {
    return { ok: false, reason: `no server at ${baseUrl} (${(e as Error).message.slice(0, 80)})` };
  }
}
