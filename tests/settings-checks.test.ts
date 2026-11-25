// The rules shared by the settings screen and the AI agent's tools (lib/settings-checks.ts; docs/design.md "Settings by
// an AI agent (MCP)")
import { expect, test } from "bun:test";
import {
  checkLocalAi,
  checkLocalTts,
  checkNewRoot,
  checkOption,
  checkProviderChoice,
  checkRootLabel,
  checkRootRemovable,
  checkTypedRootPath,
  checkVoiceInList,
  checkVolume,
} from "../src/lib/settings-checks";

test("Local AI: the URL first, then the model", () => {
  expect(checkLocalAi({ baseUrl: "http://localhost:11434/v1", model: "qwen3" })).toBeUndefined();
  expect(checkLocalAi({ baseUrl: "localhost:11434", model: "qwen3" })).toBe("url-invalid");
  expect(checkLocalAi({ baseUrl: "localhost:11434", model: "" })).toBe("url-invalid");
  expect(checkLocalAi({ baseUrl: "http://localhost:11434/v1", model: "  " })).toBe("model-missing");
});

test("a local TTS server: the model only for OpenAI-compatible, then the voice", () => {
  expect(checkLocalTts({ kind: "voicevox", baseUrl: "http://localhost:50021", voice: "2" })).toBeUndefined();
  expect(checkLocalTts({ kind: "voicevox", baseUrl: "http://localhost:50021", voice: "" })).toBe("voice-missing");
  expect(checkLocalTts({ kind: "openai", baseUrl: "http://localhost:8880/v1", voice: "af_heart" })).toBe(
    "tts-model-missing",
  );
  expect(
    checkLocalTts({ kind: "openai", baseUrl: "http://localhost:8880/v1", voice: "af_heart", model: "kokoro" }),
  ).toBeUndefined();
  expect(checkLocalTts({ kind: "openai", baseUrl: "ftp://x", voice: "", model: "" })).toBe("url-invalid");
});

test("a voice must be in the server's list when the list was read", () => {
  expect(checkVoiceInList("2", ["2", "3"])).toBeUndefined();
  expect(checkVoiceInList("99", ["2", "3"])).toBe("no-voice");
  expect(checkVoiceInList("99", undefined)).toBeUndefined();
});

test("the summary provider needs its key, or Local set up", () => {
  const setUp = { anthropic: false, openai: true, local: false };
  expect(checkProviderChoice("openai", setUp)).toBeUndefined();
  expect(checkProviderChoice("anthropic", setUp)).toBe("no-key");
  expect(checkProviderChoice("local", setUp)).toBe("local-not-set-up");
});

test("a volume is an integer percent", () => {
  expect(checkVolume(0)).toBeUndefined();
  expect(checkVolume(100)).toBeUndefined();
  expect(checkVolume(101)).toBe("volume-range");
  expect(checkVolume(-1)).toBe("volume-range");
  expect(checkVolume(50.5)).toBe("volume-range");
});

test("a new watched folder: absolute with no .., not watched yet", () => {
  const existing = [{ path: "/Users/x/.claude/projects" }];
  expect(checkNewRoot(existing, "/Users/x/work/.claude/projects")).toBeUndefined();
  expect(checkNewRoot(existing, "~/work")).toBe("path-not-absolute");
  expect(checkNewRoot(existing, "/Users/x/work/../.claude/projects")).toBe("path-not-absolute");
  expect(checkNewRoot(existing, "/Users/x/.claude/projects/")).toBe("duplicate");
  expect(checkNewRoot([{ path: "C:\\Users\\x\\.codex" }], "C:/Users/x/.codex")).toBe("duplicate");
});

test("a path the agent types: no network path, which Windows would reach just to read it", () => {
  expect(checkTypedRootPath("\\\\server\\share")).toBe("network-path");
  expect(checkTypedRootPath("//server/share")).toBe("network-path");
  expect(checkTypedRootPath("/Users/x/work")).toBeUndefined();
  expect(checkTypedRootPath("C:\\Users\\x")).toBeUndefined();
});

test("labels, default folders and choices", () => {
  expect(checkRootLabel(" ")).toBe("label-empty");
  expect(checkRootLabel("Work")).toBeUndefined();
  expect(checkRootRemovable({ builtin: true })).toBe("builtin");
  expect(checkRootRemovable({ builtin: false })).toBeUndefined();
  expect(checkOption("cat", ["birds", "cat"])).toBeUndefined();
  expect(checkOption("dog", ["birds", "cat"])).toBe("unknown-option");
  expect(checkOption(3, ["birds"])).toBe("unknown-option");
});
