import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadPersistedEvents, type SessionEvent } from "@/lib/sessions";

type SaveStatus = "idle" | "saved";

// Time until the save feedback automatically goes back to idle
const SAVE_FEEDBACK_MS = 2000;

// Same value as POLL_MS (scan loop interval) in App.tsx. The event log's polling reload uses
// the same interval (duplicated here as a local constant instead of adding another export to App.tsx)
const DEBUG_POLL_MS = 3_000;

// Separator between the parent project and the chick name ("parent · chick name") in the project of chick
// (subagent) events. The desktop app doesn't produce chick events now; this only groups such entries if the
// persistent log has them
const CHICK_PROJECT_SEPARATOR = " · ";

// Normalizes a chick's project value ("parent · chick name") to just the parent project name.
// Returns it unchanged if there's no separator (events of the parent project itself)
function parentProject(project: string): string {
  const idx = project.indexOf(CHICK_PROJECT_SEPARATOR);
  return idx === -1 ? project : project.slice(0, idx);
}

// Collapses characters that can't be used in file names (spaces, /, (), etc.) into "-".
// Runs of invisible characters/symbols become a single "-", and leading/trailing "-" are removed (e.g. "base (root)" → "base-root").
// Collisions after sanitizing are accepted (requirement).
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

// Opened as a screen (like settings) from App.tsx's header (opening directly with ?debug=1 only makes showDebug's
// initial value true; after that the URL is never touched). Lists as is the persistent history of fired
// event decisions that lib/session-event-log.ts stores (eventLog in lib/settings-store.ts). Never touches real data, root settings,
// BYOK, etc. It's a debug screen, so there's no i18n and hardcoded English is fine
// (public/_locales is generated, so it isn't touched).
//
// Opening/closing (showDebug state) has no effect at all on App's scan loop.
export default function DebugApp({ onClose }: { onClose: () => void }) {
  const [events, setEvents] = useState<SessionEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Save result per project name (for the button's temporary feedback)
  const [saveStatus, setSaveStatus] = useState<Record<string, SaveStatus>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // ref for taking the document to attach the Escape listener to from the real element (see the keydown effect below)
  const overlayRef = useRef<HTMLDivElement>(null);

  // While open, reload every DEBUG_POLL_MS to keep the list up to date. The key (SessionEvent.key) comes from
  // sessionId/at/type and is stable, so when setState replaces the list React applies the diff and
  // existing rows keep their DOM (the scroll position doesn't jump)
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await loadPersistedEvents();
        if (cancelled) return;
        setEvents(next);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        console.warn("[tomarigi] failed to load the event log", e);
        setError("Couldn't load the event log");
      }
    };
    void load();
    const interval = setInterval(() => void load(), DEBUG_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
      for (const timer of Object.values(saveTimers.current)) clearTimeout(timer);
    };
  }, []);

  // Close on Escape (same as settings)
  useEffect(() => {
    const doc = overlayRef.current?.ownerDocument ?? document;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    doc.addEventListener("keydown", onKeyDown);
    return () => doc.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Newest first (persisted with the newest at the end, so reverse it for display)
  const sorted = events ? [...events].sort((a, b) => b.at - a.at) : [];

  // Deduplicated list of parent project names (chick projects are normalized to the parent name for grouping.
  // sorted is newest first, so this is in order of most recent event)
  const projects = Array.from(new Set(sorted.map((e) => parentProject(e.project))));

  // Downloads the events of the given parent project (including chick events) as JSON, newest first
  // (lands at ~/Downloads/tomarigi-eventlog-<project>.json. If a file with the same name exists,
  // " (1)" etc. is appended like Chrome does, so readers should read the newest mtime matching the pattern.
  // The clipboard isn't used because it is volatile and has ownership problems)
  const saveProject = async (project: string) => {
    const targetEvents = sorted.filter((e) => parentProject(e.project) === project);
    // WKWebView has no <a download> downloads, so Rust writes to ~/Downloads
    // (the same place Chrome downloaded to in tomarigi)
    try {
      await invoke("save_download", {
        name: `tomarigi-eventlog-${sanitizeFilename(project)}.json`,
        content: JSON.stringify(targetEvents, null, 2),
      });
    } catch (e) {
      console.warn("[tomarigi] failed to save the event log", e);
      return;
    }
    setSaveStatus((prev) => ({ ...prev, [project]: "saved" }));
    clearTimeout(saveTimers.current[project]);
    saveTimers.current[project] = setTimeout(() => {
      setSaveStatus((prev) => ({ ...prev, [project]: "idle" }));
    }, SAVE_FEEDBACK_MS);
  };

  return (
    // Shown in App's .page-body under the header, in place of the tabs' content, the same way as settings
    // (App renders the "‹ Back" row). Unmounting it doesn't affect App (the scan loop)
    <div className="debug-log" ref={overlayRef}>
        <p className="note">
          Persistent history of events fired by lib/sessions.ts (up to 500 entries, no TTL).
        </p>
        {error && <p className="note debug-log-error">{error}</p>}
        {!error && events === null && <p className="note">Loading…</p>}
        {!error && events !== null && sorted.length === 0 && (
          <p className="empty">No events recorded yet</p>
        )}
        {!error && projects.length > 0 && (
          <div className="debug-save-list">
            {projects.map((project) => {
              const status = saveStatus[project] ?? "idle";
              return (
                <button
                  key={project}
                  type="button"
                  className="debug-save-btn"
                  onClick={() => void saveProject(project)}
                >
                  {status === "saved" ? "Saved" : `Save ${project}`}
                </button>
              );
            })}
          </div>
        )}
        {!error && sorted.length > 0 && (
          <ul className="debug-log-list">
            {sorted.map((e) => (
              <li key={e.key} className="debug-log-row">
                <span className="debug-log-time">
                  {new Date(e.at).toLocaleString()}
                  {/* firedAt: the actual time the timeout fired after the hold was lifted. at stays fixed as the key basis (the parent's
                      turn end time), so the time it actually sounded (or didn't) is shown separately here */}
                  {e.firedAt !== undefined && (
                    <span className="debug-log-fired-at">
                      (fired at {new Date(e.firedAt).toLocaleString()})
                    </span>
                  )}
                </span>
                <span className={`debug-log-type debug-log-type-${e.type}`}>{e.type}</span>
                {/* muted: a done held back while waiting for chicks that was canceled by the parent restarting.
                    Stays in the log but doesn't sound (see deriveDoneEvent in lib/session-events.ts) */}
                {e.muted && <span className="debug-log-muted-badge">muted</span>}
                {/* Jev's needs-reply verdict (lib/jev.ts). The probability is that of yes (needs reply) */}
                {e.ask && (
                  <span className="debug-log-ask">
                    jev {e.ask.status}
                    {e.ask.probability !== undefined && ` ${e.ask.probability.toFixed(2)}`}
                    {e.ask.errorKind && ` (${e.ask.errorKind})`}
                  </span>
                )}
                {/* Jev's abuse verdict for the user message of a started event. The probability is that of yes (abusive) */}
                {e.anger && (
                  <span className="debug-log-ask">
                    anger {e.anger.status}
                    {e.anger.probability !== undefined && ` ${e.anger.probability.toFixed(2)}`}
                    {e.anger.errorKind && ` (${e.anger.errorKind})`}
                  </span>
                )}
                <span className="debug-log-project">{e.project}</span>
                {e.snippet && <span className="debug-log-snippet">“{e.snippet}”</span>}
                <span className="debug-log-key">{e.key}</span>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
