// The tools an AI agent calls through the MCP server (src-tauri/src/mcp.rs) to read and change the settings
// (docs/design.md "Settings by an AI agent (MCP)"). One tool per card of the settings screen. Every change goes through
// the screen's own checks (lib/settings-checks.ts) and save functions, passed in as `deps` so tests use fakes. Tool
// texts are English (agents read them); `changes` are said in the UI language for the note in the app
import type { MessageName } from "./i18n";
import type { AiProvider, ApiKeyProvider, LocalAiConfig } from "./api-keys";
import type { JudgeResult } from "./judge";
import type { LocalTtsConfig, ReadoutVoice, TtsKind } from "./readout-voice";
import type { ReadoutTestResult } from "./voice";
import { classifyTestError, type TtsVoiceOption } from "./tts-server";
import { AGENTS, type AgentKind } from "./agents";
import { ICON_SET_IDS, type IconSetId } from "./icon-set-store";
import { CONCIERGE_LOOKS, type ConciergeLook } from "./concierge";
import {
  AI_TEST_FAILURE_MESSAGE,
  checkAgentServerUrl,
  checkLocalAi,
  checkLocalTts,
  checkOption,
  checkProviderChoice,
  checkVoiceInList,
  checkVolume,
  problemText,
  TTS_TEST_FAILURE_MESSAGE,
  type SettingsProblem,
} from "./settings-checks";
import { englishText } from "./i18n";
import { WINDOW_MODES, type WindowMode } from "./window-mode";


export interface SettingsSnapshot {
  aiProvider: AiProvider | null;
  keySaved: Record<ApiKeyProvider, boolean>;
  localAi: LocalAiConfig | null;
  readoutVoice: ReadoutVoice;
  chirps: boolean;
  /** 0–1, as saved */
  chirpVolume: number;
  readAloud: boolean;
  readAloudVolume: number;
  windowMode: WindowMode;
  conciergeLook: ConciergeLook;
  iconSets: { slug: string; name: string; running: boolean; set: IconSetId }[];
  folders: { id: string; agent: AgentKind; label: string; path: string; builtin: boolean; readable: boolean }[];
  port: number;
}

export interface AgentToolDeps {
  snapshot(): SettingsSnapshot;
  selectAiProvider(provider: AiProvider): Promise<void>;
  saveLocalAi(config: LocalAiConfig): Promise<void>;
  removeLocalAi(): Promise<void>;
  setReadoutSource(source: ReadoutVoice["source"]): void;
  saveLocalTts(config: LocalTtsConfig): void;
  setChirps(on: boolean): void;
  setChirpVolume(volume: number): void;
  setReadAloud(on: boolean): void;
  setReadAloudVolume(volume: number): void;
  setWindowMode(mode: WindowMode): Promise<void>;
  assignIconSet(slug: string, label: string, set: IconSetId): void;
  setConciergeLook(look: ConciergeLook): void;
  addFolder(agent: AgentKind, path: string, label?: string): Promise<SettingsProblem | { id: string; label: string }>;
  removeFolder(id: string): Promise<SettingsProblem | undefined>;
  renameFolder(id: string, label: string): Promise<SettingsProblem | undefined>;
  fetchLocalModels(baseUrl: string): Promise<string[] | undefined>;
  fetchTtsVoices(kind: TtsKind, baseUrl: string): Promise<TtsVoiceOption[] | undefined>;
  fetchTtsModels(baseUrl: string): Promise<string[] | undefined>;
  fetchIsVoicevoxEngine(baseUrl: string): Promise<boolean>;
  testLocalAi(config?: LocalAiConfig): Promise<JudgeResult<unknown>>;
  testCloudAi(provider: ApiKeyProvider): Promise<JudgeResult<unknown>>;
  playSample(config: LocalTtsConfig): Promise<ReadoutTestResult>;
  /** A message in the UI language (t of lib/i18n.ts), for the note */
  say(key: MessageName, substitutions?: string | string[]): string;
  now(): number;
}

