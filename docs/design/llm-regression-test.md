# LLM regression test

The turn verdicts and the concierge are checked with real models by a regression test, so a change to a prompt is
checked against every scene fixed before (the user: 「こういうの回帰がはっせいするから、llm用のてすとをかいてほしい」).
Before, each fix was measured with a probe on replies in local transcripts, so the scenes of earlier fixes weren't kept
anywhere they could be run again. That probe (`tools/turn-verdict-probe.ts`, named in the measurements in "Turn
verdicts") was replaced by this test (Claude's own decision). Usage is in tools/README.md ("llm-regression/")

- Scenes: a table in the repo (`tools/llm-regression/cases.ts`). Each turn scene stands for a reply that a verdict got
  wrong or that a fix was measured against, with the turn's user messages and the asking / continuing / abusive it
  should get; each concierge scene is the facts the app sends (as SessionView) and a check on the answer. Inputs are
  fixed in the table, never read from a local transcript or log at run time (the user: 「ろーかるのtranscriptつかうんじゃないで。こていするんやで」)
  - A scene keeps only the shape of the real reply that decides the verdict (a report or a question, who answers
    where, whether something waits, whether work goes on); what the work was about (features, issue numbers, files,
    amounts, counts, session names) is made up, so nothing of another project is in this public repo (the user:
    「ローカルのtranscriptから、プロジェクト固有の情報を書き換えて、プライバシーを守るようにしろよ」). Each new table is
    checked for privacy by subagents, twice (the user: 「サブエージェントでの二重チェックするようにしろプライバシーチェックは」).
    The same holds for everything put in this repo, not only these scenes: tests (their names and data), docs, code
    comments, and commit messages. None of them names another repository, project, client or product, or a person, or
    copies a text or an id from another transcript; a scene that reproduces a report uses names with nothing in them
    (app-x, the parent session). Each change is checked so by subagents, twice, before it is committed (the user's
    decision)
  - A field a scene doesn't settle is left out and not checked. The relay that asks the user to type an approval in a
    child's pane checks only continuing: Haiku says asking there, and making it not asking was tried and not adopted
    (see "Turn verdicts"). `two_decisions` checks only asking: its continuing comes from the watch link in the app
    (see "Turn verdicts")
  - A scene can also check that the speech bubble line doesn't match a pattern (a question or a wait the reply doesn't
    have), and can ask for more runs and a higher pass rate than the defaults, for a misjudgment that comes only now
    and then (`runs`, `minPass`, `lineMustNot`; Claude's own decision). The two reports ending with commits not
    pushed yet run 32 times each and must pass every time, and the report with the agent's own decision and a child still working runs 16 times, its line checked for a question, a check, or a wait on the user (Claude's own decisions; see "Turn verdicts")
- Requests: the app's own functions (`summarizeTurn` / `turnPayload`, `askConcierge` / `buildConciergePayload`, through
  `judgeRunnerFor`), so the prompts, schemas, models, bodies, the reading of answers, and the checks after the answer
  are the app's. Only the transport differs: the runners take a `JudgeTransport`; the app's is Rust (keys stay in
  Rust, never in the WebView's JS), the test's posts the same bodies with fetch to the URLs, headers, and timeouts of
  `src-tauri/src/keys.rs`, with keys from the environment, checked with zod at start. Those values are copied in
  `tools/llm-regression/transport.ts`, and `tests/llm-transport.test.ts` checks they match keys.rs
- Providers: OpenAI, Anthropic, and Local, each with the same table, since the providers behave differently (the user:
  「anthropic,openaiでもきょどうがかわるし」). By default every provider that can run: a key for OpenAI and Anthropic;
  for Local, a server with the model, and memory pressure below warning (Claude's own decision: loading a local model
  raised memory pressure to warning before). One that can't is shown as not run with why
- Each scene runs N times (default 8) per provider, since answers vary; the result is the pass rate per scene and
  provider. A scene under the minimum rate (default 0.75) or below the baseline (the result before the change) is NG,
  and so is a run where no provider ran or a provider in the baseline didn't run. A prompt change is done only when no
  provider's rate fell (Claude's own decisions: 8 runs and 0.75)
- When it runs: not every time, only for a change that can change its results (the user: 「このてすとをきどうするのは、このテストの結果が変わりうる時ということにしておいて」).
  That is found, not listed: `bun run test:llm:needed` follows every top-level declaration the test reaches from its own
  files through the TypeScript checker into src/ (the prompts, schemas, models and provider calls, the payload
  builders, the checks after the answer such as dropReason, the scenes), and says run when a change since what has
  been pushed (the merge base with the branch's upstream, or origin/main) touches one of them, or touches
  `src-tauri/src/keys.rs`. A function added on that path is picked up without a list to update (Claude's own
  decision). The rest of the app's path (reading transcripts into a reply and user messages, the scheduler) isn't in
  the test, since the test's inputs are fixed at that point
