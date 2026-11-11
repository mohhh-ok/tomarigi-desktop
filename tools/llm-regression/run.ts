// LLM regression test: runs the turn verdict and the concierge on the scenes of cases.ts with real models, each scene
// RUNS times per provider, and prints the pass rate per scene and provider (docs/design.md "Turn verdicts", "LLM
// regression test"). The requests are the app's own: summarizeTurn / turnPayload (src/lib/summarize.ts) and
// askConcierge / buildConciergePayload (src/lib/concierge.ts), through judgeRunnerFor (src/lib/ai-judge.ts). Only the
// transport differs (fetch with keys from the environment instead of Rust; transport.ts).
//
// usage: bun run test:llm [--providers openai,anthropic,local] [--runs 8] [--cases a,b] [--min-pass 0.75]
//          [--baseline <earlier result json>] [--label <name>] [--dry-run]
// Env: OPENAI_API_KEY, ANTHROPIC_API_KEY, LOCAL_BASE_URL (default http://localhost:11434/v1), LOCAL_MODEL
// (default qwen2.5:14b-instruct), OUT (default /tmp/tomarigi-desktop/llm). The same options can be given as
// LLM_PROVIDERS, LLM_RUNS, LLM_CASES, LLM_MIN_PASS, LLM_BASELINE, LLM_LABEL.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { judgeRunnerFor, type JudgeRunner } from "../../src/lib/ai-judge.ts";
import { DEFAULT_LOCAL_BASE_URL, type AiProvider } from "../../src/lib/api-keys.ts";
import { askConcierge, buildConciergePayload, CONCIERGE_TASK, CONCIERGE_TASK_WITH_SUGGESTIONS } from "../../src/lib/concierge.ts";
import { anthropicJudgeBody } from "../../src/lib/judge.ts";
import { openAiJudgeBody } from "../../src/lib/openai-judge.ts";
import { SUMMARIZE_TURN_TASK, summarizeTurn, turnPayload } from "../../src/lib/summarize.ts";
import { CASES, CASE_NOW, type Case } from "./cases.ts";
import { fetchTransport, localModels } from "./transport.ts";

const { values: args } = parseArgs({
  options: {
    providers: { type: "string" },
    runs: { type: "string" },
    cases: { type: "string" },
    "min-pass": { type: "string" },
    baseline: { type: "string" },
    label: { type: "string" },
    "dry-run": { type: "boolean" },
  },
});

const PROVIDERS = ["openai", "anthropic", "local"] as const;
const list = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));
const Options = z.object({
  providers: list.pipe(z.array(z.enum(PROVIDERS))).optional(),
  runs: z.coerce.number().int().min(1).max(50).default(8),
  cases: list.optional(),
  minPass: z.coerce.number().min(0).max(1).default(0.75),
  baseline: z.string().optional(),
  label: z.string().regex(/^[\w.-]+$/).default(new Date().toISOString().replace(/[:.]/g, "-")),
  dryRun: z.boolean().default(false),
  openaiKey: z.string().regex(/^sk-/, "OPENAI_API_KEY doesn't start with sk-").optional(),
  anthropicKey: z.string().regex(/^sk-ant-/, "ANTHROPIC_API_KEY doesn't start with sk-ant-").optional(),
  localBaseUrl: z.url().default(DEFAULT_LOCAL_BASE_URL),
  localModel: z.string().min(1).default("qwen2.5:14b-instruct"),
  out: z.string().default("/tmp/tomarigi-desktop/llm"),
});
const env = process.env;
const blank = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : v.trim());
const opts = Options.parse({
  providers: args.providers ?? blank(env.LLM_PROVIDERS),
  runs: args.runs ?? blank(env.LLM_RUNS),
  cases: args.cases ?? blank(env.LLM_CASES),
  minPass: args["min-pass"] ?? blank(env.LLM_MIN_PASS),
  baseline: args.baseline ?? blank(env.LLM_BASELINE),
  label: args.label ?? blank(env.LLM_LABEL),
  dryRun: args["dry-run"] ?? false,
  openaiKey: blank(env.OPENAI_API_KEY),
  anthropicKey: blank(env.ANTHROPIC_API_KEY),
  localBaseUrl: blank(env.LOCAL_BASE_URL),
  localModel: blank(env.LOCAL_MODEL),
  out: blank(env.OUT),
});

const unknownCases = (opts.cases ?? []).filter((n) => !CASES.some((c) => c.name === n));
if (unknownCases.length) throw new Error(`unknown cases: ${unknownCases.join(", ")}`);
const cases = CASES.filter((c) => !opts.cases || opts.cases.includes(c.name));

