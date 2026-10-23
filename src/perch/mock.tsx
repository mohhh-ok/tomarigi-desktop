import { useCallback, useRef, useState } from "react";
import type { SessionEvent, SessionView } from "@/lib/sessions";
import type { PerchSource } from "./source";
import { AGENTS } from "@/lib/agents";
import { NativeDirectoryHandle } from "@/lib/native-fs";
import type { RootEntry } from "@/lib/settings-store";
import { DEFAULT_PRESET, PRESETS } from "./mock-presets";
import { GARDEN_ARRANGE_EVENT } from "./garden-menu";
import { CONCIERGE_ONLY_EVENT } from "./concierge-only";
import { bubbleText } from "./bubble";
import { needsAnswer } from "@/lib/turn-verdict";
import type { ConciergeAdvice } from "@/lib/concierge";

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

// The default watched folder of every agent, as the real settings list them when they all exist
const MOCK_ROOTS: RootEntry[] = AGENTS.map((agent) => {
  const path = `/Users/me/${agent.home}`;
  return { id: `default:${agent.kind}`, kind: agent.kind, label: agent.label, path, builtin: true, handle: new NativeDirectoryHandle(path) };
});

/** Creates one instance bundling the PerchSource implementation and the operation API MockPanel uses.
 * boot.tsx creates one of these and passes it to both App and MockPanel, so
 * edits in the panel are reflected immediately (through subscribe in App.tsx) */
/** ?birds=<n> adds n plain birds to the preset (for checking a garden with more birds than the window can hold) */
function withExtraBirds(data: MockData): MockData {
  const n = Number(new URLSearchParams(location.search).get("birds"));
  if (!(n > 0)) return data;
  const extra: SessionView[] = Array.from({ length: n }, (_, i) => ({
    id: `mock/extra/${i}`,
    project: `extra-${i + 1}`,
    slug: `extra-${i + 1}`,
    state: i % 3 === 0 ? "working" : "done",
    sinceMs: (i + 1) * 7_000,
  }));
  return { ...data, sessions: [...data.sessions, ...extra] };
}

/**
 * ?concierge=<text> shows the concierge with that advice (empty: a default line, in Japanese on a Japanese screen) about
 * the first bird that needs a reply, or the first bird; ?concierge=none shows it without advice. Without the parameter the
 * real concierge is asked (only with a saved key). For checking the concierge's look without calling the API
 * (docs/design.md "Concierge")
 */
const MOCK_CONCIERGE = new URLSearchParams(location.search).get("concierge");

function mockConciergeAdvice(sessions: SessionView[]): ConciergeAdvice | null | undefined {
  if (MOCK_CONCIERGE === null) return undefined;
  if (MOCK_CONCIERGE === "none") return null;
  const target = sessions.find((s) => needsAnswer(s.state, s.ask)) ?? sessions[0];
  if (!target) return null;
  const line = navigator.language.startsWith("ja")
    ? `${target.project}に先に返事をしましょう。いちばん長く待っています`
    : `Reply to ${target.project} first — it has waited longest`;
  return { line: MOCK_CONCIERGE || line, targetId: target.id };
}

// ?conciergeSummary=fail makes "What's going on?" fail, =slow keeps it on its way for 20 seconds (for checking those looks)
const MOCK_SUMMARY = new URLSearchParams(location.search).get("conciergeSummary");
// ?conciergeSummaryText=<text> answers with that text instead (lines split by line breaks), e.g. a line with no name
const MOCK_SUMMARY_TEXT = new URLSearchParams(location.search).get("conciergeSummaryText");

/** "What's going on?" without the API: the sessions that need a reply, then working, then finished, after a short wait */
function mockConciergeSummary(sessions: SessionView[]): Promise<string> | undefined {
  if (MOCK_CONCIERGE === null) return undefined;
  const ja = navigator.language.startsWith("ja");
  const names = (list: SessionView[]) => list.map((s) => s.project).join(ja ? "・" : ", ");
  const waiting = sessions.filter((s) => needsAnswer(s.state, s.ask));
  const working = sessions.filter((s) => s.state === "working");
  const done = sessions.filter((s) => !needsAnswer(s.state, s.ask) && s.state !== "working");
  // In the form asked of the real concierge (lib/concierge-summary.ts): a waiting session with what it waits for, a
  // finished one with what it did
  const about = (s: SessionView) => bubbleText(s) ?? (ja ? "許可か質問への返事" : "a permission or a question");
  const lines = [
    ...waiting.map((s) => (ja ? `${s.project}: ${about(s)}（返事待ち）` : `${s.project}: ${about(s)} (needs reply)`)),
    ...(working.length > 0
      ? [ja ? `${names(working)}は作業中です` : `${names(working)} ${working.length > 1 ? "are" : "is"} working`]
      : []),
    ...done.map((s) => {
      const did = bubbleText(s);
      return did ? (ja ? `${s.project}: ${did}（完了）` : `${s.project}: ${did} (done)`) : ja ? `${s.project}（完了）` : `${s.project} (done)`;
    }),
  ].slice(0, 6);
  if (MOCK_SUMMARY_TEXT) lines.splice(0, lines.length, MOCK_SUMMARY_TEXT);
  const wait = MOCK_SUMMARY === "slow" ? 20_000 : 900;
  return new Promise((resolve, reject) =>
    setTimeout(() => (MOCK_SUMMARY === "fail" ? reject(new Error("mock")) : resolve(lines.join("\n"))), wait),
  );
}

