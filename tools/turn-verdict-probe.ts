// Runs the turn verdict (src/lib/summarize.ts) on real replies several times with OpenAI and Anthropic, with the same
// prompt, schema, models, and settings as the app (src/lib/openai-judge.ts, src/lib/judge.ts), and counts asking and
// continuing. Used to check a change to the prompt before and after (docs/design.md "Turn verdicts").
// usage: OPENAI_API_KEY=… ANTHROPIC_API_KEY=… bun tools/turn-verdict-probe.ts <cases.json> <label> [runs = 8]
// Env: PROVIDERS (default "openai,anthropic"), CASES (comma-separated case names to run), OUT (default /tmp/tomarigi-desktop)
import { readFileSync } from "node:fs";
import { SUMMARIZE_TURN_TASK, turnPayload } from "../src/lib/summarize.ts";
import { JUDGE_MODEL, verdictSchema } from "../src/lib/judge.ts";
import { OPENAI_JUDGE_MODEL } from "../src/lib/openai-judge.ts";

/** One case: a reply in a local transcript, found by its file and timestamp, and what the verdict should be */
interface Case {
  name: string;
  want_asking: boolean;
  want_continuing: boolean;
  file: string;
  ts: string;
  /** The user's messages of that turn, as the app sends them (turnUserMessages in src/lib/session-tail.ts) */
  user?: string[];
}

const [casesPath, label, runsArg] = process.argv.slice(2);
if (!casesPath || !label) throw new Error("usage: bun tools/turn-verdict-probe.ts <cases.json> <label> [runs]");
const runs = Number(runsArg ?? 8);
const only = process.env.CASES?.split(",");
const providers = (process.env.PROVIDERS ?? "openai,anthropic").split(",");
const outDir = process.env.OUT ?? "/tmp/tomarigi-desktop";
const cases = (JSON.parse(readFileSync(casesPath, "utf8")) as Case[]).filter((c) => !only || only.includes(c.name));
const task = SUMMARIZE_TURN_TASK;

/** The reply's text as the app takes it: the text blocks of the assistant line, last 2000 characters (turnPayload) */
function replyText(c: Case): string {
  for (const line of readFileSync(c.file.replace(/^~/, process.env.HOME ?? ""), "utf8").split("\n")) {
    if (!line.includes(c.ts)) continue;
    const e = JSON.parse(line);
    if (e.timestamp !== c.ts || e.type !== "assistant") continue;
    return (e.message.content as { type: string; text?: string }[])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");
  }
  throw new Error(`${c.name}: no assistant line at ${c.ts} in ${c.file}`);
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${d?.error?.message ?? ""}`);
  return d;
}

async function openai(payload: unknown): Promise<any> {
  const d = await post("https://api.openai.com/v1/responses", { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, {
    model: OPENAI_JUDGE_MODEL,
    store: false,
    instructions: task.systemPrompt,
    input: JSON.stringify(payload),
    max_output_tokens: task.maxTokens ?? 512,
    reasoning: { effort: "none" },
    text: {
      format: {
        type: "json_schema",
        name: task.name,
        strict: true,
        schema: { type: "object", ...verdictSchema(task), additionalProperties: false },
      },
    },
  });
  const text = d.output
    ?.flatMap((o: any) => o.content ?? [])
    .find((c: any) => c.type === "output_text")?.text;
  return JSON.parse(text);
}

async function anthropic(payload: unknown): Promise<any> {
  const d = await post(
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
    {
      model: JUDGE_MODEL,
      max_tokens: task.maxTokens ?? 256,
      system: task.systemPrompt,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
      tools: [
        {
          name: task.name,
          description: `Return a structured verdict for the "${task.name}" judging task.`,
          input_schema: { type: "object", ...verdictSchema(task) },
        },
      ],
      tool_choice: { type: "tool", name: task.name },
    },
  );
  return d.content.find((c: any) => c.type === "tool_use").input;
}

const callers: Record<string, (payload: unknown) => Promise<any>> = { openai, anthropic };
const rows: unknown[] = [];
for (const provider of providers) {
  const call = callers[provider];
  if (!call) throw new Error(`unknown provider ${provider}`);
  for (const c of cases) {
    const payload = turnPayload("ja", replyText(c), c.user ?? []);
    let asking = 0;
    let continuing = 0;
    let errors = 0;
    const lines: string[] = [];
    for (let i = 0; i < runs; i++) {
      try {
        const v = await call(payload);
        if (v.asking) asking++;
        if (v.continuing) continuing++;
        lines.push(`${v.asking ? "A" : "-"}${v.continuing ? "C" : "-"} ${v.line}`);
      } catch (e) {
        errors++;
        lines.push(`ERR ${(e as Error).message.slice(0, 120)}`);
      }
    }
    rows.push({ label, provider, case: c.name, want_asking: c.want_asking, want_continuing: c.want_continuing, asking, continuing, errors, runs, lines });
    console.log(
      `${new Date().toISOString()} ${label} ${provider} ${c.name} want_asking=${c.want_asking} asking=${asking}/${runs} ` +
        `want_continuing=${c.want_continuing} continuing=${continuing}/${runs} errors=${errors}`,
    );
  }
}
await Bun.write(`${outDir}/turn-verdict-${label}.json`, JSON.stringify(rows, null, 1));
