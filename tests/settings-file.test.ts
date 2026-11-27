// The settings file (docs/design/settings-file.md "Settings file"): reading a file value as the store's and back, checking an edit
// with the screen's checks (lib/settings-file.ts) against fake servers and folders, and the built-in schema and the Rust
// key list staying the same as the code's
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applyFileDoc, stableJson, type ApplyDeps, type FileDoc } from "../src/lib/settings-file";
import {
  defaultFileDoc,
  FILE_FIELDS,
  folderIdOf,
  fromFile,
  isUnsetNull,
  looksSecret,
  NULLABLE_FIELDS,
  STORE_KEY_OF,
  toFile,
  withoutUnsetNulls,
} from "../src/lib/settings-file-fields";
import { AGENTS } from "../src/lib/agents";
import { ICON_SET_IDS } from "../src/lib/icon-set-store";
import { CONCIERGE_LOOKS, DEFAULT_CONCIERGE_LOOK } from "../src/lib/concierge-look";
import { DEFAULT_WINDOW_MODE, WINDOW_MODES } from "../src/lib/window-mode";

const VOICES = [
  { value: "2", label: "四国めたん（ノーマル）", speaker: "四国めたん" },
  { value: "3", label: "ずんだもん（ノーマル）", speaker: "ずんだもん" },
];

function deps(over: Partial<ApplyDeps> = {}): ApplyDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    keySaved: { anthropic: false, openai: true },
    defaultRootPaths: ["/Users/x/.claude/projects"],
    readable: async (path) => path !== "/missing",
    fetchTtsVoices: async (kind, baseUrl) => {
      asked.push(`${kind} ${baseUrl}`);
      return baseUrl.includes("down") ? undefined : VOICES;
    },
    fetchIsVoicevoxEngine: async () => true,
    say: (key, subs) => (subs ? `${key}(${[subs].flat().join(",")})` : key),
    ...over,
  };
}

const APPLIED: FileDoc = {
  chirps: true,
  chirpVolume: 100,
  readAloud: false,
  readAloudVolume: 50,
  readoutVoice: { source: "system" },
  localAi: null,
  summaryProvider: "openai",
  windowMode: "floating",
  conciergeLook: "owl",
  iconSets: {},
  watchedFolders: [{ agent: "claude", path: "/Users/x/.claude-work/projects", label: "Work", id: "f1" }],
  defaultFolderLabels: {},
};

/** A value saved for every store key the file stands for */
const STORE: Record<string, unknown> = {
  muted: true,
  chirpVolume: 0.4,
  voiceEnabled: true,
  voiceVolume: 1,
  readoutVoice: {
    source: "local",
    local: { kind: "voicevox", baseUrl: "http://localhost:50021", voice: "2", voiceLabel: "四国めたん（ノーマル）", speaker: "四国めたん", voicevoxCredit: true },
  },
  localAi: { baseUrl: "http://localhost:11434/v1", model: "qwen3" },
  aiProvider: "local",
  conciergeLook: "penguin",
  projectIconSets: { "-Users-x-app": { set: "cat", label: "app" } },
  roots: [{ id: "f1", kind: "codex", label: "Codex work", path: "/Users/x/.codex-work" }],
  defaultRootLabels: { claude: "Mine" },
};

const edit = (over: FileDoc) => ({ ...APPLIED, ...over });

