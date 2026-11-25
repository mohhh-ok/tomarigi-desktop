// The settings window's sections (docs/design.md "Settings window"): their order on the left, their names, and which
// one is open (in the URL, and saved so the next open shows it again)
import type { MessageName } from "@/lib/i18n";
import { kvGet, kvPut } from "@/lib/kv";

export const SETTINGS_SECTIONS = ["sound", "ai", "concierge", "folders", "icons", "window", "agent", "updates"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The left list's words: the same as each section's heading */
export const SECTION_LABEL: Record<SettingsSection, MessageName> = {
  sound: "soundSettingsHeading",
  ai: "aiApiKeysHeading",
  concierge: "conciergeName",
  folders: "rootsHeading",
  icons: "iconSetHeading",
  window: "windowModeHeading",
  agent: "agentAccessHeading",
  updates: "updatesHeading",
};

const KEY_SETTINGS_SECTION = "settingsSection";

export function sectionOf(value: unknown): SettingsSection | null {
  return SETTINGS_SECTIONS.includes(value as SettingsSection) ? (value as SettingsSection) : null;
}

export async function loadSection(): Promise<SettingsSection> {
  return sectionOf(await kvGet(KEY_SETTINGS_SECTION)) ?? "sound";
}

export function saveSection(section: SettingsSection): Promise<void> {
  return kvPut(KEY_SETTINGS_SECTION, section);
}

/** The page's URL with the section, so the screen is told by its URL */
export function urlWithSection(href: string, section: SettingsSection): string {
  const url = new URL(href);
  url.searchParams.set("section", section);
  return url.toString();
}