/** One change, said in the UI language: which setting, from what, to what */
export interface AgentChange {
  setting: string;
  from: string;
  to: string;
}

export interface AgentToolResult {
  ok: boolean;
  text: string;
  data?: unknown;
  changes: AgentChange[];
}

type Args = Record<string, unknown>;

const PROVIDERS: AiProvider[] = ["anthropic", "openai", "local"];
const TTS_KINDS: TtsKind[] = ["openai", "voicevox"];
const AGENT_KINDS = AGENTS.map((a) => a.kind);

const ICON_SET_TEXT: Record<IconSetId, MessageName> = {
  birds: "iconSetBirds",
  gnome: "iconSetGnome",
  cat: "iconSetCat",
  robot: "iconSetRobot",
  frog: "iconSetFrog",
};
const LOOK_TEXT: Record<ConciergeLook, MessageName> = { owl: "conciergeLookOwl", penguin: "conciergeLookPenguin" };
const PROVIDER_NAME: Record<AiProvider, string> = { anthropic: "Anthropic", openai: "OpenAI", local: "Local" };

const SERVER_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: TTS_KINDS, description: "openai: an OpenAI-compatible server (Kokoro-FastAPI, mlx-audio); voicevox: a VOICEVOX-compatible engine (VOICEVOX, AivisSpeech)" },
    base_url: { type: "string", description: "e.g. http://localhost:50021 (voicevox) or http://localhost:8880/v1 (openai)" },
    voice: { type: "string", description: "A value or label from list_tts_voices (voicevox: the style id, e.g. \"2\")" },
    model: { type: "string", description: "openai only: a model from list_tts_voices" },
  },
  required: ["kind", "base_url", "voice"],
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length > 0 && { required }),
});

const NOT_RUNNING =
  " If the call fails to connect, Tomarigi isn't running: ask the user to start it.";