/** Which providers run, and why the others don't. By default every provider that can run */
async function pickProviders(): Promise<{ run: AiProvider[]; skipped: Record<string, string> }> {
  const asked = opts.providers ?? [...PROVIDERS];
  const run: AiProvider[] = [];
  const skipped: Record<string, string> = {};
  for (const p of asked) {
    if (p === "openai" && !opts.openaiKey) skipped[p] = "no OPENAI_API_KEY";
    else if (p === "anthropic" && !opts.anthropicKey) skipped[p] = "no ANTHROPIC_API_KEY";
    else if (p === "local") {
      const models = await localModels(opts.localBaseUrl);
      if (!models.ok) skipped[p] = models.reason;
      else if (!models.ids.includes(opts.localModel)) skipped[p] = `${opts.localModel} is not on ${opts.localBaseUrl}`;
      else if (memoryPressure() >= 2) skipped[p] = "memory pressure is at warning or above";
      else run.push(p);
    } else run.push(p);
  }
  return { run, skipped };
}

/** kern.memorystatus_vm_pressure_level (1 normal, 2 warning, 4 critical); 1 where it can't be read */
function memoryPressure(): number {
  try {
    return Number(execFileSync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { encoding: "utf8" }).trim()) || 1;
  } catch {
    return 1;
  }
}

/** The request one run of a case makes, and how its answer is judged */
interface Run {
  /** The request body as sent to OpenAI and Anthropic, for the dry run's size */
  bodies: () => unknown[];
  /** undefined when the answer passes, otherwise why not, and the answer in one line */
  once: (runner: JudgeRunner, provider: AiProvider) => Promise<{ fail?: string; line: string; usage?: { input: number; output: number } }>;
}

function runOf(c: Case): Run {
  if (c.kind === "turn") {
    const payload = turnPayload("ja", c.reply, c.user ?? []);
    return {
      bodies: () => [openAiJudgeBody(SUMMARIZE_TURN_TASK, payload), anthropicJudgeBody(SUMMARIZE_TURN_TASK, payload)],
      async once(runner, provider) {
        const r = await summarizeTurn(provider, payload, runner);
        if (!r.ok) return { fail: `error ${r.kind} ${r.status ?? ""} ${r.message ?? ""}`.trim(), line: "ERR" };
        const v = r.verdict;
        const line = `asking=${v.asking} continuing=${v.continuing} abusive=${v.abusive} ${v.line}`;
        const wrong = (Object.keys(c.want) as (keyof typeof c.want)[]).filter((k) => v[k] !== c.want[k]).map((k) => `${k}=${v[k]}`);
        if (c.lineMustNot?.test(v.line)) wrong.push("line");
        return { ...(wrong.length && { fail: wrong.join(" ") }), line, usage: r.usage };
      },
    };
  }
  const payload = buildConciergePayload(c.sessions, c.events ?? [], [], CASE_NOW, "ja");
  const task = c.withSuggestions ? CONCIERGE_TASK_WITH_SUGGESTIONS : CONCIERGE_TASK;
  return {
    bodies: () => [openAiJudgeBody(task, payload), anthropicJudgeBody(task, payload)],
    async once(runner, provider) {
      const r = await askConcierge(provider, payload, runner, c.withSuggestions);
      if (!r.ok) return { fail: `error ${r.kind} ${r.status ?? ""} ${r.message ?? ""}`.trim(), line: "ERR" };
      const shown = (r.suggestions ?? []).map((s) => `${s.kind}:${s.sessionId} ${s.text}`);
      const line = `advice=${r.verdict ? `${r.action}:${r.verdict.targetId ?? "?"} ${r.verdict.line}` : "-"} | ${shown.join(" | ")}`;
      const fail = c.check(r);
      return { ...(fail && { fail }), line, usage: r.usage };
    },
  };
}

/** A scene's own runs and pass rate win over the options when stricter (a misjudgment that comes now and then) */
const runsOf = (c: Case) => Math.max(c.runs ?? 0, opts.runs);
const minPassOf = (c: Case) => Math.max(c.minPass ?? 0, opts.minPass);

/** A rough token count: about 4 Latin characters or 1 Japanese character per token */
function roughTokens(body: unknown): number {
  const s = JSON.stringify(body);
  let ascii = 0;
  for (const ch of s) if (ch.charCodeAt(0) < 128) ascii++;
  return Math.round(ascii / 4 + (s.length - ascii));
}

const { run: providers, skipped } = await pickProviders();
for (const [p, why] of Object.entries(skipped)) console.log(`${p}: not run (${why})`);

