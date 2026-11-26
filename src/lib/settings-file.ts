// Checking an edit of the settings file (docs/design.md "Settings file", Detailed design (e)). Each key that changed
// goes through the settings screen's own checks (lib/settings-checks.ts); a key that passes is accepted, one that fails
// keeps its applied value. Lists and maps are taken entry by entry. Said in the UI language for the note (`say`); the
// log uses the English reason (problemText). The servers are asked through `deps`, so tests use fakes
import type { MessageName } from "./i18n";
import type { TtsKind } from "./readout-voice";
import type { TtsVoiceOption } from "./tts-server";
import { AGENTS } from "./agents";
import { ICON_SET_IDS, type IconSetId } from "./icon-set-store";
import { CONCIERGE_LOOKS, type ConciergeLook } from "./concierge";
import { WINDOW_MODES, type WindowMode } from "./window-mode";
import {
  checkLocalAi,
  checkLocalTts,
  checkNewRoot,
  checkOption,
  checkProviderChoice,
  checkRootLabel,
  checkTypedRootPath,
  checkVoiceInList,
  checkVolume,
  type SettingsProblem,
} from "./settings-checks";
import {
  FILE_FIELDS,
  folderIdOf,
  looksSecret,
  voiceInfoKey,
  type FileField,
  type FileFolder,
  type FileReadoutVoice,
  type FileServer,
  type VoiceInfo,
} from "./settings-file-fields";

export type FileDoc = Record<string, unknown>;

export interface ApplyDeps {
  keySaved: { anthropic: boolean; openai: boolean };
  /** The default folders, always watched (a folder in the file may not be one of them) */
  defaultRootPaths: readonly string[];
  readable(path: string): Promise<boolean>;
  fetchTtsVoices(kind: TtsKind, baseUrl: string): Promise<TtsVoiceOption[] | undefined>;
  fetchIsVoicevoxEngine(baseUrl: string): Promise<boolean>;
  say(key: MessageName, substitutions?: string | string[]): string;
}

/** One change, said in the UI language: which setting, from what, to what */
export interface FileChange {
  setting: string;
  from: string;
  to: string;
}

export interface FileRefusal {
  field: FileField;
  /** The setting in the UI language, with the entry when it is one of a list */
  setting: string;
  problem: SettingsProblem;
}

export interface ApplyResult {
  /** Values to accept, file-shaped, in the order of FILE_FIELDS */
  accepted: { field: FileField; value: unknown }[];
  /** What the server said of the voice just accepted, to keep beside the file */
  voiceInfo?: [string, VoiceInfo];
  changes: FileChange[];
  refused: FileRefusal[];
  /** Top-level keys the app doesn't know (left in the file) */
  unknown: string[];
  /** Keys that look like an API key (never read) */
  secret: string[];
}

const PROVIDERS = ["anthropic", "openai", "local"] as const;
const PROVIDER_NAME: Record<(typeof PROVIDERS)[number], string> = { anthropic: "Anthropic", openai: "OpenAI", local: "Local" };
const TTS_KINDS: TtsKind[] = ["voicevox", "openai"];
const AGENT_KINDS = AGENTS.map((a) => a.kind);
const ICON_SET_TEXT: Record<IconSetId, MessageName> = {
  birds: "iconSetBirds",
  gnome: "iconSetGnome",
  cat: "iconSetCat",
  robot: "iconSetRobot",
  frog: "iconSetFrog",
};
const LOOK_TEXT: Record<ConciergeLook, MessageName> = { owl: "conciergeLookOwl", penguin: "conciergeLookPenguin" };
const WINDOW_TEXT: Record<WindowMode, MessageName> = { floating: "windowModeFloating", normal: "windowModeNormal" };

/** The setting each key is, as the screen names it */
export const FIELD_NAME: Record<FileField, MessageName> = {
  chirps: "soundEnableLabel",
  chirpVolume: "settingsFileChirpVolume",
  readAloud: "voiceEnableLabel",
  readAloudVolume: "settingsFileReadAloudVolume",
  readoutVoice: "readoutVoiceLabel",
  localAi: "localAiHeading",
  summaryProvider: "settingsFileSummaryProvider",
  windowMode: "windowModeHeading",
  conciergeLook: "conciergeName",
  iconSets: "iconSetHeading",
  watchedFolders: "rootsHeading",
  defaultFolderLabels: "rootsHeading",
};

