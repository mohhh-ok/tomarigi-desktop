// The settings file's keys and how each one stands for a value of the app's store (docs/design.md "Settings file",
// Detailed design (a)). Pure conversions, both ways, so lib/kv.ts can keep the store's functions and callers as they
// are while the values live in the file. No Tauri imports: lib/kv.ts imports this
import { pathKey } from "./paths";
import { DEFAULT_CONCIERGE_LOOK } from "./concierge-look";
import { DEFAULT_WINDOW_MODE } from "./window-mode";
import type { LocalTtsConfig, ReadoutVoice, TtsKind } from "./readout-voice";

/** Every key of the file, in the order an edit is applied (localAi before summaryProvider, so a file that sets up
 * Local AI and chooses it in one save passes). Rust has the same list (FIELDS in src-tauri/src/settings_file.rs) */
export const FILE_FIELDS = [
  "chirps",
  "chirpVolume",
  "readAloud",
  "readAloudVolume",
  "readoutVoice",
  "localAi",
  "summaryProvider",
  "windowMode",
  "conciergeLook",
  "iconSets",
  "watchedFolders",
  "defaultFolderLabels",
] as const;
export type FileField = (typeof FILE_FIELDS)[number];

/** The store key each field stands for. windowMode is Rust's (window.rs), so it has none */
export const STORE_KEY_OF: Record<Exclude<FileField, "windowMode">, string> = {
  chirps: "muted",
  chirpVolume: "chirpVolume",
  readAloud: "voiceEnabled",
  readAloudVolume: "voiceVolume",
  readoutVoice: "readoutVoice",
  localAi: "localAi",
  summaryProvider: "aiProvider",
  conciergeLook: "conciergeLook",
  iconSets: "projectIconSets",
  watchedFolders: "roots",
  defaultFolderLabels: "defaultRootLabels",
};

/** The fields whose value in the file may be null (the schema allows it: "not set"). Any other field read as null at
 * launch is taken as nothing saved and written again with its default */
export const NULLABLE_FIELDS: readonly FileField[] = ["localAi", "summaryProvider"];

export const FIELD_OF_STORE_KEY: Record<string, FileField> = Object.fromEntries(
  Object.entries(STORE_KEY_OF).map(([field, key]) => [key, field as FileField]),
);

export interface FileServer {
  kind: TtsKind;
  baseUrl: string;
  voice: string;
  model?: string;
}

export interface FileReadoutVoice {
  source: "system" | "local";
  server?: FileServer;
}

export interface FileFolder {
  agent: string;
  path: string;
  label: string;
  id?: string;
}

/** What the readout voice's server says of a voice: kept beside the file, not in it (an agent would leave it stale) */
export interface VoiceInfo {
  voiceLabel?: string;
  speaker?: string;
  voicevoxCredit?: boolean;
}

export function voiceInfoKey(server: Pick<FileServer, "kind" | "baseUrl" | "voice">): string {
  return `${server.kind} ${server.baseUrl} ${server.voice}`;
}

/** The id of a folder an agent added without one: the same on every launch, without writing it back */
export function folderIdOf(folder: Pick<FileFolder, "id" | "path">): string {
  return folder.id && folder.id.trim() !== "" ? folder.id : `path:${pathKey(folder.path)}`;
}

const percent = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : 100);
const fraction = (v: unknown) => (typeof v === "number" ? v / 100 : undefined);

function serverOf(local: LocalTtsConfig): FileServer {
  return {
    kind: local.kind,
    baseUrl: local.baseUrl,
    voice: local.voice,
    ...(local.kind === "openai" && local.model !== undefined && { model: local.model }),
  };
}

