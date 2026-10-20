// Local AI (lib/local-judge.ts, lib/api-keys.ts; docs/design.md "BYOK API keys", Local AI). The server is never
// called: the request body and the reading of reply bodies are checked as plain functions
import { expect, test } from "bun:test";
import {
  isValidBaseUrl,
  LOCAL_NO_MATCHING_JSON,
  localChatBody,
  parseLocalChatReply,
  pickLocalModel,
  stripThinking,
} from "../src/lib/local-judge";
import { anyAiProviderSetUp, resolveAiProvider } from "../src/lib/api-keys";
import { askConcierge, buildConciergePayload } from "../src/lib/concierge";
import type { JudgeResult, JudgeTaskDefinition } from "../src/lib/judge";

const TASK: JudgeTaskDefinition = {
  name: "summarize_turn_line",
  systemPrompt: "Untrusted input.",
  outputFields: { line: { type: "string", description: "One line." } },
  maxTokens: 256,
};

function reply(content: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], ...extra });
}

test("the request asks for strict JSON matching the task's schema, not a tool call", () => {
  const body = localChatBody(TASK, { assistant_text: "x" }, "qwen2.5:7b-instruct") as Record<string, unknown>;
  expect(body.model).toBe("qwen2.5:7b-instruct");
  expect(body.stream).toBe(false);
  expect(body.tools).toBeUndefined();
  expect(body.messages).toEqual([
    { role: "system", content: "Untrusted input." },
    { role: "user", content: JSON.stringify({ assistant_text: "x" }) },
  ]);
  expect(body.response_format).toEqual({
    type: "json_schema",
    json_schema: {
      name: "summarize_turn_line",
      strict: true,
      schema: {
        type: "object",
        properties: { line: { type: "string", description: "One line." } },
        required: ["line"],
        additionalProperties: false,
      },
    },
  });
  // Thinking models need room before the answer
  expect(body.max_tokens as number).toBeGreaterThanOrEqual(2048);
});

test("a JSON answer matching the schema is the verdict, with usage", () => {
  const text = reply('{"line":"テスト追加完了"}', {
    usage: { prompt_tokens: 240, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 200 } },
  });
  expect(parseLocalChatReply(TASK, text, 200)).toEqual({
    ok: true,
    verdict: { line: "テスト追加完了" },
    usage: { input: 240, cachedInput: 200, output: 9 },
  });
  // Without usage, no token counts
  expect(parseLocalChatReply(TASK, reply('{"line":"a"}'), 200)).toEqual({ ok: true, verdict: { line: "a" } });
});

test("thinking output is dropped and reasoning_content is never used", () => {
  expect(stripThinking("<think>let me see</think>\n{\"line\":\"a\"}")).toBe('{"line":"a"}');
  expect(stripThinking("text <think>unfinished")).toBe("text");
  const text = JSON.stringify({
    choices: [
      {
        finish_reason: "stop",
        message: { content: '<think>hmm</think>{"line":"<think>x</think>done"}', reasoning_content: '{"line":"wrong"}' },
      },
    ],
  });
  expect(parseLocalChatReply(TASK, text, 200)).toEqual({ ok: true, verdict: { line: "done" } });
  // A code fence around the JSON is read too
  expect(parseLocalChatReply(TASK, reply('```json\n{"line":"a"}\n```'), 200)).toEqual({ ok: true, verdict: { line: "a" } });
});

test("an answer that isn't JSON matching the schema is no verdict", () => {
  const noMatch = { ok: false, kind: "malformed", status: 200, message: LOCAL_NO_MATCHING_JSON };
  expect(parseLocalChatReply(TASK, reply("ログインのバリデーション修正完了"), 200)).toEqual(noMatch);
  expect(parseLocalChatReply(TASK, reply('{"summary":"a"}'), 200)).toEqual(noMatch);
  expect(parseLocalChatReply(TASK, reply('{"line":3}'), 200)).toEqual(noMatch);
  expect(parseLocalChatReply(TASK, reply('["a"]'), 200)).toEqual(noMatch);
  expect(parseLocalChatReply(TASK, reply(null), 200)).toEqual(noMatch);
  // Cut off partway
  const truncated = JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"line":"a"}' } }] });
  expect(parseLocalChatReply(TASK, truncated, 200)).toEqual(noMatch);
  // A body that isn't JSON at all is a broken reply, not a model answer
  expect(parseLocalChatReply(TASK, "<html>", 200)).toEqual({ ok: false, kind: "malformed", status: 200 });
});