if (opts.dryRun) {
  for (const p of providers) {
    let input = 0;
    let requests = 0;
    for (const c of cases) {
      input += roughTokens(runOf(c).bodies()[p === "anthropic" ? 1 : 0]) * runsOf(c);
      requests += runsOf(c);
    }
    console.log(
      `${p}: ${cases.length} cases, ${requests} requests, about ${input} input tokens ` +
        `(rough; output is at most 256-512 tokens a request)`,
    );
  }
  process.exit(0);
}

interface Row {
  case: string;
  provider: AiProvider;
  passed: number;
  runs: number;
  lines: string[];
  usage: { input: number; output: number };
}

async function runProvider(provider: AiProvider): Promise<Row[]> {
  const runner = judgeRunnerFor(
    provider,
    fetchTransport({ openai: opts.openaiKey, anthropic: opts.anthropicKey }),
    { baseUrl: opts.localBaseUrl, model: opts.localModel },
  );
  const rows: Row[] = [];
  for (const c of cases) {
    const run = runOf(c);
    const runs = runsOf(c);
    const row: Row = { case: c.name, provider, passed: 0, runs, lines: [], usage: { input: 0, output: 0 } };
    for (let i = 0; i < runs; i++) {
      try {
        const r = await run.once(runner, provider);
        if (!r.fail) row.passed++;
        row.lines.push(`${r.fail ? `NG(${r.fail})` : "OK"} ${r.line}`);
        if (r.usage) {
          row.usage.input += r.usage.input;
          row.usage.output += r.usage.output;
        }
      } catch (e) {
        row.lines.push(`NG(thrown ${(e as Error).message.slice(0, 120)})`);
      }
    }
    const firstNg = row.lines.find((l) => l.startsWith("NG"));
    console.log(`${new Date().toISOString()} ${provider} ${c.name} ${row.passed}/${row.runs}${firstNg ? ` first: ${firstNg.slice(0, 160)}` : ""}`);
    rows.push(row);
  }
  return rows;
}

const rows = (await Promise.all(providers.map(runProvider))).flat();

type Saved = { label: string; skipped: Record<string, string>; rows: Row[] };
const baseline: Saved | undefined = opts.baseline ? JSON.parse(readFileSync(opts.baseline, "utf8")) : undefined;
const before = (c: string, p: string) => baseline?.rows.find((r) => r.case === c && r.provider === p);

// The table: one row per case, one column per provider asked for, "passed/runs" (and the baseline's before it)
const columns = opts.providers ?? [...PROVIDERS];
const lines = [`| case | ${columns.join(" | ")} |`, `|---|${columns.map(() => "---").join("|")}|`];
const problems: string[] = [];
if (providers.length === 0) problems.push("no provider ran");
// A provider the baseline has but this run doesn't: the change isn't checked on it
for (const p of new Set(baseline?.rows.map((r) => r.provider) ?? [])) {
  if (!providers.includes(p)) problems.push(`${p}: in the baseline but not run (${skipped[p] ?? "not asked for"})`);
}
for (const c of cases) {
  const cells = columns.map((p) => {
    const r = rows.find((x) => x.case === c.name && x.provider === p);
    if (!r) return "not run";
    const b = before(c.name, p);
    const rate = r.passed / r.runs;
    if (rate < minPassOf(c)) problems.push(`${p} ${c.name}: ${r.passed}/${r.runs} is under ${minPassOf(c)}`);
    if (b && rate < b.passed / b.runs) problems.push(`${p} ${c.name}: fell from ${b.passed}/${b.runs} to ${r.passed}/${r.runs}`);
    return b ? `${b.passed}/${b.runs} → ${r.passed}/${r.runs}` : `${r.passed}/${r.runs}`;
  });
  lines.push(`| ${c.name} | ${cells.join(" | ")} |`);
}
console.log(`\n${lines.join("\n")}\n`);
for (const p of providers) {
  const u = rows.filter((r) => r.provider === p).reduce((a, r) => ({ input: a.input + r.usage.input, output: a.output + r.usage.output }), { input: 0, output: 0 });
  console.log(`${p}: ${u.input} input tokens, ${u.output} output tokens`);
}
for (const p of problems) console.log(`NG ${p}`);

mkdirSync(opts.out, { recursive: true });
const file = `${opts.out}/llm-regression-${opts.label}.json`;
writeFileSync(file, JSON.stringify({ label: opts.label, skipped, rows } satisfies Saved, null, 1));
console.log(`every answer: ${file}`);
process.exit(problems.length ? 1 : 0);
