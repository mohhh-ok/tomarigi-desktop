// The adapters of docs/design.md "Agents": each format is read into the shared TailInfo, and deriveState gives the
// same states as for Claude Code. Fixtures follow each agent's source (Qwen Code, Copilot CLI, Gemini CLI; no
// install was available) or the shape of real files (OpenCode 1.19.0, cursor-agent 2025.09.18 / 2026.10.18), with made-up text
import { describe, expect, test } from "bun:test";
import { parseJsonl } from "../src/lib/agent-tail.ts";
import { deriveState } from "../src/lib/bird-state.ts";
import { parseQwenLines, parseQwenRuntime } from "../src/lib/qwen-transcript.ts";
import { parseCopilotLines } from "../src/lib/copilot-transcript.ts";
import { parseGeminiLines } from "../src/lib/gemini-transcript.ts";
import { parseOpenCodeMessages, type OpenCodeMessage } from "../src/lib/opencode-transcript.ts";
import { cursorProjectSlug, lineTimesOf, parseCursorLines } from "../src/lib/cursor-transcript.ts";
import { argvOf, matchSessionsToProcesses, programNamed } from "../src/lib/agent-processes.ts";
import { extractQuestion } from "../src/lib/session-snippet.ts";
import type { TailInfo } from "../src/lib/transcript.ts";