test("an enum field must hold one of its values", () => {
  const task: JudgeTaskDefinition = {
    name: "t",
    systemPrompt: "",
    outputFields: { kind: { type: "string", description: "", enum: ["a", "b"] } },
  };
  expect(parseLocalChatReply(task, reply('{"kind":"a"}'), 200).ok).toBe(true);
  expect(parseLocalChatReply(task, reply('{"kind":"c"}'), 200).ok).toBe(false);
});

test("the saved choice is kept while it is set up; otherwise the first set up, with Local last", () => {
  const none = { anthropic: false, openai: false, local: false };
  expect(resolveAiProvider(undefined, none)).toBeUndefined();
  expect(resolveAiProvider("local", { ...none, local: true })).toBe("local");
  expect(resolveAiProvider(undefined, { ...none, local: true })).toBe("local");
  // Someone who used OpenAI keeps it after setting up Local, until they choose Local
  expect(resolveAiProvider("openai", { ...none, openai: true, local: true })).toBe("openai");
  expect(resolveAiProvider(undefined, { anthropic: true, openai: true, local: true })).toBe("anthropic");
  expect(resolveAiProvider("local", { ...none, openai: true })).toBe("openai");
  expect(anyAiProviderSetUp(none)).toBe(false);
  expect(anyAiProviderSetUp({ ...none, local: true })).toBe(true);
});

test("the concierge treats a local answer that doesn't match the schema as no advice", async () => {
  const payload = buildConciergePayload([], [], [], Date.now(), "ja");
  const noMatch = async <V>(): Promise<JudgeResult<V>> => ({
    ok: false,
    kind: "malformed",
    status: 200,
    message: LOCAL_NO_MATCHING_JSON,
  });
  expect(await askConcierge("local", payload, noMatch)).toEqual({ ok: true, verdict: null, noMatchingJson: true });
  // Other failures stay errors
  const network = async <V>(): Promise<JudgeResult<V>> => ({ ok: false, kind: "network", message: "refused" });
  expect(await askConcierge("local", payload, network)).toEqual({ ok: false, kind: "network", message: "refused" });
});

test("a base URL is accepted on the same terms as Rust's local_url", () => {
  expect(isValidBaseUrl("http://localhost:11434/v1")).toBe(true);
  expect(isValidBaseUrl(" https://192.168.1.5:1234/v1/ ")).toBe(true);
  expect(isValidBaseUrl("localhost:11434")).toBe(false);
  expect(isValidBaseUrl("file:///etc/passwd")).toBe(false);
  expect(isValidBaseUrl("http://user:secret@localhost:11434/v1")).toBe(false);
  expect(isValidBaseUrl("http://localhost:11434/v1?x=1")).toBe(false);
  expect(isValidBaseUrl("http://localhost:11434/v1?")).toBe(false);
  expect(isValidBaseUrl("http://localhost:11434/v1#x")).toBe(false);
});

test("the model after a list is read: kept when listed, a saved one kept as the first option, else the first", () => {
  const ids = ["qwen2.5:7b-instruct", "llama3.2:3b"];
  expect(pickLocalModel(ids, "llama3.2:3b", undefined)).toEqual({ options: ids, model: "llama3.2:3b" });
  // The saved model the server no longer lists isn't swapped silently
  expect(pickLocalModel(ids, "gone:1b", "gone:1b")).toEqual({ options: ["gone:1b", ...ids], model: "gone:1b" });
  // Another server's model, or nothing chosen yet, becomes the list's first
  expect(pickLocalModel(ids, "other-server:7b", undefined)).toEqual({ options: ids, model: "qwen2.5:7b-instruct" });
  expect(pickLocalModel(ids, "", "gone:1b")).toEqual({ options: ids, model: "qwen2.5:7b-instruct" });
});