/** The tool list handed to the MCP server (`tools/list`). Names and texts in English */
export const AGENT_TOOLS = [
  {
    name: "get_settings",
    description:
      "Reads every setting on Tomarigi's settings screen with its current value and its choices: the AI for summaries, Local AI, the readout voice, sounds and volumes, the window mode, the concierge's look, icon sets per project, and the watched folders. API keys are never shown; only whether each is saved." +
      NOT_RUNNING,
    inputSchema: obj({}),
  },
  {
    name: "set_summary_provider",
    description:
      "Chooses the AI that writes the summaries and the concierge's advice. Anthropic and OpenAI need an API key the user saved on the settings screen; Local needs set_local_ai first.",
    inputSchema: obj({ provider: { type: "string", enum: PROVIDERS } }, ["provider"]),
  },
  {
    name: "set_local_ai",
    description:
      "Sets Local AI: an OpenAI-compatible server (Ollama, LM Studio) and its model. Use list_local_ai_models for the models and test_ai_connection to check it.",
    inputSchema: obj(
      {
        base_url: { type: "string", description: "e.g. http://localhost:11434/v1" },
        model: { type: "string" },
      },
      ["base_url", "model"],
    ),
  },
  { name: "remove_local_ai", description: "Removes the Local AI settings.", inputSchema: obj({}) },
  {
    name: "set_readout_voice",
    description:
      "Chooses the voice that reads events aloud: the system voice, or a local TTS server. With source=local and a server, the server is checked the way the settings screen checks it (its voice list) and saved. VOICEVOX-compatible servers read Japanese only. Use play_readout_sample to hear it.",
    inputSchema: obj({ source: { type: "string", enum: ["system", "local"] }, server: SERVER_SCHEMA }, ["source"]),
  },
  {
    name: "set_sound",
    description: "Sounds: the chirps on events and their volume, and reading aloud and its volume. Volumes are percent (0–100).",
    inputSchema: obj({
      chirps: { type: "boolean", description: "Notify with sound" },
      chirp_volume: { type: "integer", minimum: 0, maximum: 100 },
      read_aloud: { type: "boolean", description: "Read aloud with voice" },
      read_aloud_volume: { type: "integer", minimum: 0, maximum: 100 },
    }),
  },
  {
    name: "set_window_mode",
    description: "floating: a small window always on top; normal: a standard window that can be maximized.",
    inputSchema: obj({ mode: { type: "string", enum: WINDOW_MODES } }, ["mode"]),
  },
  {
    name: "set_icon_set",
    description: "Chooses the icons for one project's sessions. The projects are in get_settings (icon_sets).",
    inputSchema: obj(
      {
        project: { type: "string", description: "The project's slug or name from get_settings" },
        set: { type: "string", enum: ICON_SET_IDS },
      },
      ["project", "set"],
    ),
  },
  {
    name: "set_concierge_look",
    description: "Chooses the concierge's look.",
    inputSchema: obj({ look: { type: "string", enum: CONCIERGE_LOOKS } }, ["look"]),
  },
  {
    name: "add_watched_folder",
    description:
      "Watches another folder of an agent's sessions (e.g. a second Claude Code config: /Users/me/.claude-work/projects). The path must be absolute and readable.",
    inputSchema: obj(
      {
        agent: { type: "string", enum: AGENT_KINDS },
        path: { type: "string" },
        label: { type: "string", description: "Optional; defaults to the agent's name" },
      },
      ["agent", "path"],
    ),
  },
  {
    name: "rename_watched_folder",
    description: "Changes a watched folder's label (the id is in get_settings).",
    inputSchema: obj({ id: { type: "string" }, label: { type: "string" } }, ["id", "label"]),
  },
  {
    name: "remove_watched_folder",
    description: "Stops watching a folder the user added (the default folders can't be removed).",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "list_local_ai_models",
    description: "Reads the models of an OpenAI-compatible server (the saved Local AI server when base_url is left out).",
    inputSchema: obj({ base_url: { type: "string" } }),
  },
  {
    name: "list_tts_voices",
    description: "Reads a local TTS server's voices (and, for openai, its models), as the settings screen lists them.",
    inputSchema: obj({ kind: { type: "string", enum: TTS_KINDS }, base_url: { type: "string" } }, ["kind", "base_url"]),
  },
  {
    name: "test_ai_connection",
    description:
      "Runs the settings screen's connection test. local: the given base_url and model (not saved), or the saved ones; anthropic / openai: the saved key. Answers passed or why not, and the time taken.",
    inputSchema: obj({
      provider: { type: "string", enum: PROVIDERS },
      base_url: { type: "string" },
      model: { type: "string" },
    }, ["provider"]),
  },
  {
    name: "play_readout_sample",
    description:
      "Plays the settings screen's sample through the local TTS server (the saved one, or the given server, not saved) and answers whether it played and the time taken.",
    inputSchema: obj({ server: SERVER_SCHEMA }),
  },
] as const;

export type AgentToolName = (typeof AGENT_TOOLS)[number]["name"];

const fail = (text: string): AgentToolResult => ({ ok: false, text, changes: [] });
const refuse = (problem: SettingsProblem): AgentToolResult => fail(problemText(problem));
const done = (text: string, changes: AgentChange[] = [], data?: unknown): AgentToolResult => ({
  ok: true,
  text,
  changes,
  ...(data !== undefined && { data }),
});

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function percent(volume: number): string {
  return `${Math.round(volume * 100)}%`;
}

function onOff(deps: AgentToolDeps, on: boolean): string {
  return deps.say(on ? "agentNoteOn" : "agentNoteOff");
}

function voiceText(deps: AgentToolDeps, voice: ReadoutVoice): string {
  if (voice.source === "system" || !voice.local) return deps.say("readoutVoiceSystem");
  const kind = deps.say(voice.local.kind === "voicevox" ? "readoutKindVoicevox" : "readoutKindOpenAi");
  return `${kind}: ${voice.local.voiceLabel ?? voice.local.voice}`;
}

