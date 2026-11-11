// The verdict layer of each summary provider, picked in one place (summaries, the readout, the concierge)
import { loadLocalAiConfig, type AiProvider, type LocalAiConfig } from "./api-keys";
import {
  JUDGE_MODEL,
  runJudge,
  TAURI_TRANSPORT,
  type JudgeResult,
  type JudgeTaskDefinition,
  type JudgeTransport,
} from "./judge";
import { runLocalJudge } from "./local-judge";
import { OPENAI_JUDGE_MODEL, runOpenAiJudge } from "./openai-judge";

export type JudgeRunner = <V>(task: JudgeTaskDefinition, payload: unknown) => Promise<JudgeResult<V>>;

/** The runner of a provider. The app uses Rust and the saved Local settings; the LLM regression test
 * (tools/llm-regression) passes its own transport and Local settings */
export function judgeRunnerFor(
  provider: AiProvider,
  transport: JudgeTransport = TAURI_TRANSPORT,
  localConfig?: LocalAiConfig,
): JudgeRunner {
  if (provider === "openai") return (task, payload) => runOpenAiJudge(task, payload, transport);
  if (provider === "local") return (task, payload) => runLocalJudge(task, payload, localConfig, transport);
  return (task, payload) => runJudge(task, payload, transport);
}

/** The model a provider's verdicts come from, for the app log. Local's is the saved one ("-" when not set up) */
export async function judgeModelFor(provider: AiProvider): Promise<string> {
  if (provider === "openai") return OPENAI_JUDGE_MODEL;
  if (provider === "local") return (await loadLocalAiConfig())?.model ?? "-";
  return JUDGE_MODEL;
}