describe("file values and the store's", () => {
  test("each store value goes into the file and comes back the same", () => {
    const store = STORE;
    const info = { "voicevox http://localhost:50021 2": { voiceLabel: "四国めたん（ノーマル）", speaker: "四国めたん", voicevoxCredit: true } };
    for (const field of FILE_FIELDS) {
      if (field === "windowMode") continue;
      const key = STORE_KEY_OF[field];
      expect([field, fromFile(field, toFile(field, store[key]), info)]).toEqual([field, store[key]]);
    }
  });

  test("the file holds the voice by id, without its label or credit", () => {
    expect(toFile("readoutVoice", { source: "local", local: { kind: "voicevox", baseUrl: "u", voice: "2", voiceLabel: "x", voicevoxCredit: true } })).toEqual({
      source: "local",
      server: { kind: "voicevox", baseUrl: "u", voice: "2" },
    });
  });

  test("nothing saved writes the defaults the screen shows", () => {
    expect(toFile("chirps", undefined)).toBe(true);
    expect(toFile("readAloud", undefined)).toBe(false);
    expect(toFile("chirpVolume", undefined)).toBe(100);
    expect(toFile("readoutVoice", undefined)).toEqual({ source: "system" });
    expect(toFile("watchedFolders", undefined)).toEqual([]);
    expect(toFile("conciergeLook", undefined)).toBe(DEFAULT_CONCIERGE_LOOK);
    expect(defaultFileDoc().windowMode).toBe(DEFAULT_WINDOW_MODE);
  });

  test("a null the schema doesn't allow is nothing saved; the schema's own nulls are kept", () => {
    expect(isUnsetNull("conciergeLook", null)).toBe(true);
    expect(isUnsetNull("localAi", null)).toBe(false);
    expect(isUnsetNull("summaryProvider", null)).toBe(false);
    expect(isUnsetNull("theme", null)).toBe(false);
    expect(withoutUnsetNulls({ conciergeLook: null, localAi: null, chirps: true })).toEqual({ localAi: null, chirps: true });
    expect(fromFile("conciergeLook", null)).toBeUndefined();
  });

  test("a folder an agent adds without an id gets one from its path, the same every time", () => {
    expect(folderIdOf({ path: "/Users/x/a/" })).toBe(folderIdOf({ path: "/Users/x/a" }));
    expect(folderIdOf({ id: "f1", path: "/Users/x/a" })).toBe("f1");
  });

  test("keys that look like a secret", () => {
    for (const k of ["apiKey", "openaiApiKey", "anthropicKey", "token", "mcpToken", "clientSecret", "api_key", "OPENAI_API_KEY"]) {
      expect([k, looksSecret(k)]).toEqual([k, true]);
    }
    for (const k of ["chirps", "keyboard", "monkey", "turkey"]) expect([k, looksSecret(k)]).toEqual([k, false]);
  });
});

