// The AI agent's settings tools (lib/agent-tools.ts; docs/design.md "Settings by an AI agent (MCP)") with fake save,
// list and test functions: a valid change saves once and says what changed; a wrong value is refused with the screen's
// English message and saves nothing; keys are never part of an answer
import { describe, expect, test } from "bun:test";
import { AGENT_TOOLS, runAgentTool, type AgentToolDeps, type SettingsSnapshot } from "../src/lib/agent-tools";
import en from "../public/_locales/en/messages.json";

function snapshot(over: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    aiProvider: "openai",
    keySaved: { anthropic: false, openai: true },
    localAi: null,
    readoutVoice: { source: "system" },
    chirps: true,
    chirpVolume: 1,
    readAloud: false,
    readAloudVolume: 0.5,
    windowMode: "floating",
    conciergeLook: "owl",
    iconSets: [{ slug: "-Users-x-app", name: "app", running: true, set: "birds" }],
    folders: [
      { id: "default:claude", agent: "claude", label: "Claude Code", path: "/Users/x/.claude/projects", builtin: true, readable: true },
      { id: "f1", agent: "claude", label: "Work", path: "/Users/x/.claude-work/projects", builtin: false, readable: true },
    ],
    port: 4844,
    ...over,
  };
}

const VOICEVOX_VOICES = [
  { value: "2", label: "四国めたん（ノーマル）", speaker: "四国めたん" },
  { value: "3", label: "ずんだもん（ノーマル）", speaker: "ずんだもん" },
];

function fakes(state: SettingsSnapshot = snapshot()) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const rec =
    (fn: string, ret?: unknown) =>
    (...args: unknown[]) => {
      calls.push({ fn, args });
      return ret as never;
    };
  const deps: AgentToolDeps = {
    snapshot: () => state,
    selectAiProvider: rec("selectAiProvider", Promise.resolve()),
    saveLocalAi: rec("saveLocalAi", Promise.resolve()),
    removeLocalAi: rec("removeLocalAi", Promise.resolve()),
    setReadoutSource: rec("setReadoutSource"),
    saveLocalTts: rec("saveLocalTts"),
    setChirps: rec("setChirps"),
    setChirpVolume: rec("setChirpVolume"),
    setReadAloud: rec("setReadAloud"),
    setReadAloudVolume: rec("setReadAloudVolume"),
    setWindowMode: rec("setWindowMode", Promise.resolve()),
    assignIconSet: rec("assignIconSet"),
    setConciergeLook: rec("setConciergeLook"),
    addFolder: async (agent, path, label) => {
      calls.push({ fn: "addFolder", args: [agent, path, label] });
      return path === "/missing" ? "not-readable" : { id: "new1", label: label ?? "Codex" };
    },
    removeFolder: async (id) => {
      calls.push({ fn: "removeFolder", args: [id] });
      return id === "default:claude" ? "builtin" : undefined;
    },
    renameFolder: async (id, label) => {
      calls.push({ fn: "renameFolder", args: [id, label] });
      return label.trim() === "" ? "label-empty" : undefined;
    },
    fetchLocalModels: async () => ["qwen3", "gemma3"],
    fetchTtsVoices: async (kind) => (kind === "voicevox" ? VOICEVOX_VOICES : undefined),
    fetchTtsModels: async () => undefined,
    fetchIsVoicevoxEngine: async () => true,
    testLocalAi: async () => ({ ok: false, kind: "network" }),
    testCloudAi: async () => ({ ok: true, verdict: {} }),
    playSample: async (config) => (config.voice === "2" ? { ok: true, ms: 1234 } : { ok: false, error: "audio" }),
    say: (key, subs) => `<${key}${subs ? ` ${subs}` : ""}>`,
    now: (() => {
      let t = 0;
      return () => (t += 500);
    })(),
  };
  const saved = () => calls.filter((c) => !c.fn.startsWith("fetch"));
  return { deps, calls, saved };
}

test("every tool has a name, an English description and an object schema", () => {
  const names = AGENT_TOOLS.map((t) => t.name);
  expect(new Set(names).size).toBe(names.length);
  for (const tool of AGENT_TOOLS) {
    expect(tool.description.length).toBeGreaterThan(10);
    expect(tool.inputSchema.type).toBe("object");
  }
});

