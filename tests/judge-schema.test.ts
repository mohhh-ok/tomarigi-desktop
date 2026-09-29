// The verdict schema shared by the Anthropic tool input_schema (lib/judge.ts) and the OpenAI Structured Outputs schema
// (lib/openai-judge.ts)
import { expect, test } from "bun:test";
import { verdictSchema } from "../src/lib/judge.ts";

test("properties keep the field order; required defaults to every field", () => {
  const schema = verdictSchema({
    name: "t",
    systemPrompt: "",
    outputFields: {
      summary: { type: "string", description: "s" },
      mood: { type: "string", description: "m", enum: ["calm", "busy"] },
      ok: { type: "boolean", description: "o" },
    },
  });
  expect(JSON.stringify(schema)).toBe(
    JSON.stringify({
      properties: {
        summary: { type: "string", description: "s" },
        mood: { type: "string", description: "m", enum: ["calm", "busy"] },
        ok: { type: "boolean", description: "o" },
      },
      required: ["summary", "mood", "ok"],
    }),
  );
});

test("requiredFields overrides required", () => {
  const schema = verdictSchema({
    name: "t",
    systemPrompt: "",
    outputFields: { a: { type: "number", description: "a" }, b: { type: "number", description: "b" } },
    requiredFields: ["b"],
  });
  expect(schema.required).toEqual(["b"]);
});