describe("applyFileDoc", () => {
  test("a changed value passes the screen's check and says what changed", async () => {
    const r = await applyFileDoc(edit({ chirpVolume: 40, readAloud: true }), APPLIED, APPLIED, deps());
    expect(r.accepted).toEqual([
      { field: "chirpVolume", value: 40 },
      { field: "readAloud", value: true },
    ]);
    expect(r.changes).toEqual([
      { setting: "soundEnableLabel › voiceVolumeLabel", from: "100%", to: "40%" },
      { setting: "voiceEnableLabel", from: "settingsFileOff", to: "settingsFileOn" },
    ]);
    expect(r.refused).toEqual([]);
  });

  test("a wrong value is refused with the screen's reason and the others of the same save are applied", async () => {
    const r = await applyFileDoc(
      edit({ chirpVolume: 140, conciergeLook: "penguin", localAi: { baseUrl: "localhost:11434", model: "q" } }),
      APPLIED,
      APPLIED,
      deps(),
    );
    expect(r.accepted).toEqual([{ field: "conciergeLook", value: "penguin" }]);
    expect(r.refused.map((x) => [x.field, x.problem])).toEqual([
      ["chirpVolume", "volume-range"],
      ["localAi", "url-invalid"],
    ]);
    // Said so the line reads as how to fix it: what was written and what stays
    expect(r.refused[0]).toMatchObject({ setting: "soundEnableLabel › voiceVolumeLabel", key: "chirpVolume", value: "140", previous: "100%" });
    expect(r.refused[1]).toMatchObject({ value: '{"baseUrl":"localhost:11434","model":"q"}', previous: "settingsFileNotSet" });
  });

  test("any host is fine for a server URL, as on the screen", async () => {
    const r = await applyFileDoc(edit({ localAi: { baseUrl: "https://ai.example.com/v1", model: "m" } }), APPLIED, APPLIED, deps());
    expect(r.accepted).toEqual([{ field: "localAi", value: { baseUrl: "https://ai.example.com/v1", model: "m" } }]);
  });

  test("keys that didn't change since the file was last taken aren't checked again", async () => {
    const seen = edit({ chirpVolume: 140 });
    const r = await applyFileDoc(edit({ chirpVolume: 140, readAloud: true }), seen, APPLIED, deps());
    expect(r.refused).toEqual([]);
    expect(r.accepted).toEqual([{ field: "readAloud", value: true }]);
  });

  test("Local AI set up and chosen in one save passes", async () => {
    const r = await applyFileDoc(
      edit({ summaryProvider: "local", localAi: { baseUrl: "http://localhost:11434/v1", model: "qwen3" } }),
      APPLIED,
      APPLIED,
      deps(),
    );
    expect(r.accepted.map((a) => a.field)).toEqual(["localAi", "summaryProvider"]);
  });

  test("a provider without a key is refused", async () => {
    const r = await applyFileDoc(edit({ summaryProvider: "anthropic" }), APPLIED, APPLIED, deps());
    expect(r.refused.map((x) => x.problem)).toEqual(["no-key"]);
  });

  test("a VOICEVOX voice is looked up on the server: its label and credit are kept beside the file", async () => {
    const d = deps();
    const voice = { source: "local", server: { kind: "voicevox", baseUrl: "http://localhost:50021", voice: "2" } };
    const r = await applyFileDoc(edit({ readoutVoice: voice }), APPLIED, APPLIED, d);
    expect(r.accepted).toEqual([{ field: "readoutVoice", value: voice }]);
    expect(r.voiceInfo).toEqual(["voicevox http://localhost:50021 2", { voiceLabel: "四国めたん（ノーマル）", speaker: "四国めたん", voicevoxCredit: true }]);
    expect(r.changes[0].to).toBe("readoutKindVoicevox: 四国めたん（ノーマル）");
    expect(d.asked).toEqual(["voicevox http://localhost:50021"]);
  });

  test("a voice the server doesn't have is refused; one that can't be checked is kept as given", async () => {
    const unknown = { source: "local", server: { kind: "voicevox", baseUrl: "http://localhost:50021", voice: "99" } };
    const r = await applyFileDoc(edit({ readoutVoice: unknown }), APPLIED, APPLIED, deps());
    expect(r.refused.map((x) => x.problem)).toEqual(["no-voice"]);
    const down = { source: "local", server: { kind: "voicevox", baseUrl: "http://down:50021", voice: "99" } };
    const r2 = await applyFileDoc(edit({ readoutVoice: down }), APPLIED, APPLIED, deps());
    expect(r2.accepted).toEqual([{ field: "readoutVoice", value: down }]);
  });

  test("an OpenAI-compatible server needs a model; the local voice needs a server", async () => {
    const noModel = { source: "local", server: { kind: "openai", baseUrl: "http://localhost:8880/v1", voice: "af_heart" } };
    const r = await applyFileDoc(edit({ readoutVoice: noModel }), APPLIED, APPLIED, deps());
    expect(r.refused.map((x) => x.problem)).toEqual(["tts-model-missing"]);
    const r2 = await applyFileDoc(edit({ readoutVoice: { source: "local" } }), APPLIED, APPLIED, deps());
    expect(r2.refused.map((x) => x.problem)).toEqual(["no-server"]);
  });

  test("watched folders: added, removed and refused entry by entry; a refused one keeps the folder it was", async () => {
    const r = await applyFileDoc(
      edit({
        watchedFolders: [
          { agent: "claude", path: "/Users/x/.claude-work/projects", label: "Work 2", id: "f1" },
          { agent: "codex", path: "/Users/x/.codex-work", label: "Codex work" },
          { agent: "codex", path: "/missing", label: "Gone" },
          { agent: "claude", path: "/Users/x/.claude/projects", label: "Twice" },
          { agent: "claude", path: "//server/share", label: "Net" },
          { agent: "nobody", path: "/Users/x/y", label: "Who" },
        ],
      }),
      APPLIED,
      APPLIED,
      deps(),
    );
    expect(r.accepted).toEqual([
      {
        field: "watchedFolders",
        value: [
          { agent: "claude", path: "/Users/x/.claude-work/projects", label: "Work 2", id: "f1" },
          { agent: "codex", path: "/Users/x/.codex-work", label: "Codex work", id: "path:/Users/x/.codex-work" },
        ],
      },
    ]);
    expect(r.refused.map((x) => x.problem)).toEqual(["not-readable", "duplicate", "network-path", "unknown-option"]);
    const removed = await applyFileDoc(edit({ watchedFolders: [] }), APPLIED, APPLIED, deps());
    expect(removed.accepted).toEqual([{ field: "watchedFolders", value: [] }]);
    expect(removed.changes[0].to).toBe("settingsFileNotSet");
  });

  test("icon sets: birds removes the entry, an unknown set keeps the one before", async () => {
    const applied = edit({ iconSets: { a: { set: "cat", label: "A" }, b: { set: "frog", label: "B" } } });
    const r = await applyFileDoc(
      { ...applied, iconSets: { a: { set: "birds", label: "A" }, b: { set: "dragon", label: "B" }, c: { set: "robot", label: "C" } } },
      applied,
      applied,
      deps(),
    );
    expect(r.accepted).toEqual([{ field: "iconSets", value: { b: { set: "frog", label: "B" }, c: { set: "robot", label: "C" } } }]);
    expect(r.refused[0]).toMatchObject({ key: "iconSets.b", value: '{"set":"dragon","label":"B"}', previous: "iconSetFrog" });
    expect(r.refused.map((x) => [x.setting, x.problem])).toEqual([["iconSetHeading › B", "unknown-option"]]);
  });

  test("unknown keys and secret-looking keys are reported, never applied", async () => {
    const r = await applyFileDoc({ ...APPLIED, $schema: "./settings.schema.json", theme: "dark", openaiApiKey: "sk-x" }, APPLIED, APPLIED, deps());
    expect(r.unknown).toEqual(["theme"]);
    expect(r.secret).toEqual(["openaiApiKey"]);
    expect(r.accepted).toEqual([]);
  });

  test("a value set back by hand after a save from the screen is taken: it is compared with the file before the edit", async () => {
    const saved = edit({ chirps: false });
    const r = await applyFileDoc(edit({ chirps: true }), saved, saved, deps());
    expect(r.accepted).toEqual([{ field: "chirps", value: true }]);
  });

  test("a key left out is not a change", async () => {
    const { chirps: _, ...rest } = APPLIED;
    const r = await applyFileDoc(rest, APPLIED, APPLIED, deps());
    expect(r.accepted).toEqual([]);
    expect(r.refused).toEqual([]);
  });

  test("keys written in another order are the same value", () => {
    expect(stableJson({ a: 1, b: { d: 2, c: 3 } })).toBe(stableJson({ b: { c: 3, d: 2 }, a: 1 }));
  });
});

