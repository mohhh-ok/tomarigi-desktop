// Trial: the turn verdict built from facts about the reply (lib/turn-facts.ts). The table that turns the facts into
// asking / continuing, one row per kind of reply in docs/design.md "Turn verdicts"
import { expect, test } from "bun:test";
import { parseTurnFacts, TURN_FACTS_TASK, verdictFromFacts, type TurnFacts } from "../src/lib/turn-facts.ts";
import { verdictSchema } from "../src/lib/judge.ts";

const none: TurnFacts = {
  question: "none",
  question_ready: true,
  own_job_running: false,
  work_under_way: false,
  will_report_later: false,
  abusive: false,
  line: "done",
};

const rows: { name: string; facts: Partial<TurnFacts>; asking: boolean; continuing: boolean }[] = [
  { name: "a report of finished work", facts: {}, asking: false, continuing: false },
  { name: "asks for approval (yokai_17_ok, desk_two_decisions)", facts: { question: "for_this_agent" }, asking: true, continuing: false },
  {
    name: "asks to pick candidates that come later, and will show them (yokai_photo_later)",
    facts: { question: "for_this_agent", question_ready: false, work_under_way: true, will_report_later: true },
    asking: false,
    continuing: true,
  },
  {
    name: "relays another session's question, next to other sessions' status (yokai_relay_r2)",
    facts: { question: "for_another_session", work_under_way: true },
    asking: false,
    continuing: false,
  },
  {
    name: "relays a question while its own tests run (yokai_relay_own_tests)",
    facts: { question: "for_another_session", own_job_running: true, work_under_way: true },
    asking: false,
    continuing: true,
  },
  {
    name: "relays a question and will pass on another session's report (yokai_relay_will_report)",
    facts: { question: "for_another_session", work_under_way: true, will_report_later: true },
    asking: false,
    continuing: true,
  },
  {
    name: "only says the child still works (desk_child_c9)",
    facts: { work_under_way: true },
    asking: false,
    continuing: false,
  },
  {
    name: "asks for approval and will tell when the approved work is done (yokai_17_ok)",
    facts: { question: "for_this_agent", will_report_later: true },
    asking: true,
    continuing: false,
  },
  {
    name: "handed work off and will show the result (tomarigi_advice_links, bc_prerelease_later)",
    facts: { work_under_way: true, will_report_later: true },
    asking: false,
    continuing: true,
  },
  {
    name: "asks while its own job runs",
    facts: { question: "for_this_agent", own_job_running: true, work_under_way: true },
    asking: true,
    continuing: true,
  },
];

for (const row of rows) {
  test(`facts → verdict: ${row.name}`, () => {
    const v = verdictFromFacts({ ...none, ...row.facts });
    expect({ asking: v.asking, continuing: v.continuing }).toEqual({ asking: row.asking, continuing: row.continuing });
  });
}

test("the line is trimmed and abusive is passed through", () => {
  expect(verdictFromFacts({ ...none, line: " A or B? ", abusive: true })).toEqual({
    line: "A or B?",
    asking: false,
    abusive: true,
    continuing: false,
  });
});

test("facts that don't match the schema are rejected", () => {
  expect(parseTurnFacts(none)).toEqual(none);
  expect(parseTurnFacts({ ...none, question: "maybe" })).toBeUndefined();
  expect(parseTurnFacts({ ...none, own_job_running: "yes" })).toBeUndefined();
  expect(parseTurnFacts({ ...none, line: 1 })).toBeUndefined();
  expect(parseTurnFacts(null)).toBeUndefined();
});

test("the schema asks for every fact, with question as an enum", () => {
  const { properties, required } = verdictSchema(TURN_FACTS_TASK);
  expect(required).toEqual([
    "question",
    "question_ready",
    "own_job_running",
    "work_under_way",
    "will_report_later",
    "abusive",
    "line",
  ]);
  expect((properties.question as { enum: string[] }).enum).toEqual(["none", "for_this_agent", "for_another_session"]);
});
