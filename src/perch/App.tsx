import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  MdBugReport,
  MdCheckCircle,
  MdClose,
  MdContentCopy,
  MdHelp,
  MdSettings,
  MdVolumeUp,
} from "react-icons/md";
import { t, uiLanguage } from "@/lib/i18n";
import { summarizeTurnLine } from "@/lib/summarize";
import { lastSentence } from "@/lib/last-sentence";
import { chirpDone, chirpWaiting, primeAudio, setChirpVolume } from "@/lib/chirp";
import {
  deleteAiProvider,
  deleteApiKey,
  initApiKeys,
  loadActiveAiProvider,
  loadAiProvider,
  loadApiKeyStatus,
  loadChirpVolume,
  loadMuted,
  loadRoots,
  loadVoiceEnabled,
  loadVoiceVolume,
  pickNewRoot,
  queryRead,
  resolveAiProvider,
  saveAiProvider,
  saveApiKey,
  saveChirpVolume,
  saveMuted,
  saveRoots,
  saveVoiceEnabled,
  saveVoiceVolume,
  type RootEntry,
  type RootKind,
  type AiProvider,
  type ApiKeyProvider,
} from "@/lib/fsa";
import {
  loadIconSetAssignments,
  saveIconSetAssignments,
  type IconSetAssignments,
  type IconSetId,
} from "@/lib/icon-set-store";
import { focusSession, focusTargetOf } from "@/lib/ghostty";
import { testJudgeConnection, type JudgeErrorKind } from "@/lib/judge";
import { testOpenAiConnection } from "@/lib/openai-judge";
import { judgeAsking, testTypeSafeConnection, type AskJudgement } from "@/lib/jev";
import { recordAskJudgement, type SessionEvent, type SessionView } from "@/lib/sessions";
import { cancelSpeech, setVoiceVolume, speakDoneEvent, speakEvent } from "@/lib/voice";
import DebugApp from "./DebugApp";
import { Garden } from "./garden";
import { bubbleText } from "./bubble";
import {
  DEFAULT_ICON_SET,
  ICON_SET_IDS,
  ICON_SET_LABEL,
  ICON_SETS,
  resolveIconSet,
} from "./icon-sets";
import { type PerchSource } from "./source";
import { EVENT, EventFeed, Perch } from "./stage";
import { currentWindowMode, useWindowMode } from "./window-mode";

const POLL_MS = 3_000;

// Chirps fire from ScanResult.events (issue #6). Which chirp maps to each event type
// (started/closed don't chirp)
const EVENT_CHIRP: Partial<Record<SessionEvent["type"], () => void>> = {
  done: chirpDone,
  waiting: chirpWaiting,
};

// Within this long of an event's at, it counts as "new" and chirps. A freshness guard so that events that already happened
// in the past, reconstructed by the scan right after launch, don't chirp (see the comment inside tick below)
const EVENT_FRESHNESS_MS = 30_000;

type Phase = "loading" | "ready";

// Tabs switch the view (Perch, events, Garden). No persistence needed, so useState only.
// Settings are a separate level (⚙ button → settings view), so they aren't a Tab
type Tab = "perch" | "events" | "garden";

// Grabbing the window background moves the whole window (the PiP of the tomarigi Chrome extension could only be
// moved by its top bar). Excludes clickable controls, text inputs, birds (garden drag), and scrolling lists
const NO_WINDOW_DRAG =
  "button, input, select, textarea, a, label, kbd, code, .garden-node, .garden-nest, .bird, .chick, .event-card, .debug-overlay, .mock-panel, .root-add-overlay";

interface Editing {
  id: string;
  draft: string;
}

// One row shown in IconSetSettings (issue #14). running=false is a row "not running now but with a saved
// assignment" (shown dimmed; see IconSetSettings)
interface IconSetRow {
  slug: string;
  label: string;
  running: boolean;
}

// Display state of the connection test button. reason is a technical identifier (kind) embedded as is into
// $REASON$ of byokTestResultFailure, and is not localized (treated like an HTTP status).
// The key isn't only for judging, so the type name isn't limited to Judge either (JudgeErrorKind itself
// just reuses the existing name in lib/judge.ts)
/** Identifies a turn for the Jev verdict. Same basis as the done event key (sessionId + time of the last response) */
function turnKey(sessionId: string, at: number): string {
  return `${sessionId}:${at}`;
}

// TypeSafe's official site (linked from the settings description)
const TYPESAFE_SITE_URL = "https://typesafe.ai";

type ApiKeyTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success" }
  | { phase: "failure"; reason: JudgeErrorKind }
  | { phase: "no-key" };