describe("the built-in texts and Rust's key list", () => {
  const schema = JSON.parse(readFileSync("src-tauri/settings-file/settings.schema.json", "utf8"));
  const props = schema.properties;

  test("the schema has every key of the file and no other", () => {
    expect(Object.keys(props).filter((k) => k !== "$schema").sort()).toEqual([...FILE_FIELDS].sort());
  });

  test("the schema's choices are the code's", () => {
    const agents = AGENTS.map((a) => a.kind);
    expect(props.watchedFolders.items.properties.agent.enum).toEqual(agents);
    expect(props.defaultFolderLabels.propertyNames.enum).toEqual(agents);
    expect(props.iconSets.additionalProperties.properties.set.enum).toEqual([...ICON_SET_IDS]);
    expect(props.conciergeLook.enum).toEqual([...CONCIERGE_LOOKS]);
    expect(props.windowMode.enum).toEqual([...WINDOW_MODES]);
    expect(props.summaryProvider.enum).toEqual(["anthropic", "openai", "local", null]);
    expect(props.readoutVoice.properties.server.properties.kind.enum.sort()).toEqual(["openai", "voicevox"]);
  });

  test("the fields that may be null are the ones whose schema allows null", () => {
    const nullable = FILE_FIELDS.filter((f) => schemaProblems(props[f], null, f).length === 0);
    expect(nullable.sort()).toEqual([...NULLABLE_FIELDS].sort());
  });

  /** The file as the app writes it from the store's values (windowMode is Rust's) */
  const fileOf = (store: Record<string, unknown>, windowMode: unknown) =>
    Object.fromEntries(FILE_FIELDS.map((f) => [f, f === "windowMode" ? windowMode : toFile(f, store[STORE_KEY_OF[f]])]));

  test("the check finds a value the schema doesn't allow", () => {
    expect(schemaProblems(schema, { ...defaultFileDoc(), conciergeLook: null })).toEqual(["conciergeLook: null is not one of the choices"]);
    expect(schemaProblems(schema, { ...defaultFileDoc(), chirpVolume: 101 })).toEqual(["chirpVolume: above 100"]);
  });

  test("the file written with nothing saved fits the schema", () => {
    const doc = defaultFileDoc();
    expect(Object.keys(doc).sort()).toEqual([...FILE_FIELDS].sort());
    expect(schemaProblems(schema, doc)).toEqual([]);
    expect(schemaProblems(schema, fileOf({}, DEFAULT_WINDOW_MODE))).toEqual([]);
  });

  test("the file written with a value saved for every setting fits the schema", () => {
    const storeKeys = Object.values(STORE_KEY_OF);
    expect(Object.keys(STORE).sort()).toEqual([...storeKeys].sort());
    const openai = {
      ...STORE,
      readoutVoice: { source: "system", local: { kind: "openai", baseUrl: "http://localhost:8880/v1", voice: "af_heart", model: "kokoro" } },
      localAi: undefined,
      aiProvider: "openai",
    };
    for (const [store, mode] of [[STORE, "normal"], [openai, "floating"]] as const) {
      expect(schemaProblems(schema, fileOf(store, mode))).toEqual([]);
    }
  });

  test("Rust keeps the same keys (FIELDS in settings_file.rs)", () => {
    const rust = readFileSync("src-tauri/src/settings_file.rs", "utf8");
    const list = /pub\(crate\) const FIELDS: \[&str; \d+\] = \[([^\]]*)\]/.exec(rust)?.[1] ?? "";
    expect([...list.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort()).toEqual([...FILE_FIELDS].sort());
  });
});

