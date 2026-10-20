// The verdict layer of each summary provider, picked in one place (summaries, the readout, the concierge)
import type { AiProvider } from "./api-keys";
import { runJudge, type JudgeResult, type JudgeTaskDefinition } from "./judge";
import { runLocalJudge } from "./local-judge";
import { runOpenAiJudge } from "./openai-judge";

export type JudgeRunner = <V>(task: JudgeTaskDefinition, payload: unknown) => Promise<JudgeResult<V>>;

export function judgeRunnerFor(provider: AiProvider): JudgeRunner {
  if (provider === "openai") return runOpenAiJudge;
  if (provider === "local") return (task, payload) => runLocalJudge(task, payload);
  return runJudge;
}