describe("get_settings", () => {
  test("lists values and choices; keys only as saved or not", async () => {
    const { deps } = fakes();
    const r = await runAgentTool("get_settings", {}, deps);
    expect(r.ok).toBe(true);
    const data = r.data as Record<string, any>;
    expect(data.summary_provider).toEqual({
      value: "openai",
      choices: ["anthropic", "openai", "local"],
      api_key_saved: { anthropic: false, openai: true },
      local_set_up: false,
    });
    expect(data.sound.read_aloud_volume).toBe(50);
    expect(data.watched_folders.folders).toHaveLength(2);
    expect(r.text).not.toMatch(/sk-|api_key"\s*:\s*"/);
    expect(r.changes).toEqual([]);
  });
});

describe("summary provider", () => {
  test("one with a saved key is chosen and noted", async () => {
    const { deps, saved } = fakes(snapshot({ keySaved: { anthropic: true, openai: true } }));
    const r = await runAgentTool("set_summary_provider", { provider: "anthropic" }, deps);
    expect(r.ok).toBe(true);
    expect(saved()).toEqual([{ fn: "selectAiProvider", args: ["anthropic"] }]);
    expect(r.changes).toEqual([{ setting: "<agentNoteSummaryProvider>", from: "OpenAI", to: "Anthropic" }]);
  });

  test("one without a key says to paste it on the settings screen, and saves nothing", async () => {
    const { deps, saved } = fakes();
    const r = await runAgentTool("set_summary_provider", { provider: "anthropic" }, deps);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("settings");
    expect(r.text).toContain("paste");
    expect(saved()).toEqual([]);
  });
});

describe("Local AI", () => {
  test("a malformed URL is refused with the screen's message", async () => {
    const { deps, saved } = fakes();
    const r = await runAgentTool("set_local_ai", { base_url: "localhost:11434", model: "qwen3" }, deps);
    expect(r).toEqual({ ok: false, text: en.localAiUrlInvalid.message, changes: [] });
    expect(saved()).toEqual([]);
  });

  test("a valid one is saved trimmed", async () => {
    const { deps, saved } = fakes();
    const r = await runAgentTool("set_local_ai", { base_url: " http://localhost:11434/v1 ", model: "qwen3" }, deps);
    expect(r.ok).toBe(true);
    expect(saved()).toEqual([{ fn: "saveLocalAi", args: [{ baseUrl: "http://localhost:11434/v1", model: "qwen3" }] }]);
  });

  test("the connection test says the screen's reason and the time", async () => {
    const { deps } = fakes();
    const r = await runAgentTool("test_ai_connection", { provider: "local", base_url: "http://localhost:1/v1", model: "m" }, deps);
    expect(r.ok).toBe(false);
    expect(r.text).toBe(en.localAiTestUnreachable.message);
    expect(r.data).toEqual({ passed: false, reason: "network", ms: 500 });
  });

  test("the saved key's test passes", async () => {
    const { deps } = fakes();
    const r = await runAgentTool("test_ai_connection", { provider: "openai" }, deps);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ passed: true, ms: 500 });
  });

  test("the models are listed", async () => {
    const { deps } = fakes();
    const r = await runAgentTool("list_local_ai_models", { base_url: "http://localhost:11434/v1" }, deps);
    expect(r.data).toEqual({ models: ["qwen3", "gemma3"] });
  });
});

