import { useCallback, useRef, useState } from "react";
import type { SessionEvent, SessionView } from "@/lib/sessions";
import type { PerchSource } from "./source";
import { DEFAULT_PRESET, PRESETS } from "./mock-presets";

// Presets at launch. Choose with ?preset=<id> (TOMARIGI_QUERY="preset=asking" etc.). For checking screenshots
const INITIAL_PRESET =
  PRESETS.find((p) => p.id === new URLSearchParams(location.search).get("preset")) ?? DEFAULT_PRESET;

interface MockData {
  sessions: SessionView[];
  events: SessionEvent[];
}

interface MockSource extends PerchSource {
  getData(): MockData;
  setData(next: MockData): void;
}

// scan() is called on every poll (every 3 seconds). mock has no concept of "broken roots", so brokenIds can
// always be an empty array, but creating a new [] each time makes setBrokenIds in App.tsx keep
// receiving an array with a new reference, so re-renders keep happening on every poll even when the value is the same
// (spreading into the Garden's motion/AnimatePresence tree). Pinned to a single module constant.
const NO_BROKEN: string[] = [];

/** Creates one instance bundling the PerchSource implementation and the operation API MockPanel uses.
 * boot.tsx creates one of these and passes it to both App and MockPanel, so
 * edits in the panel are reflected immediately (through subscribe in App.tsx) */
export function createMockSource(): MockSource {
  let data: MockData = INITIAL_PRESET.build();
  const listeners = new Set<() => void>();

  return {
    usesRoots: false,
    async scan() {
      // Return the current sessions/events as is (no copy). This reference never changes except through
      // setData, so App.tsx keeps receiving the same array reference as long as the value doesn't change
      return { views: data.sessions, brokenIds: NO_BROKEN, events: data.events };
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getData() {
      return data;
    },
    setData(next) {
      data = next;
      for (const cb of listeners) cb();
    },
  };
}

export function MockPanel({ source }: { source: MockSource }) {
  const [presetId, setPresetId] = useState<string>(INITIAL_PRESET.id);
  const [draft, setDraft] = useState<string>(() => JSON.stringify(INITIAL_PRESET.build(), null, 2));
  const [parseError, setParseError] = useState<string | null>(null);

  const applyPreset = useCallback(
    (id: string) => {
      const preset = PRESETS.find((p) => p.id === id) ?? DEFAULT_PRESET;
      const next = preset.build();
      setPresetId(preset.id);
      source.setData(next);
      setDraft(JSON.stringify(next, null, 2));
      setParseError(null);
    },
    [source],
  );

  const applyDraft = useCallback(() => {
    try {
      const parsed = JSON.parse(draft);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.events)) {
        setParseError("Enter JSON that contains sessions and events (arrays)");
        return;
      }
      source.setData({ sessions: parsed.sessions, events: parsed.events });
      setParseError(null);
    } catch (e) {
      setParseError(String((e as Error).message ?? e));
    }
  }, [draft, source]);

  // For checking Garden animations: trigger birds entering/leaving by hand.
  // Add = enter from above / Sleep = switch to the dozing sprite / Wake = back to working / Close = fade
  const mockBirdSeq = useRef(0);
  const addBird = useCallback(() => {
    const n = ++mockBirdSeq.current;
    const d = source.getData();
    source.setData({
      ...d,
      sessions: [
        ...d.sessions,
        { id: `mock/anim/${n}`, project: `new-bird-${n}`, slug: `new-bird-${n}`, state: "working", sinceMs: 1_000 },
      ],
    });
  }, [source]);
  const sleepBird = useCallback(() => {
    const d = source.getData();
    const target = d.sessions.find((s) => s.state !== "dozing");
    if (!target) return;
    source.setData({
      ...d,
      sessions: d.sessions.map((s) => (s.id === target.id ? { ...s, state: "dozing" as const } : s)),
    });
  }, [source]);
  const wakeBird = useCallback(() => {
    const d = source.getData();
    const target = d.sessions.find((s) => s.state === "dozing");
    if (!target) return;
    source.setData({
      ...d,
      sessions: d.sessions.map((s) => (s.id === target.id ? { ...s, state: "working" as const } : s)),
    });
  }, [source]);
  const closeBird = useCallback(() => {
    const d = source.getData();
    const target = d.sessions[d.sessions.length - 1];
    if (!target) return;
    source.setData({ ...d, sessions: d.sessions.filter((s) => s.id !== target.id) });
  }, [source]);

  const hint =
    "sessions[].state: working | waiting | done | dozing\n" +
    "sessions[].ask: { status: pending | asking | not_asking | error, probability? }\n" +
    "sessions[].anger: { status: pending | angry | calm | error, probability? }\n" +
    "sessions[].question / summary: speech bubble text\n" +
    "sessions[].peers / watching: linked sessions and how many are working\n" +
    "events[].type: started | done | waiting | closed";

  return (
    <section className="mock-panel">
      <h2>mock controls</h2>
      {/* Checking Garden animations: trigger enter/leave events by hand */}
      <div className="mock-preset-row">
        <button className="small" onClick={addBird}>
          + Add a bird (from the sky)
        </button>
        <button className="small" onClick={sleepBird}>
          Put one to sleep (dozing)
        </button>
        <button className="small" onClick={wakeBird}>
          Wake one up
        </button>
        <button className="small" onClick={closeBird}>
          Close one (fade out)
        </button>
      </div>
      <div className="mock-preset-row">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            className={`small ${p.id === presetId ? "mock-preset-active" : ""}`}
            onClick={() => applyPreset(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="mock-hint">{hint}</p>
      <textarea
        className="mock-editor"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        rows={16}
      />
      <div className="mock-editor-actions">
        <button className="small" onClick={applyDraft}>
          Apply JSON
        </button>
        {parseError && <span className="mock-error">{parseError}</span>}
      </div>
    </section>
  );
}