/** A store value as the file writes it. `undefined` (nothing saved) writes the default the store's load gives */
export function toFile(field: Exclude<FileField, "windowMode">, value: unknown): unknown {
  switch (field) {
    case "chirps":
      return value !== true;
    case "readAloud":
      return value === true;
    case "chirpVolume":
    case "readAloudVolume":
      return percent(value);
    case "readoutVoice": {
      const v = value as ReadoutVoice | undefined;
      if (!v || typeof v !== "object") return { source: "system" };
      return { source: v.source === "local" ? "local" : "system", ...(v.local && { server: serverOf(v.local) }) };
    }
    case "localAi":
    case "summaryProvider":
      return value ?? null;
    case "conciergeLook":
      return value ?? DEFAULT_CONCIERGE_LOOK;
    case "iconSets":
    case "defaultFolderLabels":
      return value && typeof value === "object" ? value : {};
    case "watchedFolders": {
      const roots = Array.isArray(value) ? (value as { id: string; kind: string; label: string; path: string }[]) : [];
      return roots.map((r) => ({ agent: r.kind, path: r.path, label: r.label, id: r.id }));
    }
  }
}

/** A null the schema doesn't allow for the field (an earlier version wrote it for nothing saved): read as nothing saved */
export function isUnsetNull(field: string, value: unknown): boolean {
  return value === null && (FILE_FIELDS as readonly string[]).includes(field) && !NULLABLE_FIELDS.includes(field as FileField);
}

/** `doc` without the nulls of isUnsetNull */
export function withoutUnsetNulls<T extends Record<string, unknown>>(doc: T): T {
  return Object.fromEntries(Object.entries(doc).filter(([k, v]) => !isUnsetNull(k, v))) as T;
}

/** The file as it is with nothing saved: what the screen shows then */
export function defaultFileDoc(): Record<FileField, unknown> {
  const doc = { windowMode: DEFAULT_WINDOW_MODE } as Record<FileField, unknown>;
  for (const field of FILE_FIELDS) if (field !== "windowMode") doc[field] = toFile(field, undefined);
  return doc;
}

/** The info to keep beside the file when the store saves a readout voice */
export function voiceInfoOf(value: unknown): [string, VoiceInfo] | undefined {
  const local = (value as ReadoutVoice | undefined)?.local;
  if (!local) return undefined;
  return [
    voiceInfoKey(local),
    { voiceLabel: local.voiceLabel, speaker: local.speaker, voicevoxCredit: local.voicevoxCredit === true },
  ];
}

/** A file value (already checked) as the store's load expects it. `null` / `undefined` read as nothing saved */
export function fromFile(
  field: Exclude<FileField, "windowMode">,
  value: unknown,
  voiceInfo: Record<string, VoiceInfo> = {},
): unknown {
  if (value === null || value === undefined) return undefined;
  switch (field) {
    case "chirps":
      return typeof value === "boolean" ? !value : undefined;
    case "readAloud":
      return typeof value === "boolean" ? value : undefined;
    case "chirpVolume":
    case "readAloudVolume":
      return fraction(value);
    case "readoutVoice": {
      const v = value as FileReadoutVoice;
      const s = v.server;
      if (!s) return { source: v.source };
      const info = voiceInfo[voiceInfoKey(s)] ?? {};
      const local: LocalTtsConfig = {
        kind: s.kind,
        baseUrl: s.baseUrl,
        voice: s.voice,
        ...(info.voiceLabel && { voiceLabel: info.voiceLabel }),
        ...(info.speaker && { speaker: info.speaker }),
        ...(s.kind === "openai" && { model: s.model }),
        voicevoxCredit: s.kind === "voicevox" && info.voicevoxCredit === true,
      };
      return { source: v.source, local };
    }
    case "watchedFolders":
      return (value as FileFolder[]).map((f) => ({ id: folderIdOf(f), kind: f.agent, label: f.label, path: f.path }));
    default:
      return value;
  }
}

/** A key whose name looks like a secret: never read from the file */
export function looksSecret(key: string): boolean {
  return /^(api_?keys?|keys?|tokens?|secrets?|passwords?)$/i.test(key) || /([a-z0-9](Key|Token|Secret|Password)|[_-](key|token|secret|password))s?$/i.test(key) && !/^[a-z]+$/.test(key);
}