const T0 = Date.parse("2026-10-18T01:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const jsonl = (...lines: object[]) => parseJsonl(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
/** State as seen `idleSec` after the last write */
const stateOf = (tail: TailInfo, idleSec: number) => deriveState(tail, idleSec * 1000, false);
const MIN = 60;

describe("Qwen Code", () => {
  const base = { sessionId: "s-1", cwd: "/Users/me/app", version: "0.15.0" };
  const user = { ...base, uuid: "u1", parentUuid: null, timestamp: at(0), type: "user", message: { role: "user", parts: [{ text: "List the files" }] } };
  const call = { ...base, uuid: "u2", timestamp: at(3), type: "assistant", message: { role: "model", parts: [{ text: "I will list them." }, { functionCall: { id: "c1", name: "run_shell_command", args: { command: "ls" } } }] } };
  const result = { ...base, uuid: "u3", timestamp: at(4), type: "tool_result", message: { role: "user", parts: [{ functionResponse: { id: "c1", name: "run_shell_command", response: { output: "a.ts" } } }] }, toolCallResult: { callId: "c1", status: "success" } };
  const reply = { ...base, uuid: "u4", timestamp: at(6), type: "assistant", message: { role: "model", parts: [{ thought: true, text: "thinking" }, { text: "There is one file: a.ts." }] } };

  test("working while a tool runs, done after the reply, dozing after 5 minutes", () => {
    const running = parseQwenLines(jsonl(user, call));
    expect(running.kind).toBe("tool_use");
    expect(running.toolName).toBe("run_shell_command");
    expect(stateOf(running, 60)).toBe("working");
    expect(stateOf(parseQwenLines(jsonl(user, call, result)), 60)).toBe("working");

    const tail = parseQwenLines(jsonl(user, call, result, reply));
    expect(tail.cwd).toBe("/Users/me/app");
    expect(tail.lastEventAt).toBe(T0 + 6000);
    expect(tail.events[0]).toMatchObject({ kind: "user", text: "List the files" });
    expect(tail.events.at(-1)).toMatchObject({ kind: "assistant_text", text: "There is one file: a.ts." });
    expect(stateOf(tail, 10)).toBe("done");
    expect(stateOf(tail, 6 * MIN)).toBe("dozing");
  });

  test("a question to the user is needs reply; a cancelled turn ends", () => {
    const ask = { ...call, message: { role: "model", parts: [{ functionCall: { name: "ask_user_question", args: { questions: [{ question: "Which one?" }] } } }] } };
    const tail = parseQwenLines(jsonl(user, ask));
    expect(stateOf(tail, 60)).toBe("waiting");
    expect(extractQuestion(tail.events.at(-1)?.text)).toBe("Which one?");

    const cancelled = { ...base, uuid: "u5", timestamp: at(9), type: "system", subtype: "turn_result", systemPayload: { promptId: "p1", state: "cancelled", endedAt: T0 + 9000 } };
    expect(parseQwenLines(jsonl(user, call, cancelled)).kind).toBe("closed");
  });

  test("the runtime file gives the pid", () => {
    const text = JSON.stringify({ schema_version: 1, pid: 4242, session_id: "s-1", work_dir: "/Users/me/app", hostname: "h", started_at: 1, qwen_version: "0.15.0" });
    expect(parseQwenRuntime(text)).toEqual({ pid: 4242, sessionId: "s-1", workDir: "/Users/me/app" });
    expect(parseQwenRuntime("{")).toBeUndefined();
  });
});

describe("GitHub Copilot CLI", () => {
  const ev = (type: string, s: number, data: object, extra: object = {}) => ({ type, data, id: `e${s}`, timestamp: at(s), parentId: null, ...extra });
  const start = ev("session.start", 0, { sessionId: "8abb", version: 1, producer: "copilot-agent", copilotVersion: "1.0.65", startTime: at(0), context: { cwd: "/Users/me/app", branch: "main" } });
  const user = ev("user.message", 1, { content: "Fix the test", transformedContent: "<current_datetime>…</current_datetime>Fix the test" });
  const call = ev("assistant.message", 3, { messageId: "m1", content: "I'll run it.", toolRequests: [{ toolCallId: "t1", name: "bash", arguments: { command: "bun test" }, type: "function" }] });
  const startTool = ev("tool.execution_start", 3, { toolCallId: "t1", toolName: "bash", arguments: { command: "bun test" } });
  const endTool = ev("tool.execution_complete", 5, { toolCallId: "t1", success: true, result: { content: "ok" } });
  const reply = ev("assistant.message", 8, { messageId: "m2", content: "The test passes now.", toolRequests: [] });
  const turnEnd = ev("assistant.turn_end", 8, { turnId: "1" });

  test("working through the tools, done after the reply, cwd from session.start", () => {
    expect(stateOf(parseCopilotLines(jsonl(start, user, call, startTool)), 60)).toBe("working");
    expect(stateOf(parseCopilotLines(jsonl(start, user, call, startTool, endTool)), 60)).toBe("working");
    const tail = parseCopilotLines(jsonl(start, user, call, startTool, endTool, reply, turnEnd));
    expect(tail.cwd).toBe("/Users/me/app");
    expect(tail.events[0]).toMatchObject({ kind: "user", text: "Fix the test" });
    expect(tail.events.at(-1)).toMatchObject({ kind: "assistant_text", text: "The test passes now." });
    expect(tail.lastEventAt).toBe(T0 + 8000);
    expect(stateOf(tail, 10)).toBe("done");
    expect(stateOf(tail, 6 * MIN)).toBe("dozing");
  });

  test("the cwd of the first line is used when the window doesn't reach it; subagent events are ignored", () => {
    const sub = ev("tool.execution_start", 9, { toolCallId: "t9", toolName: "view" }, { agentId: "sub-1" });
    const tail = parseCopilotLines(jsonl(user, reply, sub), "/Users/me/app");
    expect(tail.cwd).toBe("/Users/me/app");
    expect(tail.kind).toBe("assistant_text");
  });

  test("ask_user is needs reply; abort and shutdown end the turn", () => {
    const ask = ev("tool.execution_start", 4, { toolCallId: "t2", toolName: "ask_user", arguments: { question: "Which branch?" } });
    const tail = parseCopilotLines(jsonl(start, user, ask));
    expect(stateOf(tail, 60)).toBe("waiting");
    expect(extractQuestion(tail.events.at(-1)?.text)).toBe("Which branch?");
    expect(parseCopilotLines(jsonl(start, user, ev("abort", 4, { reason: "user_initiated" }))).kind).toBe("closed");
    expect(parseCopilotLines(jsonl(start, user, reply, ev("session.shutdown", 20, { shutdownType: "routine" }))).kind).toBe("closed");
  });
});

describe("Gemini CLI", () => {
  const meta = { sessionId: "1b9d", projectHash: "7f3c", startTime: at(0), lastUpdated: at(0) };
  const user = { id: "m1", timestamp: at(1), type: "user", content: [{ text: "List the files" }] };
  const running = { id: "m2", timestamp: at(3), type: "gemini", content: "", toolCalls: [{ id: "c1", name: "run_shell_command", args: { command: "ls" }, status: "executing", timestamp: at(3) }] };
  const finished = { ...running, toolCalls: [{ ...running.toolCalls[0], status: "success", result: [{ functionResponse: { id: "c1" } }] }] };
  const reply = { id: "m3", timestamp: at(5), type: "gemini", content: "There are two files.", model: "gemini-2.5-pro" };

  test("a message re-appended with its tool result replaces the first copy; done after the reply", () => {
    const working = parseGeminiLines(jsonl(meta, user, running), "/Users/me/app");
    expect(working.kind).toBe("tool_use");
    expect(stateOf(working, 60)).toBe("working");
    const afterTool = parseGeminiLines(jsonl(meta, user, running, { $set: { lastUpdated: at(4) } }, finished));
    expect(afterTool.kind).toBe("tool_result");
    expect(afterTool.events.filter((e) => e.kind === "tool_use")).toHaveLength(1);

    const tail = parseGeminiLines(jsonl(meta, user, running, finished, reply, { $set: { lastUpdated: at(5) } }), "/Users/me/app");
    expect(tail.cwd).toBe("/Users/me/app");
    expect(tail.events[0]).toMatchObject({ kind: "user", text: "List the files" });
    expect(tail.events.at(-1)).toMatchObject({ kind: "assistant_text", text: "There are two files." });
    expect(stateOf(tail, 10)).toBe("done");
    expect(stateOf(tail, 6 * MIN)).toBe("dozing");
  });

  test("$rewindTo drops the message and everything after it; $patch edits a message", () => {
    const rewound = parseGeminiLines(jsonl(meta, user, finished, reply, { $rewindTo: "m2" }));
    expect(rewound.events.map((e) => e.kind)).toEqual(["user"]);
    const patched = parseGeminiLines(jsonl(meta, user, reply, { $patch: { updates: [{ id: "m3", content: "Patched." }] } }));
    expect(patched.events.at(-1)?.text).toBe("Patched.");
  });

  test("ask_user is needs reply", () => {
    const ask = { id: "m4", timestamp: at(6), type: "gemini", content: "", toolCalls: [{ id: "a1", name: "ask_user", args: { questions: [{ question: "Which file?" }] }, status: "executing", timestamp: at(6) }] };
    const tail = parseGeminiLines(jsonl(meta, user, ask));
    expect(stateOf(tail, 60)).toBe("waiting");
    expect(extractQuestion(tail.events.at(-1)?.text)).toBe("Which file?");
  });
});

describe("OpenCode", () => {
  const session = { id: "ses_a", directory: "/Users/me/app", parentId: null, timeCreated: T0, lastWriteAt: T0 + 9000 };
  const user: OpenCodeMessage = {
    id: "msg_1", timeCreated: T0, timeUpdated: T0,
    data: { role: "user", time: { created: T0 } },
    parts: [{ type: "text", text: { head: "Rename the file", tail: "Rename the file" } }],
  };
  const tools: OpenCodeMessage = {
    id: "msg_2", timeCreated: T0 + 1000, timeUpdated: T0 + 3000,
    data: { role: "assistant", finish: "tool-calls", time: { created: T0 + 1000, completed: T0 + 3000 } },
    parts: [{ type: "step-start" }, { type: "tool", tool: "bash", status: "completed", input: '{"command":"mv a b"}', time: { start: T0 + 1500, end: T0 + 2500 } }, { type: "step-finish" }],
  };
  const streaming: OpenCodeMessage = {
    id: "msg_3", timeCreated: T0 + 4000, timeUpdated: T0 + 4000,
    data: { role: "assistant", time: { created: T0 + 4000 } },
    parts: [{ type: "step-start" }],
  };
  const reply: OpenCodeMessage = {
    ...streaming,
    data: { role: "assistant", finish: "stop", time: { created: T0 + 4000, completed: T0 + 9000 } },
    parts: [{ type: "step-start" }, { type: "text", text: { head: "Renamed.", tail: "Renamed a to b." } }, { type: "step-finish" }],
  };

  test("working until the reply finishes with stop, then done and dozing", () => {
    expect(stateOf(parseOpenCodeMessages([user], session), 60)).toBe("working");
    expect(stateOf(parseOpenCodeMessages([user, tools, streaming], session), 60)).toBe("working");
    const tail = parseOpenCodeMessages([user, tools, reply], session);
    expect(tail.cwd).toBe("/Users/me/app");
    expect(tail.lastEventAt).toBe(T0 + 9000);
    expect(tail.events[0]).toMatchObject({ kind: "user", text: "Rename the file" });
    expect(tail.events.at(-1)).toMatchObject({ kind: "assistant_text", text: "Renamed a to b." });
    expect(stateOf(tail, 10)).toBe("done");
    expect(stateOf(tail, 6 * MIN)).toBe("dozing");
  });

  test("a running question is needs reply; an aborted message ends the turn", () => {
    const asking: OpenCodeMessage = {
      ...streaming,
      parts: [{ type: "tool", tool: "question", status: "running", input: '{"questions":[{"question":"Keep the old name?","header":"h","options":[]}]}', time: { start: T0 + 4500 } }],
    };
    const tail = parseOpenCodeMessages([user, asking], session);
    expect(stateOf(tail, 60)).toBe("waiting");
    expect(extractQuestion(tail.events.at(-1)?.text)).toBe("Keep the old name?");
    const aborted: OpenCodeMessage = { ...streaming, data: { role: "assistant", error: "MessageAbortedError", time: { created: T0 + 4000, completed: T0 + 5000 } } };
    expect(parseOpenCodeMessages([user, aborted], session).kind).toBe("closed");
    // A provider error ends the turn: done, not interrupted
    const failed: OpenCodeMessage = { ...streaming, data: { role: "assistant", error: "APIError", time: { created: T0 + 4000, completed: T0 + 5000 } } };
    expect(stateOf(parseOpenCodeMessages([user, failed], session), 10)).toBe("done");
  });
});

describe("Cursor CLI", () => {
  const user = { role: "user", message: { content: [{ type: "text", text: "Search the docs" }] } };
  const call = { role: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { search_term: "x" } }] } };
  const reply = { role: "assistant", message: { content: [{ type: "text", text: "Here is what I found." }] } };
  const ended = { type: "turn_ended", status: "success" };

  test("lines get the mtime of the read that first saw them; done once the turn ended", () => {
    const path = "/tmp/cursor-fixture.jsonl";
    const first = jsonl(user, call);
    const firstSize = first.at(-1)!.end;
    const working = parseCursorLines(first, lineTimesOf(path, firstSize, T0), "/Users/me/app");
    expect(working.kind).toBe("tool_use");
    expect(working.lastEventAt).toBe(T0);
    expect(stateOf(working, 60)).toBe("working");

    const all = jsonl(user, call, reply, ended);
    const tail = parseCursorLines(all, lineTimesOf(path, all.at(-1)!.end, T0 + 7000), "/Users/me/app");
    expect(tail.events.map((e) => e.at)).toEqual([T0, T0, T0 + 7000]);
    expect(tail.cwd).toBe("/Users/me/app");
    expect(tail.events.at(-1)).toMatchObject({ kind: "assistant_text", text: "Here is what I found." });
    expect(tail.lastEventAt).toBe(T0 + 7000);
    expect(stateOf(tail, 10)).toBe("done");
    expect(stateOf(tail, 6 * MIN)).toBe("dozing");
  });

  test("2026.10.18: the prompt is wrapped in <user_query>, and hidden reasoning after the reply is not shown", () => {
    // Shape measured with cursor-agent 2026.10.18 (one turn: two tool calls in one line, then the reply)
    const prompt = { role: "user", message: { content: [{ type: "text", text: "<timestamp>Tuesday, Oct 20, 2026, 8:59 AM (UTC+9)</timestamp>\n<user_query>\nFix the build\n</user_query>" }] } };
    const calls = {
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me look at the workspace.\n\n[REDACTED]" },
          { type: "tool_use", name: "Glob", input: { glob_pattern: "**/*", target_directory: "/Users/me/app" } },
          { type: "tool_use", name: "Grep", input: { pattern: ".", glob: "README*", path: "/Users/me/app", head_limit: 5 } },
        ],
      },
    };
    const answer = { role: "assistant", message: { content: [{ type: "text", text: "Which build do you mean?\n\n[REDACTED]" }] } };
    const path = "/tmp/cursor-fixture-2026.jsonl";

    const first = jsonl(prompt, calls);
    const working = parseCursorLines(first, lineTimesOf(path, first.at(-1)!.end, T0), "/Users/me/app");
    expect(working.events[0]).toMatchObject({ kind: "user", text: "Fix the build" });
    expect(working).toMatchObject({ kind: "tool_use", toolName: "Grep" });
    expect(stateOf(working, 60)).toBe("working");

    const all = jsonl(prompt, calls, answer, ended);
    const tail = parseCursorLines(all, lineTimesOf(path, all.at(-1)!.end, T0 + 9000), "/Users/me/app");
    expect(tail.events.at(-1)).toMatchObject({ kind: "assistant_text", text: "Which build do you mean?" });
    expect(stateOf(tail, 10)).toBe("done");

    // Reasoning that is not hidden stays; only a `[REDACTED]` paragraph is dropped
    const noted = { role: "assistant", message: { content: [{ type: "text", text: "Done.\n\n[REDACTED] was in the log" }] } };
    expect(parseCursorLines(jsonl(prompt, noted), () => T0).events.at(-1)).toMatchObject({ text: "Done.\n\n[REDACTED] was in the log" });
  });

  test("the project folder name is the cwd with each run of non-alphanumeric characters as one -", () => {
    expect(cursorProjectSlug("/Users/me/Dev/yokai-no-sensei")).toBe("Users-me-Dev-yokai-no-sensei");
    expect(cursorProjectSlug("/var/folders/jw/x_y/T/abc.d")).toBe("var-folders-jw-x-y-T-abc-d");
    expect(cursorProjectSlug("/Users/me/.config/my - app_")).toBe("Users-me-config-my-app");
  });
});