function snapshotData(s: SettingsSnapshot) {
  return {
    summary_provider: { value: s.aiProvider, choices: PROVIDERS, api_key_saved: s.keySaved, local_set_up: s.localAi !== null },
    local_ai: s.localAi && { base_url: s.localAi.baseUrl, model: s.localAi.model },
    readout_voice: {
      source: s.readoutVoice.source,
      choices: ["system", "local"],
      server: s.readoutVoice.local && {
        kind: s.readoutVoice.local.kind,
        base_url: s.readoutVoice.local.baseUrl,
        voice: s.readoutVoice.local.voice,
        voice_label: s.readoutVoice.local.voiceLabel,
        model: s.readoutVoice.local.model,
      },
      server_kinds: TTS_KINDS,
    },
    sound: {
      chirps: s.chirps,
      chirp_volume: Math.round(s.chirpVolume * 100),
      read_aloud: s.readAloud,
      read_aloud_volume: Math.round(s.readAloudVolume * 100),
    },
    window_mode: { value: s.windowMode, choices: WINDOW_MODES },
    concierge_look: { value: s.conciergeLook, choices: CONCIERGE_LOOKS },
    icon_sets: { choices: ICON_SET_IDS, projects: s.iconSets },
    watched_folders: { agents: AGENT_KINDS, folders: s.folders },
    agent_access_port: s.port,
  };
}

/** Reads a server's voice list and engine manifest like the settings card, and builds the config it would save.
 * The voice may be given as the list's value or its label */
async function serverConfig(
  deps: AgentToolDeps,
  server: Args,
): Promise<{ config: LocalTtsConfig; listed: boolean } | SettingsProblem> {
  const kind = str(server, "kind");
  if (checkOption(kind, TTS_KINDS)) return "unknown-option";
  const ttsKind = kind as TtsKind;
  const baseUrl = (str(server, "base_url") ?? "").trim();
  let voice = (str(server, "voice") ?? "").trim();
  const model = (str(server, "model") ?? "").trim();
  const problem = checkLocalTts({ kind: ttsKind, baseUrl, voice, model }) ?? checkAgentServerUrl(baseUrl);
  if (problem) return problem;
  const [voices, engine] = await Promise.all([
    deps.fetchTtsVoices(ttsKind, baseUrl),
    ttsKind === "voicevox" ? deps.fetchIsVoicevoxEngine(baseUrl) : Promise.resolve(false),
  ]);
  const byLabel = voices?.find((o) => o.label === voice);
  if (byLabel) voice = byLabel.value;
  const notListed = checkVoiceInList(voice, voices?.map((o) => o.value));
  if (notListed) return notListed;
  const option = voices?.find((o) => o.value === voice);
  return {
    listed: voices !== undefined,
    config: {
      kind: ttsKind,
      baseUrl,
      voice,
      voiceLabel: option?.label,
      speaker: option?.speaker,
      ...(ttsKind === "openai" && { model }),
      voicevoxCredit: ttsKind === "voicevox" && engine,
    },
  };
}

function aiTestText(result: JudgeResult<unknown>, ms: number, local: boolean): AgentToolResult {
  if (result.ok) return done(`Passed in ${(ms / 1000).toFixed(1)} s.`, [], { passed: true, ms });
  const text =
    local && result.kind === "network"
      ? englishText("localAiTestUnreachable")
      : englishText(AI_TEST_FAILURE_MESSAGE[result.kind]);
  return { ok: false, text, changes: [], data: { passed: false, reason: result.kind, ms } };
}

