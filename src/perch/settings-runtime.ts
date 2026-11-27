// What the settings window shows but nobody saves: it lives in the floating window, which scans and takes the settings file's edits
// (docs/design/settings-window.md "Settings window", "One owner of the running state"). The floating window sends it to the settings
// window when it changes and when the settings page asks on load
import { useEffect, useRef, useState } from "react";
import type { IconSetAssignments } from "@/lib/icon-set-store";
import type { SessionView } from "@/lib/sessions";
import type { IconSetRow } from "./settings/icon-set-settings";
import type { FileNoteLine } from "./use-settings-file";

const RUNTIME_EVENT = "settings-runtime";
const REQUEST_EVENT = "settings-runtime-request";

/** A project in the current sessions, for the icon set rows */
export interface RunningProject {
  slug: string;
  label: string;
}

export interface SettingsRuntime {
  running: RunningProject[];
  /** Watched folders that failed to scan */
  brokenIds: string[];
  /** This launch's changes from the settings file and refused values, latest first */
  settingsFile: FileNoteLine[];
}

export const EMPTY_RUNTIME: SettingsRuntime = { running: [], brokenIds: [], settingsFile: [] };

/** The current sessions' projects, one per slug, by label. Sessions are sorted by time since their last write, which
 * changes on every poll, so keeping their order would reorder the rows' controls every 3 seconds */
export function runningProjects(sessions: readonly SessionView[]): RunningProject[] {
  const seen = new Set<string>();
  const running: RunningProject[] = [];
  for (const s of sessions) {
    if (seen.has(s.slug)) continue;
    seen.add(s.slug);
    // Per project: the project's name, not a session's name told apart from another (docs/design/display-names.md "Display names")
    running.push({ slug: s.slug, label: s.projectBase ?? s.project });
  }
  return running.sort((a, b) => a.label.localeCompare(b.label));
}

/** Rows of the icon set settings: the running projects, then the projects with only a saved assignment left, each
 * group by label */
export function iconSetRowsOf(running: readonly RunningProject[], assignments: IconSetAssignments): IconSetRow[] {
  const seen = new Set(running.map((r) => r.slug));
  const savedOnly = Object.entries(assignments)
    .filter(([slug]) => !seen.has(slug))
    .map(([slug, a]) => ({ slug, label: a.label, running: false }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...running.map((r) => ({ ...r, running: true })), ...savedOnly];
}

/** The floating window: sends the runtime to the settings window when it changes and when asked */
export function usePublishSettingsRuntime(runtime: SettingsRuntime): void {
  const json = JSON.stringify(runtime);
  const latest = useRef(json);
  latest.current = json;
  useEffect(() => {
    void import("@tauri-apps/api/event")
      .then(({ emitTo }) => emitTo("settings", RUNTIME_EVENT, JSON.parse(json)))
      .catch(() => {});
  }, [json]);
  useEffect(() => {
    let stop: (() => void) | undefined;
    let stopped = false;
    void import("@tauri-apps/api/event")
      .then(({ emitTo, listen }) =>
        listen(REQUEST_EVENT, () => void emitTo("settings", RUNTIME_EVENT, JSON.parse(latest.current))),
      )
      .then((f) => (stopped ? f() : (stop = f)))
      .catch(() => {});
    return () => {
      stopped = true;
      stop?.();
    };
  }, []);
}

/** The settings window: the floating window's runtime, asked for on load. Outside the app (the browser mock) it comes
 * from `fallback` */
export function useSettingsRuntime(fallback?: () => Promise<SettingsRuntime>): SettingsRuntime {
  const [runtime, setRuntime] = useState<SettingsRuntime>(EMPTY_RUNTIME);
  useEffect(() => {
    let stop: (() => void) | undefined;
    let stopped = false;
    void (async () => {
      try {
        const { emitTo, listen } = await import("@tauri-apps/api/event");
        const f = await listen<SettingsRuntime>(RUNTIME_EVENT, (e) => setRuntime(e.payload));
        if (stopped) return f();
        stop = f;
        await emitTo("main", REQUEST_EVENT);
      } catch {
        if (fallback && !stopped) setRuntime(await fallback());
      }
    })();
    return () => {
      stopped = true;
      stop?.();
    };
    // The fallback is read once, on load
  }, []);
  return runtime;
}
