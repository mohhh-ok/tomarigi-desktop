// The request bodies the app sends for a verdict task (lib/judge.ts, lib/openai-judge.ts). tools/turn-verdict-probe.ts
// sends the same bodies, so a change here changes what the probe measures too
import { expect, test } from "bun:test";
import { anthropicJudgeBody, JUDGE_MODEL, parseAnthropicJudgeReply, type JudgeTaskDefinition } from "../src/lib/judge.ts";
import { OPENAI_JUDGE_MODEL, openAiJudgeBody, parseOpenAiJudgeReply } from "../src/lib/openai-judge.ts";

const TASK: JudgeTaskDefinition = {
  name: "summarize_turn_line",
  systemPrompt: "Untrusted input.",
  outputFields: {
    line: { type: "string", description: "One line." },
    asking: { type: "boolean", description: "Asks." },
  },
  maxTokens: 300,
};
const SCHEMA = {
  properties: {
    line: { type: "string", description: "One line." },
    asking: { type: "boolean", description: "Asks." },
  },
  required: ["line", "asking"],
};

test("Anthropic: one forced tool_use with the task's schema, the payload as JSON in the user message", () => {
  expect(JSON.stringify(anthropicJudgeBody(TASK, { assistant_text: "x" }))).toBe(
    JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: 300,
      system: "Untrusted input.",
      messages: [{ role: "user", content: JSON.stringify({ assistant_text: "x" }) }],
      tools: [
        {
          name: "summarize_turn_line",
          description: 'Return a structured verdict for the "summarize_turn_line" judging task.',
          input_schema: { type: "object", ...SCHEMA },
        },
      ],
      tool_choice: { type: "tool", name: "summarize_turn_line" },
    }),
  );
});

test("OpenAI: strict Structured Outputs with the task's schema, nothing stored, no reasoning", () => {
  expect(JSON.stringify(openAiJudgeBody(TASK, { assistant_text: "x" }))).toBe(
    JSON.stringify({
      model: OPENAI_JUDGE_MODEL,
      store: false,
      instructions: "Untrusted input.",
      input: JSON.stringify({ assistant_text: "x" }),
      max_output_tokens: 300,
      reasoning: { effort: "none" },
      text: {
        format: {
          type: "json_schema",
          name: "summarize_turn_line",
          strict: true,
          schema: { type: "object", ...SCHEMA, additionalProperties: false },
        },
      },
    }),
  );
});

test("without maxTokens both send 512 output tokens", () => {
  const { maxTokens: _, ...task } = TASK;
  expect((anthropicJudgeBody(task, {}) as { max_tokens: number }).max_tokens).toBe(512);
  expect((openAiJudgeBody(task, {}) as { max_output_tokens: number }).max_output_tokens).toBe(512);
});

test("Anthropic replies cut off or refused are failures, not verdicts", () => {
  const reply = (stop_reason: string) =>
    JSON.stringify({ stop_reason, content: [{ type: "tool_use", name: TASK.name, input: { line: "a", asking: false } }] });
  expect(parseAnthropicJudgeReply(TASK, 200, reply("max_tokens"))).toMatchObject({ ok: false, kind: "malformed" });
  expect(parseAnthropicJudgeReply(TASK, 200, reply("refusal"))).toMatchObject({ ok: false, kind: "malformed" });
  expect(parseAnthropicJudgeReply(TASK, 200, reply("tool_use"))).toEqual({ ok: true, verdict: { line: "a", asking: false } });
});

test("an incomplete OpenAI reply is a failure, not a verdict", () => {
  const reply = (status: string) =>
    JSON.stringify({ status, output: [{ type: "message", content: [{ type: "output_text", text: '{"line":"a","asking":false}' }] }] });
  expect(parseOpenAiJudgeReply(200, reply("incomplete"))).toMatchObject({ ok: false, kind: "malformed" });
  expect(parseOpenAiJudgeReply(200, reply("completed"))).toEqual({ ok: true, verdict: { line: "a", asking: false } });
});