describe("process matching (sessions of agents without a pid file)", () => {
  const proc = (pid: number, startedAt: number, cwd = "/w/a") => ({ pid, startedAt, cwd, key: cwd });
  const session = (id: string, writtenAt: number, key = "/w/a") => ({ id, key, writtenAt });

  test("one process: the session written last since it started is alive and gets its pid", () => {
    const m = matchSessionsToProcesses([session("old", 500), session("a", 2_000), session("b", 3_000)], [proc(7, 1_000_000 - 999_000)]);
    expect([...m]).toEqual([["b", { pid: 7, cwd: "/w/a" }]]);
  });

  test("a session last written before the process started is not alive (a new process that wrote nothing yet)", () => {
    expect(matchSessionsToProcesses([session("yesterday", 1_000)], [proc(7, 100_000)]).size).toBe(0);
  });

  test("N processes in a cwd: the N sessions written last are alive; only the newest gets the newest process", () => {
    const m = matchSessionsToProcesses(
      [session("s1", 20_000), session("s2", 30_000), session("s3", 40_000), session("other", 50_000, "/w/b")],
      [proc(1, 10_000), proc(2, 15_000)],
    );
    expect([...m.keys()].sort()).toEqual(["s2", "s3"]);
    expect(m.get("s3")?.pid).toBe(2);
    expect(m.get("s2")?.pid).toBeUndefined();
  });

  test("processes in other folders don't count", () => {
    expect(matchSessionsToProcesses([session("s", 20_000)], [proc(1, 10_000, "/w/b")]).size).toBe(0);
  });

  test("an agent's process is recognised as a binary or as a script run by node", () => {
    const gemini = programNamed("gemini");
    expect(gemini(argvOf("/opt/homebrew/bin/gemini"))).toBe(true);
    expect(gemini(argvOf("node --no-warnings /opt/homebrew/bin/gemini -m pro"))).toBe(true);
    expect(gemini(argvOf("vim gemini"))).toBe(false);
    expect(programNamed("opencode")(argvOf("claude look at opencode"))).toBe(false);
  });

  test("Windows paths are read with backslashes and without .exe", () => {
    expect(programNamed("opencode")(argvOf("C:\\Users\\me\\bin\\opencode.exe run"))).toBe(true);
    expect(programNamed("gemini")(argvOf("C:\\nodejs\\node.exe C:\\npm\\gemini"))).toBe(true);
    expect(programNamed("copilot")(argvOf('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Jane Doe\\npm\\copilot"'))).toBe(true);
  });
});