/** JSON with sorted keys, so two values compare equal whatever order a writer put their keys in */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);


function serverOf(raw: unknown): FileServer | SettingsProblem {
  if (!isObject(raw)) return "wrong-type";
  if (checkOption(raw.kind, TTS_KINDS)) return "unknown-option";
  const kind = raw.kind as TtsKind;
  const baseUrl = str(raw.baseUrl);
  const voice = str(raw.voice);
  const model = str(raw.model);
  if (baseUrl === undefined || voice === undefined) return "wrong-type";
  if (raw.model !== undefined && model === undefined) return "wrong-type";
  const problem = checkLocalTts({ kind, baseUrl, voice, model });
  if (problem) return problem;
  return { kind, baseUrl, voice, ...(kind === "openai" && { model }) };
}

function describeVoice(say: ApplyDeps["say"], v: unknown, info: VoiceInfo | undefined): string {
  const voice = v as FileReadoutVoice | undefined;
  if (!voice || voice.source !== "local" || !voice.server) return say("readoutVoiceSystem");
  const kind = say(voice.server.kind === "voicevox" ? "readoutKindVoicevox" : "readoutKindOpenAi");
  return `${kind}: ${info?.voiceLabel ?? voice.server.voice}`;
}

/**
 * Checks the keys of `doc` that differ from `seen` (the file as it was last taken; at launch the applied values), against
 * `applied` (the values in use, file-shaped). `voiceInfo` is what is known of the applied voice
 */