/** The parts of JSON Schema settings.schema.json uses, enough to say whether a file the app writes fits it */
function schemaProblems(s: Record<string, any>, v: unknown, at = ""): string[] {
  const here = at === "" ? "(file)" : at;
  if (s.oneOf) {
    const fits = (s.oneOf as Record<string, any>[]).filter((o) => schemaProblems(o, v, at).length === 0).length;
    return fits === 1 ? [] : [`${here}: fits ${fits} of oneOf`];
  }
  if (s.enum && !(s.enum as unknown[]).includes(v)) return [`${here}: ${JSON.stringify(v)} is not one of the choices`];
  const kind = v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
  if (s.type && !(s.type === kind || (s.type === "number" && kind === "integer"))) return [`${here}: ${kind}, not ${s.type}`];
  const out: string[] = [];
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) out.push(`${here}: below ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) out.push(`${here}: above ${s.maximum}`);
  }
  if (typeof v === "string" && s.minLength !== undefined && v.length < s.minLength) out.push(`${here}: shorter than ${s.minLength}`);
  if (Array.isArray(v) && s.items) v.forEach((item, i) => out.push(...schemaProblems(s.items, item, `${at}[${i}]`)));
  if (kind === "object") {
    const o = v as Record<string, unknown>;
    for (const key of s.required ?? []) if (!(key in o)) out.push(`${here}: no ${key}`);
    for (const [key, value] of Object.entries(o)) {
      const path = at === "" ? key : `${at}.${key}`;
      if (s.propertyNames?.enum && !s.propertyNames.enum.includes(key)) out.push(`${path}: not an allowed key`);
      const sub = s.properties?.[key] ?? s.additionalProperties;
      if (sub === false) out.push(`${path}: not in the schema`);
      else if (sub && sub !== true) out.push(...schemaProblems(sub, value, path));
    }
  }
  return out;
}
