// The verdict layer of each summary provider, picked in one place (summaries, the readout, the concierge)
import { loadLocalAiConfig, type AiProvider } from "./api-keys";
import { JUDGE_MODEL, runJudge, type JudgeResult, type JudgeTaskDefinition } from "./judge";
import { runLocalJudge } from "./local-judge";
import { OPENAI_JUDGE_MODEL, runOpenAiJudge } from "./openai-judge";

export type JudgeRunner = <V>(task: JudgeTaskDefinition, payload: unknown) => Promise<JudgeResult<V>>;

export function judgeRunnerFor(provider: AiProvider): JudgeRunner {
  if (provider === "openai") return runOpenAiJudge;
  if (provider === "local") return (task, payload) => runLocalJudge(task, payload);
  return runJudge;
}

/** The model a provider's verdicts come from, for the app log. Local's is the saved one ("-" when not set up) */
export async function judgeModelFor(provider: AiProvider): Promise<string> {
  if (provider === "openai") return OPENAI_JUDGE_MODEL;
  if (provider === "local") return (await loadLocalAiConfig())?.model ?? "-";
  return JUDGE_MODEL;
}