export default function App({
  source,
  extraPanel,
}: {
  source: PerchSource;
  extraPanel?: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [roots, setRoots] = useState<RootEntry[]>([]);
  const [perms, setPerms] = useState<Record<string, PermissionState>>({});
  const [brokenIds, setBrokenIds] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  // The Garden is the most fun to watch = the face of the product, so it is the default tab
  // ?tab=perch|events / ?settings=1 choose the screen at launch (for checking screenshots; TOMARIGI_QUERY in the README)
  const [tab, setTab] = useState<Tab>(() => {
    const q = new URLSearchParams(location.search).get("tab");
    return q === "perch" || q === "events" ? q : "garden";
  });
  const [settingsOpen, setSettingsOpen] = useState(
    () => new URLSearchParams(location.search).has("settings"),
  );
  // ?scrollTo=<class name> scrolls the window to that element at launch (for checking screenshots; TOMARIGI_QUERY in the README).
  // At the floating window's height the lower part of the settings isn't visible
  useEffect(() => {
    const target = new URLSearchParams(location.search).get("scrollTo");
    if (phase !== "ready" || !target || !/^[\w-]+$/.test(target)) return;
    document.querySelector(`.${target}`)?.scrollIntoView({ block: "center" });
  }, [phase]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [chirpVolume, setChirpVolumeState] = useState(1);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceVolume, setVoiceVolumeState] = useState(1);
  const [windowMode, setWindowMode] = useWindowMode();
  // API keys are a setting shared by the done readout summary (speakDoneEvent) and the connection test, so the name isn't limited to judge
  const [aiKeySet, setAiKeySet] = useState<Record<ApiKeyProvider, boolean>>({
    anthropic: false,
    openai: false,
    typesafe: false,
  });
  const [aiKeyTestState, setAiKeyTestState] = useState<Record<ApiKeyProvider, ApiKeyTestState>>({
    anthropic: { phase: "idle" },
    openai: { phase: "idle" },
    typesafe: { phase: "idle" },
  });
  // Jev verdict for needs reply (lib/jev.ts). Keyed by turn (turnKey). Turns whose check has started go into
  // askRequestedRef and aren't re-requested on every poll. Turns that leave the screen are dropped
  const [askJudgements, setAskJudgements] = useState<Record<string, AskJudgement>>({});
  const askRequestedRef = useRef(new Set<string>());
  const typeSafeKeySetRef = useRef(false);
  useEffect(() => {
    typeSafeKeySetRef.current = aiKeySet.typesafe;
  }, [aiKeySet.typesafe]);
  const [aiProvider, setAiProvider] = useState<AiProvider | null>(null);
  // Per-project icon set assignments (issue #14). A slug → {set, label} map.
  // Perch/Garden/IconSetSettings look up this map via resolveIconSet (lib/icon-set-store.ts)
  // and fall back to DEFAULT_ICON_SET when there is no assignment
  const [iconSetAssignments, setIconSetAssignments] = useState<IconSetAssignments>({});
  // When opened directly with ?debug=1, the debug log starts open. After that the URL is never touched;
  // it is treated as an in-page dialog opened and closed by this state alone
  const [showDebug, setShowDebug] = useState(
    () => new URLSearchParams(location.search).has("debug"),
  );
  const [rootDialogOpen, setRootDialogOpen] = useState(false);
  const closeDebug = useCallback(() => setShowDebug(false), []);
  const mutedRef = useRef(muted);
  const voiceEnabledRef = useRef(voiceEnabled);
  const scanBusyRef = useRef(false); // Prevents overlapping runs when a scan exceeds POLL_MS (prevents double chirps)
  // issue #6: every chirp fires from ScanResult.events (the old state-edge detection was removed).
  // Set of observed event keys. Remembers events that already chirped (or were judged for chirping) so the
  // same event doesn't chirp twice. Matching the "keep only recent ones" nature of sessionEventCache, it is
  // replaced on each scan with just the keys in the latest events (so it doesn't grow forever)
  const seenEventKeysRef = useRef<Set<string>>(new Set());
  // Never chirp on the first scan. Right after launch,
  // events that already happened in the past come back in events as is, so this prevents mistaking them
  // for new firings and chirping all at once
  const firstScanRef = useRef(true);
  const scanSignatureRef = useRef("");

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  useEffect(() => {
    void (async () => {
      // The mock source (source.usesRoots === false) doesn't use the roots/perms subsystem at all.
      // It leaves roots=[] and perms={} (the useState initial values) and skips the setup screen, watched
      // folder settings, and permission checks entirely
      if (source.usesRoots) {
        const loaded = await loadRoots();
        setRoots(loaded);
        const entries = await Promise.all(
          loaded.map(async (r) => [r.id, await queryRead(r)] as const),
        );
        setPerms(Object.fromEntries(entries));
      }
      setMuted(await loadMuted());
      const cVolume = await loadChirpVolume();
      setChirpVolumeState(cVolume);
      setChirpVolume(cVolume);
      setVoiceEnabled(await loadVoiceEnabled());
      const volume = await loadVoiceVolume();
      setVoiceVolumeState(volume);
      setVoiceVolume(volume);
      // Rust holds the keys (docs/design.md "BYOK API keys"). After migrating keys an earlier version left in IndexedDB
      // (the keychain version) and handing over from dev's IndexedDB, it only asks whether each key is saved
      try {
        await initApiKeys();
      } catch (e) {
        console.warn("[tomarigi] failed to initialize API keys", e);
      }
      const [keyStatus, preferredProvider] = await Promise.all([loadApiKeyStatus(), loadAiProvider()]);
      // Log whether each key is saved (a boolean only). Key values are never received or printed
      void invoke("log", {
        line: `[keys] status anthropic=${keyStatus.anthropic} openai=${keyStatus.openai} typesafe=${keyStatus.typesafe}`,
      });
      const resolvedProvider = resolveAiProvider(preferredProvider, keyStatus.anthropic, keyStatus.openai);
      setAiKeySet(keyStatus);
      setAiProvider(resolvedProvider ?? null);
      // Inconsistencies from old data or from deleting the key in use are normalized once to the available side.
      if (resolvedProvider && resolvedProvider !== preferredProvider) {
        await saveAiProvider(resolvedProvider);
      }
      setIconSetAssignments(await loadIconSetAssignments());
      setPhase("ready");
    })();
  }, []);

  // Unlock the AudioContext. WKWebView becomes running even without user interaction (docs/design.md "Findings from spikes"),
  // but call it both at launch and on the first pointer action just in case
  useEffect(() => {
    primeAudio();
    const unlock = () => primeAudio();
    document.addEventListener("pointerdown", unlock, { once: true });
    return () => document.removeEventListener("pointerdown", unlock);
  }, []);

  // Grab the window background to move the window (see NO_WINDOW_DRAG). Left button only
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest(NO_WINDOW_DRAG)) return;
      // A standard window moves by its title bar (so grabbing the background while maximized or fullscreen doesn't pull the window out)
      if (currentWindowMode() === "normal") return;
      void getCurrentWindow().startDragging();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  // Summarize the last response of a stopped turn into speech bubble text once, with BYOK (OpenAI / Anthropic)
  // (docs/design.md "Speech bubbles"). Nothing is shown without a key.
  // The result goes into turnLines and is attached as SessionView.summary at render. Once working, reply is gone and it disappears
  const [turnLines, setTurnLines] = useState<Record<string, string>>({});
  const turnLineRequestedRef = useRef(new Set<string>());
  const summaryKeySetRef = useRef(false);
  useEffect(() => {
    summaryKeySetRef.current = aiKeySet.anthropic || aiKeySet.openai;
  }, [aiKeySet.anthropic, aiKeySet.openai]);
  const requestTurnLines = useCallback((views: SessionView[]) => {
    const live = new Set<string>();
    for (const view of views) {
      // Views that already have a summary (mock) aren't summarized
      if (!view.reply || view.summary) continue;
      const key = turnKey(view.id, view.reply.at);
      live.add(key);
      if (!summaryKeySetRef.current || turnLineRequestedRef.current.has(key)) continue;
      turnLineRequestedRef.current.add(key);
      const { project, reply } = view;
      void (async () => {
        const provider = await loadActiveAiProvider();
        if (!provider) return;
        const result = await summarizeTurnLine(provider, {
          ui_language: uiLanguage(),
          assistant_text: reply.text,
        });
        const line = result.ok && typeof result.verdict.line === "string" ? result.verdict.line.trim() : "";
        void invoke("log", {
          line: `[bubble] ${result.ok ? `ok len=${line.length}` : `error=${result.kind}`} ${project}`,
        });
        if (!line) return;
        setTurnLines((current) =>
          turnLineRequestedRef.current.has(key) ? { ...current, [key]: line } : current,
        );
      })();
    }
    for (const key of turnLineRequestedRef.current) {
      if (!live.has(key)) turnLineRequestedRef.current.delete(key);
    }
    setTurnLines((current) => {
      const stale = Object.keys(current).filter((key) => !live.has(key));
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const key of stale) delete next[key];
      return next;
    });
  }, []);

  // Ask Jev once about a stopped turn (done / dozing with a reply). The done chirp and readout don't wait
  // for it. The result goes into askJudgements and is attached as SessionView.ask at render
  const requestAskJudgements = useCallback((views: SessionView[]) => {
    const live = new Set<string>();
    for (const view of views) {
      // Views that already have ask (mock) aren't sent to Jev
      if (!view.reply || view.ask) continue;
      const key = turnKey(view.id, view.reply.at);
      live.add(key);
      if (!typeSafeKeySetRef.current || askRequestedRef.current.has(key)) continue;
      askRequestedRef.current.add(key);
      const { id, project, reply } = view;
      setAskJudgements((current) => ({ ...current, [key]: { status: "pending" } }));
      void (async () => {
        const ask: AskJudgement = await judgeAsking(reply.text);
        setAskJudgements((current) => (key in current ? { ...current, [key]: ask } : current));
        recordAskJudgement(id, reply.at, ask);
        void invoke("log", {
          line: `[jev] ${ask.status} p=${ask.probability?.toFixed(2) ?? "-"}${ask.errorKind ? ` error=${ask.errorKind}` : ""} ${project}`,
        });
      })();
    }
    for (const key of askRequestedRef.current) {
      if (!live.has(key)) askRequestedRef.current.delete(key);
    }
    setAskJudgements((current) => {
      const stale = Object.keys(current).filter((key) => !live.has(key));
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const key of stale) delete next[key];
      return next;
    });
  }, []);

  useEffect(() => {
    if (phase !== "ready") return;
    const granted = roots.filter((r) => perms[r.id] === "granted");
    // The mock source (source.usesRoots === false) doesn't use roots/perms, so granted is always empty,
    // but that isn't the "lost access" state, so this early return is skipped and it goes on to scan
    // (the mock's scan() ignores granted and returns mock data)
    if (source.usesRoots && granted.length === 0) {
      setSessions([]);
      setBrokenIds([]);
      setEvents([]);
      // Resuming from the lost-access state is treated as a "first scan". Without resetting here, right after
      // re-granting, many old keys arrive as "unobserved" and chirp all at once
      seenEventKeysRef.current = new Set();
      firstScanRef.current = true;
      return;
    }
    let alive = true;
    const tick = async () => {
      if (scanBusyRef.current) return;
      scanBusyRef.current = true;
      try {
        const { views, brokenIds: broken, events: nextEvents } = await source.scan(granted);
        if (!alive) return;
        const now = Date.now();
        const seen = seenEventKeysRef.current;
        if (!firstScanRef.current) {
          for (const event of nextEvents) {
            if (seen.has(event.key)) continue;
            // A muted done (where the release after holding back for chicks was canceled by the parent's restart;
            // see deriveDoneEvent in lib/sessions.ts) stays in the log and feed but doesn't chirp
            if (event.muted) continue;
            // Freshness guard: even if unobserved, an event whose at is old (it happened earlier than the scan
            // interval) is treated as a reconstruction, not a new occurrence, and doesn't chirp.
            // If firedAt is present (a done fired by timeout after the hold), it is used as the actual firing time
            if (now - (event.firedAt ?? event.at) > EVENT_FRESHNESS_MS) continue;
            if (!mutedRef.current) EVENT_CHIRP[event.type]?.();
            void invoke("log", {
              line: `[event] ${event.type} ${event.project} chirp=${!mutedRef.current && Boolean(EVENT_CHIRP[event.type])} voice=${voiceEnabledRef.current}`,
            });
            // Readout is an opt-in setting independent of mute (chirps). See lib/voice.ts for constraints.
            // Only done is eligible for the summary readout (when an API key is set). speakDoneEvent branches
            // internally on whether a key exists, including fallback, so here it only needs to route by type
            if (voiceEnabledRef.current) {
              if (event.type === "done") {
                void speakDoneEvent(event, () => voiceEnabledRef.current);
              } else {
                speakEvent(event);
              }
            }
          }
        }
        // The observed set is replaced even while muted (so missed events don't all chirp at once after
        // unmuting). As with sessionEventCache, remembering only the recent events is enough
        // Write to the Rust log (/tmp/tomarigi-desktop/app-log.txt) only when the set of birds or their states change.
        // This is for checking against the actual transcripts without looking at the screen
        const signature = views.map((v) => `${v.id}:${v.state}`).join(",");
        if (signature !== scanSignatureRef.current) {
          scanSignatureRef.current = signature;
          const lines = views.map(
            (v) => `  ${v.state.padEnd(7)} ${v.project} ${v.id.split("/").slice(1).join("/")}`,
          );
          void invoke("log", { line: `[scan] ${views.length} sessions\n${lines.join("\n")}` });
        }
        seenEventKeysRef.current = new Set(nextEvents.map((e) => e.key));
        firstScanRef.current = false;
        requestAskJudgements(views);
        requestTurnLines(views);
        setSessions(views);
        setBrokenIds(broken);
        setEvents(nextEvents);
      } catch (e) {
        console.warn("[tomarigi] scan failed", e);
      } finally {
        scanBusyRef.current = false;
      }
    };
    void tick();
    const timer = setInterval(tick, POLL_MS);
    // The mock source should reflect data changes immediately without waiting for POLL_MS (so edits in
    // MockPanel show up right away). real has no subscribe, so this does nothing
    const unsub = source.subscribe?.(() => void tick());
    return () => {
      alive = false;
      clearInterval(timer);
      unsub?.();
    };
  }, [phase, roots, perms, source]);

  /** So that state and persistence don't silently diverge on failure, it warns and shows a message on screen */
  const persistRoots = useCallback(async (next: RootEntry[]) => {
    try {
      await saveRoots(next);
    } catch (e) {
      console.warn("[tomarigi] failed to save", e);
      setAddMessage(t("saveFailedMessage"));
    }
  }, []);

  const addRoot = useCallback(async (kind: RootKind) => {
    const result = await pickNewRoot(roots, kind);
    if (result === "cancelled") return;
    if (result === "duplicate") {
      setAddMessage(t("duplicateRootMessage"));
      return;
    }
    setAddMessage(null);
    const next = [...roots, result];
    setRoots(next);
    await persistRoots(next);
    const perm = await queryRead(result);
    setPerms((prev) => ({ ...prev, [result.id]: perm }));
  }, [roots, persistRoots]);

  const removeRoot = useCallback(
    async (id: string) => {
      const next = roots.filter((r) => r.id !== id);
      setRoots(next);
      await persistRoots(next);
      setPerms((prev) => {
        const rest = { ...prev };
        delete rest[id];
        return rest;
      });
      setEditing((prev) => (prev?.id === id ? null : prev));
    },
    [roots, persistRoots],
  );

  const startEdit = useCallback((root: RootEntry) => {
    setEditing({ id: root.id, draft: root.label });
  }, []);

  const cancelEdit = useCallback(() => setEditing(null), []);

  const commitEdit = useCallback(async () => {
    if (!editing) return;
    const { id, draft } = editing;
    setEditing(null);
    const trimmed = draft.trim();
    if (!trimmed) return; // If empty, keep the original value
    const next = roots.map((r) => (r.id === id ? { ...r, label: trimmed } : r));
    setRoots(next);
    await persistRoots(next);
  }, [editing, roots, persistRoots]);

  const toggleMuted = useCallback(() => {
    const next = !muted;
    setMuted(next);
    void saveMuted(next);
  }, [muted]);

  const toggleVoiceEnabled = useCallback(() => {
    const next = !voiceEnabled;
    setVoiceEnabled(next);
    void saveVoiceEnabled(next);
    // OFF is an "I want quiet" action, so speech that is playing or queued stops immediately too
    if (!next) cancelSpeech();
  }, [voiceEnabled]);

  // Slider (input shown as 0–100, internal value 0–1). The module variable in lib/voice.ts is read at the
  // "moment" of speaking, so here it is enough to apply it with setVoiceVolume right along with the state
  // update (the volume changes from the next utterance)
  const changeVoiceVolume = useCallback((next: number) => {
    setVoiceVolumeState(next);
    setVoiceVolume(next);
    void saveVoiceVolume(next);
  }, []);

  // Volume for chirps. Like masterGain in lib/chirp.ts it uses a module variable, so changes are applied
  // immediately with setChirpVolume (the preview buttons go through the same path, so a preview right after
  // moving the slider reflects it immediately)
  const changeChirpVolume = useCallback((next: number) => {
    setChirpVolumeState(next);
    setChirpVolume(next);
    void saveChirpVolume(next);
  }, []);

  /** After saving, the draft isn't kept anywhere (no plaintext key left in state) */
  // true if saved. On failure (can't write to the keychain, etc.) it returns false so the settings row shows the failure
  const saveAiKey = useCallback(async (provider: ApiKeyProvider, draft: string): Promise<boolean> => {
    const trimmed = draft.trim();
    if (!trimmed) return false;
    try {
      await saveApiKey(provider, trimmed);
    } catch (e) {
      void invoke("log", { line: `[keys] save failed ${provider}: ${String(e).slice(0, 120)}` }).catch(() => {});
      return false;
    }
    setAiKeySet((current) => ({ ...current, [provider]: true }));
    setAiKeyTestState((current) => ({ ...current, [provider]: { phase: "idle" } }));
    // The summary provider auto-selects the first key saved. If one is already selected, saving a second doesn't switch it.
    // TypeSafe isn't used for summaries, so it is excluded
    if (provider !== "typesafe" && !aiProvider) {
      await saveAiProvider(provider);
      setAiProvider(provider);
    }
    return true;
  }, [aiProvider]);

  const removeAiKey = useCallback(async (provider: ApiKeyProvider) => {
    await deleteApiKey(provider);
    const nextKeySet = { ...aiKeySet, [provider]: false };
    setAiKeySet(nextKeySet);
    setAiKeyTestState((current) => ({ ...current, [provider]: { phase: "idle" } }));
    if (aiProvider === provider) {
      const nextProvider = resolveAiProvider(
        undefined,
        nextKeySet.anthropic,
        nextKeySet.openai,
      );
      setAiProvider(nextProvider ?? null);
      if (nextProvider) await saveAiProvider(nextProvider);
      else await deleteAiProvider();
    }
  }, [aiKeySet, aiProvider]);

  const selectAiProvider = useCallback(async (provider: AiProvider) => {
    await saveAiProvider(provider);
    setAiProvider(provider);
  }, []);

  const runAiKeyTest = useCallback(async (provider: ApiKeyProvider) => {
    if (!(await loadApiKeyStatus())[provider]) {
      setAiKeyTestState((current) => ({ ...current, [provider]: { phase: "no-key" } }));
      return;
    }
    setAiKeyTestState((current) => ({ ...current, [provider]: { phase: "testing" } }));
    const result = await (provider === "typesafe"
      ? testTypeSafeConnection()
      : provider === "openai"
        ? testOpenAiConnection()
        : testJudgeConnection());
    setAiKeyTestState((current) => ({
      ...current,
      [provider]: result.ok ? { phase: "success" } : { phase: "failure", reason: result.kind },
    }));
  }, []);

  // Preview the three chirps individually (played in a row, you can't tell which sound is which state)
  const previewChirp = useCallback((chirp: () => void) => {
    primeAudio();
    chirp();
  }, []);

  /** Changes the assignment for one project. If set is DEFAULT_ICON_SET (birds), the entry itself is
   * deleted (the semantics "choosing birds = no assignment"; see lib/icon-set-store.ts). Otherwise it
   * upserts {set, label} (label is a snapshot of the display name at the time of selection).
   * Changes are saved and applied to state immediately (same as other settings) */
  const assignIconSet = useCallback(
    (slug: string, label: string, set: IconSetId) => {
      const next = { ...iconSetAssignments };
      if (set === DEFAULT_ICON_SET) {
        delete next[slug];
      } else {
        next[slug] = { set, label };
      }
      setIconSetAssignments(next);
      void saveIconSetAssignments(next);
    },
    [iconSetAssignments],
  );

  // Clicking a bird or row jumps to its Ghostty pane. mock doesn't use roots, so it can't be matched and does nothing
  const onFocusSession = useCallback(
    (id: string) => {
      void focusSession(id, roots).catch((e) => console.warn("[tomarigi] focus failed", e));
    },
    [roots],
  );
  const canFocus = useCallback((id: string) => focusTargetOf(id, roots) !== null, [roots]);

  const grantedCount = roots.filter((r) => perms[r.id] === "granted").length;
  // The mock source doesn't use roots/perms, so grantedCount is always 0, but that isn't the
  // "no access" state, so it isn't used for the empty-state branch of Perch/Garden
  const hasGranted = !source.usesRoots || grantedCount > 0;

  const showTabs = phase === "ready" && (!source.usesRoots || roots.length > 0);

  // Rows shown in the icon set settings = "projects in the current sessions (deduplicated by slug)"
  // ∪ "projects with only a saved assignment left". Running ones form the first group to prioritize
  // current usage, and within each group the order is fixed by label ascending. sessions is sorted by
  // sinceMs (time since the latest write), which goes back to 0 on every write, so keeping the order of
  // appearance would reorder the rows' <select> on every poll (3 seconds)
  // (the DOM node of an open <select> gets moved, and in Chrome an open dropdown actually closes).
  // Label ascending order is stable regardless of the order of sessions
  const iconSetRows = useMemo<IconSetRow[]>(() => {
    const seen = new Set<string>();
    const running: IconSetRow[] = [];
    for (const s of sessions) {
      if (seen.has(s.slug)) continue;
      seen.add(s.slug);
      running.push({ slug: s.slug, label: s.project, running: true });
    }
    running.sort((a, b) => a.label.localeCompare(b.label));
    const savedOnly = Object.entries(iconSetAssignments)
      .filter(([slug]) => !seen.has(slug))
      .map(([slug, a]) => ({ slug, label: a.label, running: false }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [...running, ...savedOnly];
  }, [sessions, iconSetAssignments]);

  // Attach the Jev verdict only to the bird of the same turn (if the turn changes, turnKey changes and it isn't attached).
  // mock holds ask directly, so it isn't overwritten
  const displaySessions = useMemo(() => {
    // Without a summary key (OpenAI / Anthropic), for a turn where the Jev verdict is needs reply, the last sentence of the
    // last response goes in the speech bubble (docs/design.md "Speech bubbles"; no AI used)
    const hasSummaryKey = aiKeySet.anthropic || aiKeySet.openai;
    return sessions.map((s) => {
      if (!s.reply) return s;
      const key = turnKey(s.id, s.reply.at);
      const ask = s.ask ?? askJudgements[key];
      return {
        ...s,
        ask,
        summary: s.summary ?? turnLines[key],
        replyTail: !hasSummaryKey && ask?.status === "asking" ? lastSentence(s.reply.text) : undefined,
      };
    });
  }, [sessions, askJudgements, turnLines, aiKeySet.anthropic, aiKeySet.openai]);

  // So that Recent activity and the garden markers also show a done as needs reply when the Jev verdict for that
  // turn is needs reply, attach the verdict to the done event of the same turn (sessionId + time of the last response)
  // Recent activity rows get the same text as that turn's speech bubble (bubbleText). No extra summary is requested;
  // only the current turn of birds on screen is used (it isn't put into the persistent event log)
  const displayEvents = useMemo(() => {
    const askByTurn = new Map<string, AskJudgement>();
    const lineByDoneTurn = new Map<string, string>();
    const lineByWaitingSession = new Map<string, string>();
    for (const s of displaySessions) {
      const line = bubbleText(s);
      if (s.reply) {
        const key = turnKey(s.id, s.reply.at);
        if (s.ask) askByTurn.set(key, s.ask);
        if (line) lineByDoneTurn.set(key, line);
      } else if (s.state === "waiting" && line) {
        lineByWaitingSession.set(s.id, line);
      }
    }
    if (askByTurn.size === 0 && lineByDoneTurn.size === 0 && lineByWaitingSession.size === 0) {
      return events;
    }
    return events.map((e) => {
      const key = turnKey(e.sessionId, e.at);
      const ask = e.type === "done" ? askByTurn.get(key) : undefined;
      const line =
        e.type === "done"
          ? lineByDoneTurn.get(key)
          : e.type === "waiting"
            ? lineByWaitingSession.get(e.sessionId)
            : undefined;
      return ask || line ? { ...e, ...(ask && { ask }), ...(line && { line }) } : e;
    });
  }, [events, displaySessions]);

  return (
    <main className="page">
      <div className="page-header">
        <h1 className="brand">tomarigi</h1>
        {/* Mute, debug, settings, and hide must always be visible on every tab, so they sit outside the tabs (in the header).
            There is no PiP button like the tomarigi Chrome extension has (the app window itself is an always-on-top floating window) */}
        <div className="header-controls">
          {showTabs && (
            <>
            <button
              className="small"
              onClick={toggleMuted}
              aria-label={t(muted ? "unmuteButtonAria" : "muteButtonAria")}
            >
              {muted ? "🔕" : "🔔"}
            </button>
            {/* A debug-only button, so no i18n; English is hardcoded (same policy as DebugApp.tsx) */}
            <button
              className={showDebug ? "small active" : "small"}
              onClick={() => setShowDebug((v) => !v)}
              aria-label="Debug log"
              title="Debug log"
              aria-pressed={showDebug}
            >
              <MdBugReport size={16} />
            </button>
            <button
              className={settingsOpen ? "small active" : "small"}
              onClick={() => setSettingsOpen((v) => !v)}
              aria-label={t("tabSettingsLabel")}
              aria-pressed={settingsOpen}
            >
              <MdSettings size={16} />
            </button>
            </>
          )}
          {/* Hides the window. It can be brought back from the menu bar icon */}
          <button
            className="small"
            onClick={() => void invoke("hide_window")}
            aria-label={t("closeButtonAria")}
            title={t("closeButtonAria")}
          >
            <MdClose size={16} />
          </button>
        </div>
      </div>
      {phase === "loading" && <p className="note">{t("loadingLabel")}</p>}
      {phase === "ready" && source.usesRoots && roots.length === 0 && (
        <section className="setup">
          <p>{t("setupIntro")}</p>
          <button onClick={() => setRootDialogOpen(true)}>{t("setupButton")}</button>
          {addMessage && <p className="add-message">{addMessage}</p>}
        </section>
      )}
      {/* The tomarigi Chrome extension grouped this with createPortal to move it into PiP; the desktop app has one window, so it renders directly */}
      <>
          {showTabs && (
            <>
              {/* While in settings, the tab bar is hidden and you go back via ⚙. Tabs are only the "views (Perch/events)";
                  settings are a separate level, so they aren't listed here */}
              {!settingsOpen && (
                <div className="tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    id="tab-btn-garden"
                    aria-selected={tab === "garden"}
                    aria-controls="tabpanel-garden"
                    className={tab === "garden" ? "tab-btn active" : "tab-btn"}
                    onClick={() => setTab("garden")}
                  >
                    {t("tabGardenLabel")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="tab-btn-perch"
                    aria-selected={tab === "perch"}
                    aria-controls="tabpanel-perch"
                    className={tab === "perch" ? "tab-btn active" : "tab-btn"}
                    onClick={() => setTab("perch")}
                  >
                    {t("tabPerchLabel")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="tab-btn-events"
                    aria-selected={tab === "events"}
                    aria-controls="tabpanel-events"
                    className={tab === "events" ? "tab-btn active" : "tab-btn"}
                    onClick={() => setTab("events")}
                  >
                    {t("eventFeedHeading")}
                  </button>
                </div>
              )}
              {/* Each tab panel stays mounted and is hidden with the hidden attribute (recreating it on every tab
                  switch would lose internal state such as Garden's). Same hidden while in settings */}
              <section
                role="tabpanel"
                id="tabpanel-events"
                aria-labelledby="tab-btn-events"
                hidden={settingsOpen || tab !== "events"}
              >
                <div className="stage stage-events">
                  <EventFeed
                    events={displayEvents}
                    showHeading={false}
                    onFocus={onFocusSession}
                    canFocus={canFocus}
                  />
                </div>
              </section>
              <section
                role="tabpanel"
                id="tabpanel-perch"
                aria-labelledby="tab-btn-perch"
                hidden={settingsOpen || tab !== "perch"}
              >
                <div className="stage stage-perch">
                  <Perch
                    sessions={displaySessions}
                    hasGranted={hasGranted}
                    iconSetAssignments={iconSetAssignments}
                    onFocus={onFocusSession}
                    canFocus={canFocus}
                  />
                </div>
              </section>
              <section
                role="tabpanel"
                id="tabpanel-garden"
                aria-labelledby="tab-btn-garden"
                hidden={settingsOpen || tab !== "garden"}
              >
                <div className="stage stage-garden">
                  <Garden
                    sessions={displaySessions}
                    events={displayEvents}
                    hasGranted={hasGranted}
                    iconSetAssignments={iconSetAssignments}
                    onFocus={onFocusSession}
                    canFocus={canFocus}
                  />
                </div>
              </section>
              <section className="settings-panel" hidden={!settingsOpen}>
                {/* Watched folder management is the roots/perms subsystem itself, so it is hidden entirely
                    in mock (no substitute). BYOK, volume, and readout settings work as the real thing
                    even in mock (see ApiKeySettings and voice-controls below) */}
                {source.usesRoots && (
                  <RootManager
                    roots={roots}
                    perms={perms}
                    brokenIds={brokenIds}
                    editing={editing}
                    addMessage={addMessage}
                    onRequestAdd={() => setRootDialogOpen(true)}
                    onRemove={removeRoot}
                    onStartEdit={startEdit}
                    onEditChange={(draft) => setEditing((prev) => (prev ? { ...prev, draft } : prev))}
                    onCommitEdit={commitEdit}
                    onCancelEdit={cancelEdit}
                  />
                )}
                <AiKeySettings
                  keySet={aiKeySet}
                  selectedProvider={aiProvider}
                  testState={aiKeyTestState}
                  onSaveKey={saveAiKey}
                  onDeleteKey={(provider) => void removeAiKey(provider)}
                  onTest={(provider) => void runAiKeyTest(provider)}
                  onSelect={(provider) => void selectAiProvider(provider)}
                />
                <IconSetSettings
                  rows={iconSetRows}
                  assignments={iconSetAssignments}
                  onChange={assignIconSet}
                />
                {/* The two notification toggles share one pattern: "parent checkbox + sub-rows directly below".
                    "Notify with sound" is the inverse of the existing muted state (checked = !muted). It shares
                    the same state as the header's 🔔/🔕 button (toggleMuted), so they stay in sync automatically.
                    Directly below come a volume slider only for chirps, then two preview buttons.
                    It is a setting independent of the readout (speechSynthesis) volume (the same idea as separate
                    SE/BGM volumes in games; see setChirpVolume in lib/chirp.ts).
                    "Read aloud" is the event readout (speechSynthesis). It is an opt-in setting, OFF by default,
                    with the readout volume slider directly below */}
                <div className="voice-controls">
                  <label className="voice-enable-row">
                    <input type="checkbox" checked={!muted} onChange={toggleMuted} />
                    {t("soundEnableLabel")}
                  </label>
                  {/* The chirp slider isn't disabled even when muted ("Notify with sound" OFF).
                      Reason: just as the preview buttons below can be pressed while muted, this supports the flow
                      "set the volume while previewing, then turn it ON". The readout slider (which has no preview
                      button) keeps the policy of being disabled by voiceEnabled (the uses differ: for readout the
                      meaning of the volume depends on the "speak or not" toggle, while chirps have previewing as a
                      way to check, so there is no reason to disable it) */}
                  <label className="settings-subrow volume-row">
                    {t("voiceVolumeLabel")}
                    <input
                      type="range"
                      className="volume-slider"
                      min={0}
                      max={100}
                      value={Math.round(chirpVolume * 100)}
                      onChange={(e) => changeChirpVolume(Number(e.target.value) / 100)}
                    />
                    <span className="volume-value">{Math.round(chirpVolume * 100)}%</span>
                  </label>
                  {/* Previewing is "listening to decide whether to turn it ON", so it isn't disabled even when
                      muted ("Notify with sound" OFF). Disabling it would defeat the purpose by blocking the natural
                      use of "try the sound, then turn it ON" (volume sliders change the setting itself, so they
                      keep the policy of being disabled by voiceEnabled) */}
                  <div className="settings-subrow sound-preview-row">
                    {/* Sounds fire on events, so the labels come from the event side too (state labels wouldn't match).
                        The button icons teach the same meaning as in the feed */}
                    <button className="small" onClick={() => previewChirp(chirpDone)}>
                      <MdVolumeUp size={14} className="preview-mic" />
                      <MdCheckCircle className="event-icon tone-done" size={18} /> {EVENT.done.label}
                    </button>
                    <button className="small" onClick={() => previewChirp(chirpWaiting)}>
                      <MdVolumeUp size={14} className="preview-mic" />
                      <MdHelp className="event-icon tone-turn" size={18} /> {EVENT.waiting.label}
                    </button>
                  </div>
                  <label className="voice-enable-row">
                    <input type="checkbox" checked={voiceEnabled} onChange={toggleVoiceEnabled} />
                    {t("voiceEnableLabel")}
                  </label>
                  {/* The volume value is kept even when voiceEnabled is OFF (the toggle is a switch for whether to
                      speak and is independent of volume). While OFF it is only disabled to prevent meaningless
                      adjustments; the value doesn't change */}
                  <label className="settings-subrow volume-row">
                    {t("voiceVolumeLabel")}
                    <input
                      type="range"
                      className="volume-slider"
                      min={0}
                      max={100}
                      value={Math.round(voiceVolume * 100)}
                      disabled={!voiceEnabled}
                      onChange={(e) => changeVoiceVolume(Number(e.target.value) / 100)}
                    />
                    <span className="volume-value">{Math.round(voiceVolume * 100)}%</span>
                  </label>
                </div>
                {/* Floating window / standard window (can also be changed from the menu bar menu; window-mode.ts) */}
                <section className="window-mode">
                  <h2>{t("windowModeHeading")}</h2>
                  <label className="voice-enable-row">
                    <input
                      type="radio"
                      name="window-mode"
                      checked={windowMode === "floating"}
                      onChange={() => setWindowMode("floating")}
                    />
                    {t("windowModeFloating")}
                  </label>
                  <label className="voice-enable-row">
                    <input
                      type="radio"
                      name="window-mode"
                      checked={windowMode === "normal"}
                      onChange={() => setWindowMode("normal")}
                    />
                    {t("windowModeNormal")}
                  </label>
                </section>
              </section>
            </>
          )}
          {/* An independent in-page dialog that doesn't affect App's scan loop at all */}
          {showDebug && <DebugApp onClose={closeDebug} />}
          {rootDialogOpen && (
            <RootAddDialog
              onClose={() => setRootDialogOpen(false)}
              onChoose={(kind) => {
                setRootDialogOpen(false);
                void addRoot(kind);
              }}
            />
          )}
      </>
      {/* Control panel only for the mock source (MockPanel passed by main.tsx) */}
      {extraPanel}
    </main>
  );
}

interface RootChoice {
  kind: RootKind;
  label: string;
  path: string;
  shortcut: string;
}

function rootChoicesForCurrentPlatform(): RootChoice[] {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? "";
  const windows = /windows|win32/i.test(platform);
  const mac = /mac/i.test(platform);
  const shortcut = mac ? "Cmd+Shift+G" : "Ctrl+L";
  return [
    {
      kind: "claude",
      label: "Claude Code",
      path: windows ? String.raw`%USERPROFILE%\.claude\projects` : "~/.claude/projects",
      shortcut,
    },
    {
      kind: "codex",
      label: "Codex",
      path: windows ? String.raw`%USERPROFILE%\.codex\sessions` : "~/.codex/sessions",
      shortcut,
    },
  ];
}

function RootAddDialog({
  onClose,
  onChoose,
}: {
  onClose: () => void;
  onChoose: (kind: RootKind) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copiedKind, setCopiedKind] = useState<RootKind | null>(null);
  const choices = useMemo(rootChoicesForCurrentPlatform, []);

  useEffect(() => {
    const doc = overlayRef.current?.ownerDocument ?? document;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    doc.addEventListener("keydown", onKeyDown);
    return () => doc.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const copyPath = async (choice: RootChoice) => {
    try {
      await navigator.clipboard.writeText(choice.path);
      setCopiedKind(choice.kind);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedKind(null), 1_500);
    } catch (error) {
      console.warn("[tomarigi] failed to copy the path to the clipboard", error);
    }
  };

  return (
    <div
      className="root-add-overlay"
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="root-add-dialog-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="root-add-dialog">
        <div className="root-add-dialog-header">
          <h2 id="root-add-dialog-title">{t("setupIntro")}</h2>
          <button
            className="small"
            onClick={onClose}
            aria-label={t("closeButtonAria")}
            title={t("closeButtonAria")}
          >
            <MdClose size={16} />
          </button>
        </div>
        <div className="root-add-choices">
          {choices.map((choice, index) => (
            <div key={choice.kind} className="root-add-choice">
              <button autoFocus={index === 0} onClick={() => onChoose(choice.kind)}>
                ＋ {choice.label}
              </button>
              <span className="root-add-hint">
                {t("setupPickPrefix")}
                <kbd>{choice.shortcut}</kbd>
                {t("setupPickMiddle")}
                <button
                  type="button"
                  className="root-path-copy"
                  onClick={() => void copyPath(choice)}
                  aria-label={`${t("copyPathButton")}: ${choice.path}`}
                  title={`${t("copyPathButton")}: ${choice.path}`}
                >
                  <code>{choice.path}</code>
                  {copiedKind === choice.kind ? (
                    <MdCheckCircle size={16} aria-hidden="true" />
                  ) : (
                    <MdContentCopy size={16} aria-hidden="true" />
                  )}
                </button>
                {t("setupPickSuffix")}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RootManager({
  roots,
  perms,
  brokenIds,
  editing,
  addMessage,
  onRequestAdd,
  onRemove,
  onStartEdit,
  onEditChange,
  onCommitEdit,
  onCancelEdit,
}: {
  roots: RootEntry[];
  perms: Record<string, PermissionState>;
  brokenIds: string[];
  editing: Editing | null;
  addMessage: string | null;
  onRequestAdd: () => void;
  onRemove: (id: string) => void;
  onStartEdit: (root: RootEntry) => void;
  onEditChange: (draft: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
}) {
  // Suppresses the blur that fires right after canceling with Escape from calling onCommitEdit and
  // committing over it (there is always at most one row being edited, so one shared flag is enough)
  const suppressBlurRef = useRef(false);

  return (
    <section className="roots">
      <h2>{t("rootsHeading")}</h2>
      <ul className="root-list">
        {roots.map((root) => {
          const perm = perms[root.id];
          const broken = brokenIds.includes(root.id);
          const isEditing = editing?.id === root.id;
          return (
            <li key={root.id} className="root-row">
              {isEditing ? (
                <input
                  className="root-label-input"
                  autoFocus
                  value={editing.draft}
                  placeholder={t("rootLabelPlaceholder")}
                  onChange={(e) => onEditChange(e.target.value)}
                  // In browsers where no blur follows Escape, a leftover flag would wrongly swallow the next
                  // blur commit, so always reset it on the focus that starts editing
                  onFocus={() => {
                    suppressBlurRef.current = false;
                  }}
                  onBlur={() => {
                    if (suppressBlurRef.current) {
                      suppressBlurRef.current = false;
                      return;
                    }
                    onCommitEdit();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onCommitEdit();
                    if (e.key === "Escape") {
                      suppressBlurRef.current = true;
                      onCancelEdit();
                    }
                  }}
                />
              ) : (
                <span className="root-label" title={root.path}>
                  {root.label}
                  {/* The label alone doesn't tell what it actually is (which config directory), so the path is added */}
                  <span className="root-path">{root.path.replace(/^\/Users\/[^/]+/, "~")}</span>
                </span>
              )}
              {/* Folders always watched by default (~/.claude/projects etc.). Can't be removed */}
              {root.builtin && <span className="badge badge-default">{t("rootDefaultBadge")}</span>}
              {/* The desktop app has no concept of read permission. Shown only when the folder is missing or unreadable */}
              {(broken || perm !== "granted") && (
                <span className="badge badge-error">{t("badgeUnreadable")}</span>
              )}
              {!isEditing && (
                <button className="small" onClick={() => onStartEdit(root)}>
                  {t("editLabelButton")}
                </button>
              )}
              {root.builtin ? (
                // Defaults can't be removed. Reserve only the × slot so the label edit button lines up with added rows
                <button
                  className="small remove root-remove-placeholder"
                  aria-hidden="true"
                  tabIndex={-1}
                  disabled
                >
                  ✕
                </button>
              ) : (
                <button
                  className="small remove"
                  onClick={() => onRemove(root.id)}
                  aria-label={t("removeButtonAria")}
                >
                  ✕
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <button onClick={onRequestAdd}>{t("addRootButton")}</button>
      {addMessage && <p className="add-message">{addMessage}</p>}
    </section>
  );
}

/** All API key settings. The shared description is shown once here; per-provider differences stay inside each row. */
function AiKeySettings({
  keySet,
  selectedProvider,
  testState,
  onSaveKey,
  onDeleteKey,
  onTest,
  onSelect,
}: {
  keySet: Record<ApiKeyProvider, boolean>;
  selectedProvider: AiProvider | null;
  testState: Record<ApiKeyProvider, ApiKeyTestState>;
  onSaveKey: (provider: ApiKeyProvider, draft: string) => Promise<boolean>;
  onDeleteKey: (provider: ApiKeyProvider) => void;
  onTest: (provider: ApiKeyProvider) => void;
  onSelect: (provider: AiProvider) => void;
}) {
  return (
    <section className="ai-keys">
      <h2>{t("aiApiKeysHeading")}</h2>
      <p className="judge-description">{t("aiApiKeysDescription")}</p>
      <div className="ai-key-provider-list">
        {(["anthropic", "openai", "typesafe"] as const).map((provider) => (
          <ApiKeyProviderSettings
            key={provider}
            provider={provider}
            keySet={keySet[provider]}
            selected={selectedProvider === provider}
            testState={testState[provider]}
            onSaveKey={(draft) => onSaveKey(provider, draft)}
            onDeleteKey={() => onDeleteKey(provider)}
            onTest={() => onTest(provider)}
            onSelect={provider === "typesafe" ? undefined : () => onSelect(provider)}
          />
        ))}
      </div>
    </section>
  );
}

function ApiKeyProviderSettings({
  provider,
  keySet,
  selected,
  testState,
  onSaveKey,
  onDeleteKey,
  onTest,
  onSelect,
}: {
  provider: ApiKeyProvider;
  keySet: boolean;
  selected: boolean;
  testState: ApiKeyTestState;
  onSaveKey: (draft: string) => Promise<boolean>;
  onDeleteKey: () => void;
  onTest: () => void;
  // Passed only for rows that can be chosen as the summary provider (TypeSafe is only for the needs-reply check, not summaries)
  onSelect?: () => void;
}) {
  // Temporary state held only by the key input before saving. Cleared and discarded after saving (no plaintext left behind)
  const [draft, setDraft] = useState("");
  // Whether the input for replacing a saved key is open. The key value isn't shown; you just enter a new one and save
  const [replacing, setReplacing] = useState(false);
  // Whether the last save failed. On failure the input is kept and the failure is shown on this row
  const [saveFailed, setSaveFailed] = useState(false);
  const heading =
    provider === "typesafe"
      ? t("typeSafeApiKeyHeading")
      : provider === "openai"
        ? t("openAiApiKeyHeading")
        : t("aiApiKeyHeading");

  return (
    <div className={`ai-key-provider ai-key-provider-${provider}`}>
      <h3>{heading}</h3>
      {provider === "typesafe" && (
        <p className="judge-description">
          {t("typeSafeApiKeyDescription")}{" "}
          {/* Link to the official site so users can see how to get a key. Opens in the external browser, not inside the WebView */}
          <a
            href={TYPESAFE_SITE_URL}
            className="external-link"
            onClick={(e) => {
              e.preventDefault();
              void openUrl(TYPESAFE_SITE_URL).catch(() => window.open(TYPESAFE_SITE_URL, "_blank"));
            }}
          >
            {t("typeSafeSiteLink")}
          </a>
        </p>
      )}
      <div className="judge-key-row">
        {keySet && !replacing ? (
          <>
            <span className="judge-key-set">{t("byokApiKeySetLabel")}</span>
            <button className="small" onClick={() => setReplacing(true)}>
              {t("byokReplaceButton")}
            </button>
            <button className="small remove" onClick={onDeleteKey}>
              {t("byokDeleteButton")}
            </button>
          </>
        ) : (
          <>
            <input
              className="judge-key-input"
              type="password"
              autoComplete="off"
              value={draft}
              placeholder={heading}
              aria-label={heading}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              className="small"
              onClick={() => {
                void onSaveKey(draft).then((saved) => {
                  setSaveFailed(!saved && draft.trim() !== "");
                  if (!saved) return;
                  setDraft("");
                  setReplacing(false);
                });
              }}
            >
              {t("byokSaveButton")}
            </button>
          </>
        )}
      </div>
      {saveFailed && (
        <p className="judge-status judge-status-error" role="alert">
          {t("byokSaveFailedMessage")}
        </p>
      )}
      {keySet && onSelect && (
        <label className="ai-provider-choice">
          <input
            type="radio"
            name="summary-provider"
            checked={selected}
            onChange={onSelect}
          />
          {t("byokUseForSummaryLabel")}
        </label>
      )}
      {/* Disabled when no key is set, to prevent an action that would only produce a no-key result */}
      <button className="small" onClick={onTest} disabled={!keySet}>
        {t("byokTestButton")}
      </button>
      {testState.phase === "testing" && (
        <p className="judge-status">{t("byokTestingLabel")}</p>
      )}
      {testState.phase === "success" && (
        <p className="judge-status judge-status-ok">
          {t("byokTestResultSuccess")}
        </p>
      )}
      {testState.phase === "failure" && (
        <p className="judge-status judge-status-error">
          {t("byokTestResultFailure", testState.reason)}
        </p>
      )}
      {testState.phase === "no-key" && (
        <p className="judge-status judge-status-error">
          {t("byokNoKeyMessage")}
        </p>
      )}
    </div>
  );
}

/**
 * Per-project icon set assignments (issue #14). Row = project (deduplicated by slug); each press of the
 * toggle button at the right end advances to the next set in ICON_SET_IDS order (after frog it wraps
 * around to birds). The rows are the union of "projects in the current sessions" ∪ "projects with only a
 * saved assignment left" (iconSetRows, computed in App.tsx). Rows not running are dimmed to tell them apart
 * (icon-set-row-idle). Switching back to "birds" deletes the assignment entry itself (the semantics
 * no entry = birds; see resolveIconSet in lib/icon-set-store.ts). Changes are saved and applied to state
 * immediately (like RootManager etc., there is no dedicated save button).
 */
function IconSetSettings({
  rows,
  assignments,
  onChange,
}: {
  rows: IconSetRow[];
  assignments: IconSetAssignments;
  onChange: (slug: string, label: string, set: IconSetId) => void;
}) {
  return (
    <section className="icon-sets">
      <h2>{t("iconSetHeading")}</h2>
      {rows.length === 0 ? (
        <p className="icon-set-empty">{t("iconSetEmpty")}</p>
      ) : (
        <ul className="icon-set-list">
          {rows.map((row) => {
            const set = resolveIconSet(assignments, row.slug);
            const nextSet = ICON_SET_IDS[(ICON_SET_IDS.indexOf(set) + 1) % ICON_SET_IDS.length];
            return (
              <li
                key={row.slug}
                className={row.running ? "icon-set-row" : "icon-set-row icon-set-row-idle"}
              >
                <span className="icon-set-project" title={row.slug}>
                  {row.label}
                </span>
                <img
                  className="icon-set-glyph"
                  src={ICON_SETS[set].working}
                  width={20}
                  height={20}
                  alt=""
                  title={ICON_SET_LABEL[set]}
                  draggable={false}
                />
                <button
                  type="button"
                  className="small icon-set-toggle"
                  aria-label={`${t("iconSetToggleAria")}: ${row.label} (${ICON_SET_LABEL[set]})`}
                  onClick={() => onChange(row.slug, row.label, nextSet)}
                >
                  ⇄
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