describe("readout voice", () => {
  const server = { kind: "voicevox", base_url: "http://localhost:50021", voice: "2" };

  test("a VOICEVOX server is saved as the card saves it: label, speaker and credit from the server", async () => {
    const { deps, saved } = fakes();
    const r = await runAgentTool("set_readout_voice", { source: "local", server }, deps);
    expect(r.ok).toBe(true);
    expect(saved()).toEqual([
      {
        fn: "saveLocalTts",
        args: [
          {
            kind: "voicevox",
            baseUrl: "http://localhost:50021",
            voice: "2",
            voiceLabel: "四国めたん（ノーマル）",
            speaker: "四国めたん",
            voicevoxCredit: true,
          },
        ],
      },
    ]);
    expect(r.changes).toEqual([
      { setting: "<readoutVoiceLabel>", from: "<readoutVoiceSystem>", to: "<readoutKindVoicevox>: 四国めたん（ノーマル）" },
    ]);
  });

  test("the voice may be given by its label", async () => {
    const { deps, calls } = fakes();
    await runAgentTool("set_readout_voice", { source: "local", server: { ...server, voice: "ずんだもん（ノーマル）" } }, deps);
    expect((calls.find((c) => c.fn === "saveLocalTts")!.args[0] as { voice: string }).voice).toBe("3");
  });

  test("an unknown voice is refused with the screen's reason", async () => {
    const { deps, saved } = fakes();
    const r = await runAgentTool("set_readout_voice", { source: "local", server: { ...server, voice: "99" } }, deps);
    expect(r).toEqual({ ok: false, text: en.readoutTestNoVoice.message, changes: [] });
    expect(saved()).toEqual([]);
  });

  test("an OpenAI-compatible server without a model is refused", async () => {
    const { deps } = fakes();
    const r = await runAgentTool(
      "set_readout_voice",
      { source: "local", server: { kind: "openai", base_url: "http://localhost:8880/v1", voice: "af_heart" } },
      deps,
    );
    expect(r.text).toBe(en.readoutNeedsModel.message);
  });

  test("the sample answers the time, or why it didn't play", async () => {
    const { deps } = fakes();
    const played = await runAgentTool("play_readout_sample", { server }, deps);
    expect(played).toMatchObject({ ok: true, data: { played: true, ms: 1234 } });
    const silent = await runAgentTool("play_readout_sample", { server: { ...server, voice: "3" } }, deps);
    expect(silent.ok).toBe(false);
    expect(silent.text).toContain(en.readoutTestAudio.message);
  });

  test("local without a saved server asks for one", async () => {
    const { deps, saved } = fakes();
    const r = await runAgentTool("set_readout_voice", { source: "local" }, deps);
    expect(r.ok).toBe(false);
    expect(saved()).toEqual([]);
  });
});

describe("sound, window, look, icon sets", () => {
  test("volumes are percent and checked before anything is saved", async () => {
    const { deps, saved } = fakes();
    const bad = await runAgentTool("set_sound", { read_aloud: true, read_aloud_volume: 150 }, deps);
    expect(bad.ok).toBe(false);
    expect(saved()).toEqual([]);
    const ok = await runAgentTool("set_sound", { read_aloud: true, read_aloud_volume: 80 }, deps);
    expect(saved()).toEqual([
      { fn: "setReadAloud", args: [true] },
      { fn: "setReadAloudVolume", args: [0.8] },
    ]);
    expect(ok.changes.map((c) => [c.from, c.to])).toEqual([
      ["<agentNoteOff>", "<agentNoteOn>"],
      ["50%", "80%"],
    ]);
  });

  test("a value outside the choices is refused", async () => {
    const { deps, saved } = fakes();
    expect((await runAgentTool("set_window_mode", { mode: "tiny" }, deps)).ok).toBe(false);
    expect((await runAgentTool("set_concierge_look", { look: "cat" }, deps)).ok).toBe(false);
    expect((await runAgentTool("set_icon_set", { project: "app", set: "dog" }, deps)).ok).toBe(false);
    expect(saved()).toEqual([]);
  });

  test("an icon set is set by the project's name", async () => {
    const { deps, saved } = fakes();
    const r = await runAgentTool("set_icon_set", { project: "app", set: "cat" }, deps);
    expect(r.ok).toBe(true);
    expect(saved()).toEqual([{ fn: "assignIconSet", args: ["-Users-x-app", "app", "cat"] }]);
  });
});

describe("watched folders", () => {
  test("added, renamed and removed through the shared operations", async () => {
    const { deps, saved } = fakes();
    const added = await runAgentTool("add_watched_folder", { agent: "codex", path: "/Users/x/.codex-2" }, deps);
    expect(added).toMatchObject({ ok: true, data: { id: "new1" } });
    expect((await runAgentTool("rename_watched_folder", { id: "f1", label: "Job" }, deps)).ok).toBe(true);
    expect((await runAgentTool("remove_watched_folder", { id: "f1" }, deps)).ok).toBe(true);
    expect(saved().map((c) => c.fn)).toEqual(["addFolder", "renameFolder", "removeFolder"]);
  });

  test("refusals say why", async () => {
    const { deps } = fakes();
    expect((await runAgentTool("add_watched_folder", { agent: "codex", path: "/missing" }, deps)).text).toContain(
      "can't be read",
    );
    expect((await runAgentTool("remove_watched_folder", { id: "default:claude" }, deps)).text).toContain("default");
    expect((await runAgentTool("rename_watched_folder", { id: "f1", label: " " }, deps)).ok).toBe(false);
    expect((await runAgentTool("remove_watched_folder", { id: "nope" }, deps)).ok).toBe(false);
    expect((await runAgentTool("add_watched_folder", { agent: "nobody", path: "/x" }, deps)).ok).toBe(false);
  });
});