export async function applyFileDoc(
  doc: FileDoc,
  seen: FileDoc,
  applied: FileDoc,
  deps: ApplyDeps,
  voiceInfo: Record<string, VoiceInfo> = {},
): Promise<ApplyResult> {
  const { say } = deps;
  const result: ApplyResult = { accepted: [], changes: [], refused: [], unknown: [], secret: [] };
  const next: FileDoc = { ...applied };
  const known = new Set<string>([...FILE_FIELDS, "$schema"]);
  for (const key of Object.keys(doc)) {
    if (known.has(key)) continue;
    (looksSecret(key) ? result.secret : result.unknown).push(key);
  }
  const onOff = (v: unknown) => say(v === true ? "settingsFileOn" : "settingsFileOff");
  const pct = (v: unknown) => `${typeof v === "number" ? v : 100}%`;
  const notSet = say("settingsFileNotSet");

  for (const field of FILE_FIELDS) {
    if (!(field in doc) || same(doc[field], seen[field])) continue;
    const raw = doc[field];
    const name = say(FIELD_NAME[field]);
    const refuse = (problem: SettingsProblem, entry?: string) =>
      result.refused.push({ field, setting: entry ? `${name}: ${entry}` : name, problem });
    const accept = (value: unknown, changes: FileChange[]) => {
      if (same(value, applied[field])) return;
      next[field] = value;
      result.accepted.push({ field, value });
      result.changes.push(...changes);
    };

    switch (field) {
      case "chirps":
      case "readAloud": {
        if (typeof raw !== "boolean") refuse("wrong-type");
        else accept(raw, [{ setting: name, from: onOff(applied[field]), to: onOff(raw) }]);
        break;
      }
      case "chirpVolume":
      case "readAloudVolume": {
        const problem = typeof raw === "number" ? checkVolume(raw) : "wrong-type";
        if (problem) refuse(problem);
        else accept(raw, [{ setting: name, from: pct(applied[field]), to: pct(raw) }]);
        break;
      }
      case "readoutVoice": {
        if (!isObject(raw)) {
          refuse("wrong-type");
          break;
        }
        if (checkOption(raw.source, ["system", "local"])) {
          refuse("unknown-option");
          break;
        }
        const source = raw.source as FileReadoutVoice["source"];
        let server: FileServer | undefined;
        if (raw.server !== undefined && raw.server !== null) {
          const built = serverOf(raw.server);
          if (typeof built === "string") {
            refuse(built);
            break;
          }
          server = built;
        }
        if (source === "local" && !server) {
          refuse("no-server");
          break;
        }
        const before = (applied.readoutVoice as FileReadoutVoice | undefined)?.server;
        let info = server ? voiceInfo[voiceInfoKey(server)] : undefined;
        if (server && (!before || !same(server, before) || !info)) {
          const [voices, engine] = await Promise.all([
            deps.fetchTtsVoices(server.kind, server.baseUrl),
            server.kind === "voicevox" ? deps.fetchIsVoicevoxEngine(server.baseUrl) : Promise.resolve(false),
          ]);
          const notListed = checkVoiceInList(server.voice, voices?.map((o) => o.value));
          if (notListed) {
            refuse(notListed);
            break;
          }
          const option = voices?.find((o) => o.value === server!.voice);
          info = { voiceLabel: option?.label, speaker: option?.speaker, voicevoxCredit: server.kind === "voicevox" && engine };
          result.voiceInfo = [voiceInfoKey(server), info];
        }
        const value: FileReadoutVoice = { source, ...(server && { server }) };
        const beforeInfo = before ? voiceInfo[voiceInfoKey(before)] : undefined;
        accept(value, [
          { setting: name, from: describeVoice(say, applied.readoutVoice, beforeInfo), to: describeVoice(say, value, info) },
        ]);
        break;
      }
      case "localAi": {
        if (raw === null) {
          accept(null, [{ setting: name, from: (applied.localAi as { model?: string } | null)?.model ?? notSet, to: notSet }]);
          break;
        }
        if (!isObject(raw) || str(raw.baseUrl) === undefined || str(raw.model) === undefined) {
          refuse("wrong-type");
          break;
        }
        const config = { baseUrl: str(raw.baseUrl)!, model: str(raw.model)! };
        const problem = checkLocalAi(config);
        if (problem) refuse(problem);
        else {
          const before = applied.localAi as { baseUrl: string; model: string } | null | undefined;
          accept(config, [
            { setting: name, from: before ? `${before.baseUrl} ${before.model}` : notSet, to: `${config.baseUrl} ${config.model}` },
          ]);
        }
        break;
      }
      case "summaryProvider": {
        const nameOf = (p: unknown) => (typeof p === "string" && p in PROVIDER_NAME ? PROVIDER_NAME[p as keyof typeof PROVIDER_NAME] : notSet);
        if (raw === null) {
          accept(null, [{ setting: name, from: nameOf(applied.summaryProvider), to: notSet }]);
          break;
        }
        const problem =
          checkOption(raw, PROVIDERS) ??
          checkProviderChoice(raw as (typeof PROVIDERS)[number], { ...deps.keySaved, local: isObject(next.localAi) });
        if (problem) refuse(problem);
        else accept(raw, [{ setting: name, from: nameOf(applied.summaryProvider), to: nameOf(raw) }]);
        break;
      }
      case "windowMode":
      case "conciergeLook": {
        const options: readonly string[] = field === "windowMode" ? WINDOW_MODES : CONCIERGE_LOOKS;
        const text: Record<string, MessageName> = field === "windowMode" ? WINDOW_TEXT : LOOK_TEXT;
        const problem = checkOption(raw, options);
        const said = (v: unknown) => (typeof v === "string" && text[v] ? say(text[v]) : notSet);
        if (problem) refuse(problem);
        else accept(raw, [{ setting: name, from: said(applied[field]), to: said(raw) }]);
        break;
      }
      case "iconSets": {
        if (!isObject(raw)) {
          refuse("wrong-type");
          break;
        }
        const before = (isObject(applied.iconSets) ? applied.iconSets : {}) as Record<string, { set: IconSetId; label: string }>;
        const value: Record<string, { set: IconSetId; label: string }> = {};
        const changes: FileChange[] = [];
        for (const [slug, entry] of Object.entries(raw)) {
          const label = isObject(entry) ? str(entry.label) : undefined;
          const problem = !isObject(entry) || label === undefined ? "wrong-type" : checkOption(entry.set, ICON_SET_IDS);
          if (problem) {
            refuse(problem, label || slug);
            if (before[slug]) value[slug] = before[slug];
            continue;
          }
          const set = (entry as { set: IconSetId }).set;
          // birds is the default: choosing it removes the entry, as on the screen
          if (set !== "birds") value[slug] = { set, label: label! };
          const from = before[slug]?.set ?? "birds";
          if (from !== set) changes.push({ setting: `${name}: ${label}`, from: say(ICON_SET_TEXT[from]), to: say(ICON_SET_TEXT[set]) });
        }
        for (const [slug, entry] of Object.entries(before)) {
          if (!(slug in raw)) changes.push({ setting: `${name}: ${entry.label}`, from: say(ICON_SET_TEXT[entry.set]), to: say(ICON_SET_TEXT.birds) });
        }
        accept(value, changes);
        break;
      }
      case "watchedFolders": {
        if (!Array.isArray(raw)) {
          refuse("wrong-type");
          break;
        }
        const before = (Array.isArray(applied.watchedFolders) ? applied.watchedFolders : []) as FileFolder[];
        const beforeById = new Map(before.map((f) => [folderIdOf(f), f]));
        const value: FileFolder[] = [];
        const taken: { path: string }[] = deps.defaultRootPaths.map((path) => ({ path }));
        const changes: FileChange[] = [];
        for (const entry of raw) {
          const path = isObject(entry) ? str(entry.path) : undefined;
          const label = isObject(entry) ? str(entry.label) : undefined;
          const id = isObject(entry) && path !== undefined ? folderIdOf({ id: str(entry.id), path }) : undefined;
          const old = id ? beforeById.get(id) : undefined;
          const keep = () => {
            if (!old) return;
            value.push(old);
            taken.push(old);
          };
          if (!isObject(entry) || path === undefined || label === undefined || id === undefined) {
            refuse("wrong-type", label || path);
            keep();
            continue;
          }
          const unchangedPlace = old && old.path === path && old.agent === entry.agent;
          const problem =
            checkOption(entry.agent, AGENT_KINDS) ??
            checkRootLabel(label) ??
            (unchangedPlace ? undefined : (checkTypedRootPath(path) ?? checkNewRoot(taken, path))) ??
            (unchangedPlace || (await deps.readable(path)) ? undefined : "not-readable");
          if (problem) {
            refuse(problem, label || path);
            keep();
            continue;
          }
          const folder: FileFolder = { agent: entry.agent as string, path, label, id };
          value.push(folder);
          taken.push(folder);
          if (!old) changes.push({ setting: name, from: notSet, to: `${label} (${path})` });
          else if (old.label !== label || old.path !== path) changes.push({ setting: name, from: old.label, to: label });
        }
        const kept = new Set(value.map((f) => folderIdOf(f)));
        for (const f of before) {
          if (!kept.has(folderIdOf(f))) changes.push({ setting: name, from: `${f.label} (${f.path})`, to: notSet });
        }
        accept(value, changes);
        break;
      }
      case "defaultFolderLabels": {
        if (!isObject(raw)) {
          refuse("wrong-type");
          break;
        }
        const before = (isObject(applied.defaultFolderLabels) ? applied.defaultFolderLabels : {}) as Record<string, string>;
        const value: Record<string, string> = {};
        const changes: FileChange[] = [];
        for (const [agent, label] of Object.entries(raw)) {
          const text = str(label);
          const problem = checkOption(agent, AGENT_KINDS) ?? (text === undefined ? "wrong-type" : checkRootLabel(text));
          if (problem) {
            refuse(problem, agent);
            if (before[agent]) value[agent] = before[agent];
            continue;
          }
          value[agent] = text!;
          if (before[agent] !== text) changes.push({ setting: name, from: before[agent] ?? agentLabel(agent), to: text! });
        }
        accept(value, changes);
        break;
      }
    }
  }
  return result;
}

function agentLabel(kind: string): string {
  return AGENTS.find((a) => a.kind === kind)?.label ?? kind;
}