export async function runAgentTool(name: string, rawArgs: unknown, deps: AgentToolDeps): Promise<AgentToolResult> {
  const args: Args = typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Args) : {};
  const before = deps.snapshot();
  switch (name as AgentToolName) {
    case "get_settings":
      return done(JSON.stringify(snapshotData(before)), [], snapshotData(before));

    case "set_summary_provider": {
      const provider = str(args, "provider");
      if (checkOption(provider, PROVIDERS)) return refuse("unknown-option");
      const p = provider as AiProvider;
      const problem = checkProviderChoice(p, { ...before.keySaved, local: before.localAi !== null });
      if (problem) return refuse(problem);
      await deps.selectAiProvider(p);
      return done(`The summaries now use ${PROVIDER_NAME[p]}.`, [
        {
          setting: deps.say("agentNoteSummaryProvider"),
          from: before.aiProvider ? PROVIDER_NAME[before.aiProvider] : deps.say("agentNoteNotSet"),
          to: PROVIDER_NAME[p],
        },
      ]);
    }

    case "set_local_ai": {
      const config = { baseUrl: (str(args, "base_url") ?? "").trim(), model: (str(args, "model") ?? "").trim() };
      const problem = checkLocalAi(config) ?? checkAgentServerUrl(config.baseUrl);
      if (problem) return refuse(problem);
      await deps.saveLocalAi(config);
      return done(`Saved Local AI: ${config.baseUrl}, model ${config.model}. Run test_ai_connection to check it.`, [
        {
          setting: deps.say("localAiHeading"),
          from: before.localAi ? before.localAi.model : deps.say("agentNoteNotSet"),
          to: config.model,
        },
      ]);
    }

    case "remove_local_ai":
      if (!before.localAi) return done("Local AI wasn't set up.");
      await deps.removeLocalAi();
      return done("Removed Local AI.", [
        { setting: deps.say("localAiHeading"), from: before.localAi.model, to: deps.say("agentNoteNotSet") },
      ]);

    case "set_readout_voice": {
      const source = str(args, "source");
      if (checkOption(source, ["system", "local"])) return refuse("unknown-option");
      const server = args.server;
      if (source === "local" && typeof server === "object" && server !== null) {
        const built = await serverConfig(deps, server as Args);
        if (typeof built === "string") return refuse(built);
        deps.saveLocalTts(built.config);
        const after: ReadoutVoice = { source: "local", local: built.config };
        return done(
          `Saved the readout voice: ${built.config.kind} server ${built.config.baseUrl}, voice ${built.config.voiceLabel ?? built.config.voice}.` +
            (built.listed ? "" : " The server's voice list couldn't be read, so the voice was kept as given.") +
            " Run play_readout_sample to hear it.",
          [{ setting: deps.say("readoutVoiceLabel"), from: voiceText(deps, before.readoutVoice), to: voiceText(deps, after) }],
        );
      }
      if (source === "local" && !before.readoutVoice.local) {
        return fail("No local TTS server is saved yet. Give `server` (kind, base_url, voice) to set one.");
      }
      const next = source as ReadoutVoice["source"];
      deps.setReadoutSource(next);
      const after: ReadoutVoice = { ...before.readoutVoice, source: next };
      return done(`The readout voice is now ${next === "system" ? "the system voice" : "the local TTS server"}.`, [
        { setting: deps.say("readoutVoiceLabel"), from: voiceText(deps, before.readoutVoice), to: voiceText(deps, after) },
      ]);
    }

    case "set_sound": {
      const changes: AgentChange[] = [];
      const volumes = ["chirp_volume", "read_aloud_volume"] as const;
      for (const key of volumes) {
        if (args[key] === undefined) continue;
        const problem = checkVolume(args[key] as number);
        if (problem) return refuse(problem);
      }
      for (const key of ["chirps", "read_aloud"] as const) {
        if (args[key] !== undefined && typeof args[key] !== "boolean") return refuse("unknown-option");
      }
      if (typeof args.chirps === "boolean") {
        deps.setChirps(args.chirps);
        changes.push({ setting: deps.say("soundEnableLabel"), from: onOff(deps, before.chirps), to: onOff(deps, args.chirps) });
      }
      if (typeof args.chirp_volume === "number") {
        const v = args.chirp_volume / 100;
        deps.setChirpVolume(v);
        changes.push({ setting: deps.say("agentNoteChirpVolume"), from: percent(before.chirpVolume), to: percent(v) });
      }
      if (typeof args.read_aloud === "boolean") {
        deps.setReadAloud(args.read_aloud);
        changes.push({ setting: deps.say("voiceEnableLabel"), from: onOff(deps, before.readAloud), to: onOff(deps, args.read_aloud) });
      }
      if (typeof args.read_aloud_volume === "number") {
        const v = args.read_aloud_volume / 100;
        deps.setReadAloudVolume(v);
        changes.push({ setting: deps.say("agentNoteReadAloudVolume"), from: percent(before.readAloudVolume), to: percent(v) });
      }
      return changes.length === 0 ? done("Nothing to change was given.") : done("Saved.", changes);
    }

    case "set_window_mode": {
      const mode = str(args, "mode");
      if (checkOption(mode, WINDOW_MODES)) return refuse("unknown-option");
      await deps.setWindowMode(mode as WindowMode);
      const text = (m: WindowMode) => deps.say(m === "floating" ? "windowModeFloating" : "windowModeNormal");
      return done(`The window is now ${mode}.`, [
        { setting: deps.say("windowModeHeading"), from: text(before.windowMode), to: text(mode as WindowMode) },
      ]);
    }

    case "set_icon_set": {
      const project = (str(args, "project") ?? "").trim();
      const set = str(args, "set");
      if (checkOption(set, ICON_SET_IDS)) return refuse("unknown-option");
      const row = before.iconSets.find((r) => r.slug === project) ?? before.iconSets.find((r) => r.name === project);
      if (!row) return fail("No such project. get_settings lists them (icon_sets.projects).");
      deps.assignIconSet(row.slug, row.name, set as IconSetId);
      return done(`${row.name} now uses ${set}.`, [
        {
          setting: `${deps.say("iconSetHeading")}: ${row.name}`,
          from: deps.say(ICON_SET_TEXT[row.set]),
          to: deps.say(ICON_SET_TEXT[set as IconSetId]),
        },
      ]);
    }

    case "set_concierge_look": {
      const look = str(args, "look");
      if (checkOption(look, CONCIERGE_LOOKS)) return refuse("unknown-option");
      deps.setConciergeLook(look as ConciergeLook);
      return done(`The concierge is now the ${look}.`, [
        {
          setting: deps.say("conciergeName"),
          from: deps.say(LOOK_TEXT[before.conciergeLook]),
          to: deps.say(LOOK_TEXT[look as ConciergeLook]),
        },
      ]);
    }

    case "add_watched_folder": {
      const agent = str(args, "agent");
      if (checkOption(agent, AGENT_KINDS)) return refuse("unknown-option");
      const added = await deps.addFolder(agent as AgentKind, str(args, "path") ?? "", str(args, "label"));
      if (typeof added === "string") return refuse(added);
      return done(`Watching it as "${added.label}" (id ${added.id}).`, [
        { setting: deps.say("rootsHeading"), from: deps.say("agentNoteNotSet"), to: added.label },
      ], { id: added.id });
    }

    case "rename_watched_folder": {
      const id = str(args, "id") ?? "";
      const folder = before.folders.find((f) => f.id === id);
      if (!folder) return fail("No watched folder has that id. get_settings lists them.");
      const label = str(args, "label") ?? "";
      const problem = await deps.renameFolder(id, label);
      if (problem) return refuse(problem);
      return done(`Renamed to "${label.trim()}".`, [
        { setting: deps.say("rootsHeading"), from: folder.label, to: label.trim() },
      ]);
    }

    case "remove_watched_folder": {
      const id = str(args, "id") ?? "";
      const folder = before.folders.find((f) => f.id === id);
      if (!folder) return fail("No watched folder has that id. get_settings lists them.");
      const problem = await deps.removeFolder(id);
      if (problem) return refuse(problem);
      return done(`Stopped watching "${folder.label}".`, [
        { setting: deps.say("rootsHeading"), from: folder.label, to: deps.say("agentNoteNotSet") },
      ]);
    }

    case "list_local_ai_models": {
      const given = str(args, "base_url");
      const baseUrl = (given ?? before.localAi?.baseUrl ?? "").trim();
      // The saved server is the user's own choice; a URL the agent gives must be local
      const problem = checkLocalAi({ baseUrl, model: "-" }) ?? (given !== undefined ? checkAgentServerUrl(baseUrl) : undefined);
      if (problem) return refuse(problem);
      const models = await deps.fetchLocalModels(baseUrl);
      if (!models || models.length === 0) return fail(englishText("localAiModelsFailed"));
      return done(JSON.stringify({ models }), [], { models });
    }

    case "list_tts_voices": {
      const kind = str(args, "kind");
      if (checkOption(kind, TTS_KINDS)) return refuse("unknown-option");
      const baseUrl = (str(args, "base_url") ?? "").trim();
      const problem =
        checkLocalTts({ kind: kind as TtsKind, baseUrl, voice: "-", model: "-" }) ?? checkAgentServerUrl(baseUrl);
      if (problem) return refuse(problem);
      const [voices, models] = await Promise.all([
        deps.fetchTtsVoices(kind as TtsKind, baseUrl),
        kind === "openai" ? deps.fetchTtsModels(baseUrl) : Promise.resolve(undefined),
      ]);
      if (!voices) return fail(englishText("readoutListFailed"));
      const data = { voices: voices.map((v) => ({ value: v.value, label: v.label })), ...(models && { models }) };
      return done(JSON.stringify(data), [], data);
    }

    case "test_ai_connection": {
      const provider = str(args, "provider");
      if (checkOption(provider, PROVIDERS)) return refuse("unknown-option");
      const started = deps.now();
      if (provider === "local") {
        const given = str(args, "base_url") !== undefined || str(args, "model") !== undefined;
        let draft: LocalAiConfig | undefined;
        if (given) {
          draft = {
            baseUrl: (str(args, "base_url") ?? before.localAi?.baseUrl ?? "").trim(),
            model: (str(args, "model") ?? before.localAi?.model ?? "").trim(),
          };
          const problem =
            checkLocalAi(draft) ?? (str(args, "base_url") !== undefined ? checkAgentServerUrl(draft.baseUrl) : undefined);
          if (problem) return refuse(problem);
        } else if (!before.localAi) {
          return refuse("local-not-set-up");
        }
        const result = await deps.testLocalAi(draft);
        return aiTestText(result, deps.now() - started, true);
      }
      const p = provider as ApiKeyProvider;
      if (!before.keySaved[p]) return refuse("no-key");
      const result = await deps.testCloudAi(p);
      return aiTestText(result, deps.now() - started, false);
    }

    case "play_readout_sample": {
      let config: LocalTtsConfig | undefined = before.readoutVoice.local;
      if (typeof args.server === "object" && args.server !== null) {
        const built = await serverConfig(deps, args.server as Args);
        if (typeof built === "string") return refuse(built);
        config = built.config;
      }
      if (!config) return fail("No local TTS server is saved. Give `server` (kind, base_url, voice), or save one with set_readout_voice.");
      const result = await deps.playSample(config);
      if (result.ok) {
        return done(`Played through the server in ${(result.ms / 1000).toFixed(1)} s.`, [], { played: true, ms: result.ms });
      }
      const reason = result.error === "audio" ? "audio" : classifyTestError(config.kind, result.error).reason;
      const text =
        reason === "audio"
          ? `${englishText("readoutTestAudio")} The server answered; the app couldn't play the sound (it may need a click in its window first).`
          : englishText(TTS_TEST_FAILURE_MESSAGE[reason]);
      return { ok: false, text, changes: [], data: { played: false, reason } };
    }

    default:
      return fail(`Unknown tool ${name}.`);
  }
}