export function createMockSource(): MockSource {
  let data: MockData = withExtraBirds(INITIAL_PRESET.build());
  const listeners = new Set<() => void>();
  const setData = (next: MockData) => {
    data = next;
    for (const cb of listeners) cb();
  };
  startCycle(() => data, setData);

  return {
    usesRoots: false,
    displayRoots: MOCK_ROOTS,
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
    conciergeAdvice: mockConciergeAdvice,
    conciergeSummary: mockConciergeSummary,
    // ?focusable=1: birds, rows and the names in the summary and its advice look clickable, and a click logs
    // "[mock] focus <id>"
    focusLogOnly: new URLSearchParams(location.search).has("focusable"),
    setData,
  };
}

/**
 * ?cycle=<seconds> (TOMARIGI_QUERY="preset=mix&cycle=4"): every few seconds, change one thing on the preset's birds in
 * turn (a bubble appears / goes, a tool line appears / goes, a watch link forms / goes, a bird joins / leaves). For
 * checking with timed screenshots that the Garden's other birds stay where they are (docs/design.md "Layout").
 * Each step is logged as "[mock-cycle] <step>"
 */
function startCycle(get: () => MockData, set: (next: MockData) => void) {
  const seconds = Number(new URLSearchParams(location.search).get("cycle"));
  if (!(seconds > 0)) return;
  const at = (i: number) => get().sessions[i]?.id;
  const edit = (id: string | undefined, patch: (s: SessionView) => SessionView) => {
    const d = get();
    set({ ...d, sessions: d.sessions.map((s) => (s.id === id ? patch(s) : s)) });
  };
  const link = (a: string | undefined, b: string | undefined, on: boolean) => {
    const d = get();
    const now = Date.now();
    set({
      ...d,
      sessions: d.sessions.map((s) => {
        const other = s.id === a ? b : s.id === b ? a : undefined;
        if (!other) return s;
        if (!on) return { ...s, peers: undefined, watching: undefined };
        return {
          ...s,
          startedAt: s.id === a ? now - 60 * 60_000 : now - 30 * 60_000,
          watching: s.id === a ? 1 : undefined,
          peers: [{ sessionId: other, viewId: other, name: other, active: true }],
        };
      }),
    });
  };
  const JOINER = "mock/cycle/joiner";
  const steps: [string, () => void][] = [
    ["bubble on bird 0", () => edit(at(0), (s) => ({ ...s, state: "done", toolName: undefined, summary: "Fixed the header spacing and checked the build" }))],
    ["tool line on bird 1", () => edit(at(1), (s) => ({ ...s, state: "working", toolName: "Bash" }))],
    ["bubble off bird 0", () => edit(at(0), (s) => ({ ...s, state: "working", summary: undefined, toolName: undefined }))],
    ["link birds 1 and 2", () => link(at(1), at(2), true)],
    ["bird joins", () => {
      const d = get();
      set({ ...d, sessions: [...d.sessions, { id: JOINER, project: "new-bird", slug: "new-bird", state: "working", sinceMs: 1_000, toolName: "Read" }] });
    }],
    ["tool line off bird 1", () => edit(at(1), (s) => ({ ...s, toolName: undefined, state: "done" }))],
    ["unlink birds 1 and 2", () => link(at(1), at(2), false)],
    ["bird leaves", () => {
      const d = get();
      set({ ...d, sessions: d.sessions.filter((s) => s.id !== JOINER) });
    }],
  ];
  let i = 0;
  setInterval(() => {
    const [name, run] = steps[i % steps.length];
    i++;
    run();
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("log", { line: `[mock-cycle] ${i} ${name}` }))
      .catch(() => {});
  }, seconds * 1000);
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
    "sessions[].ask: { status: pending | asking | not_asking | error }\n" +
    "sessions[].angry: boolean (the anger mark)\n" +
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
        {/* The Garden's right-click menu is native and doesn't show in a browser */}
        <button className="small" onClick={() => window.dispatchEvent(new Event(GARDEN_ARRANGE_EVENT))}>
          Arrange the Garden
        </button>
        {/* The same menu's "Concierge only" (shown with the concierge: concierge=<text> in the URL) */}
        <button className="small" onClick={() => window.dispatchEvent(new Event(CONCIERGE_ONLY_EVENT))}>
          Toggle "Concierge only"
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
