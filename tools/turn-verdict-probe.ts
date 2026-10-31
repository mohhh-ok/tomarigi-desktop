// Runs the turn verdict (src/lib/summarize.ts) on real replies several times with OpenAI and Anthropic, sending the
// app's own request bodies and reading the replies the app's way (src/lib/openai-judge.ts, src/lib/judge.ts), and counts
// asking and continuing. A reply the app would treat as a failure (cut off, refused) counts as ERR. Used to check a
// change to the prompt before and after (docs/design.md "Turn verdicts").
// usage: OPENAI_API_KEY=… ANTHROPIC_API_KEY=… bun tools/turn-verdict-probe.ts <cases.json> <label> [runs = 8]
// Env: PROVIDERS (default "openai,anthropic"), CASES (comma-separated case names to run), OUT (default /tmp/tomarigi-desktop),
// METHOD ("direct", the default: the app's SUMMARIZE_TURN_TASK; "facts": TURN_FACTS_TASK and verdictFromFacts in
// src/lib/turn-facts.ts), LOCAL_BASE_URL (default http://localhost:11434/v1) and LOCAL_MODEL (default qwen2.5:14b-instruct)
// for PROVIDERS=local
import { readFileSync } from "node:fs";
import { SUMMARIZE_TURN_TASK, turnPayload, type TurnVerdict } from "../src/lib/summarize.ts";
import { parseTurnFacts, TURN_FACTS_TASK, verdictFromFacts } from "../src/lib/turn-facts.ts";
import { anthropicJudgeBody, parseAnthropicJudgeReply, type JudgeResult } from "../src/lib/judge.ts";
import { openAiJudgeBody, parseOpenAiJudgeReply } from "../src/lib/openai-judge.ts";
import { localChatBody, parseLocalChatReply } from "../src/lib/local-judge.ts";

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
const method = process.env.METHOD ?? "direct";
if (method !== "direct" && method !== "facts") throw new Error(`unknown METHOD ${method}`);
const task = method === "facts" ? TURN_FACTS_TASK : SUMMARIZE_TURN_TASK;

/** The verdict from the answer: as it is (direct), or built from the facts (facts). Facts off the schema throw */
function verdictOf(answer: any): TurnVerdict & { facts?: string } {
  if (method === "direct") return answer;
  const facts = parseTurnFacts(answer);
  if (!facts) throw new Error(`facts don't match the schema: ${JSON.stringify(answer).slice(0, 80)}`);
  const f = facts;
  return {
    ...verdictFromFacts(f),
    facts: `q=${f.question} ready=${+f.question_ready} own=${+f.own_job_running} underway=${+f.work_under_way} report=${+f.will_report_later}`,
  };
}

/** The reply's text as the app takes it: the text blocks of the assistant line (turnPayload keeps the last 2000 characters) */
function replyText(c: Case): string {
  for (const line of readFileSync(c.file.replace(/^~/, process.env.HOME ?? ""), "utf8").split("\n")) {
    if (!line.includes(c.ts)) continue;
    const e = JSON.parse(line);
    if (e.timestamp !== c.ts || e.type !== "assistant") continue;
    const text = (e.message.content as { type: string; text?: string }[])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");
    if (!text) throw new Error(`${c.name}: the assistant line at ${c.ts} has no text`);
    return text;
  }
  throw new Error(`${c.name}: no assistant line at ${c.ts} in ${c.file}`);
}

/** Sends the body and returns the HTTP status and raw body, as Rust's openai_responses / anthropic_messages do */
async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 30_000,
): Promise<{ status: number; text: string }> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: r.status, text: await r.text() };
}

async function openai(payload: unknown): Promise<JudgeResult<any>> {
  const { status, text } = await post(
    "https://api.openai.com/v1/responses",
    { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    openAiJudgeBody(task, payload),
  );
  return parseOpenAiJudgeReply(status, text);
}

async function anthropic(payload: unknown): Promise<JudgeResult<any>> {
  const { status, text } = await post(
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
    anthropicJudgeBody(task, payload),
  );
  return parseAnthropicJudgeReply(task, status, text);
}

/** The app's local_chat: Chat Completions on an OpenAI-compatible server, with the app's 90-second timeout */
async function local(payload: unknown): Promise<JudgeResult<any>> {
  const base = (process.env.LOCAL_BASE_URL ?? "http://localhost:11434/v1").replace(/\/$/, "");
  const model = process.env.LOCAL_MODEL ?? "qwen2.5:14b-instruct";
  const { status, text } = await post(`${base}/chat/completions`, {}, localChatBody(task, payload, model), 90_000);
  if (status < 200 || status >= 300) return { ok: false, kind: "server", status, message: text.slice(0, 120) };
  return parseLocalChatReply(task, text, status);
}

const callers: Record<string, (payload: unknown) => Promise<JudgeResult<any>>> = { openai, anthropic, local };
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
        const r = await call(payload);
        if (!r.ok) throw new Error(`${r.kind} ${r.status ?? ""} ${r.message ?? ""}`);
        const v = verdictOf(r.verdict);
        if (v.asking) asking++;
        if (v.continuing) continuing++;
        lines.push(`${v.asking ? "A" : "-"}${v.continuing ? "C" : "-"} ${v.facts ? `[${v.facts}] ` : ""}${v.line}`);
      } catch (e) {
        errors++;
        lines.push(`ERR ${(e as Error).message.slice(0, 120)}`);
      }
    }
    rows.push({ label, method, provider, case: c.name, want_asking: c.want_asking, want_continuing: c.want_continuing, asking, continuing, errors, runs, lines });
    console.log(
      `${new Date().toISOString()} ${label} ${provider} ${c.name} want_asking=${c.want_asking} asking=${asking}/${runs} ` +
        `want_continuing=${c.want_continuing} continuing=${continuing}/${runs} errors=${errors}`,
    );
  }
}
await Bun.write(`${outDir}/turn-verdict-${label}.json`, JSON.stringify(rows, null, 1));
