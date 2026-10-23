import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MdBugReport, MdClose, MdSettings, MdVolumeUp } from "react-icons/md";
import { t } from "@/lib/i18n";
import { chirpDone, chirpWaiting, primeAudio } from "@/lib/chirp";
import {
  loadRoots,
  pickNewRoot,
  queryRead,
  saveRoots,
  type RootEntry,
  type RootKind,
} from "@/lib/settings-store";
import { focusSession, focusTargetOf } from "@/lib/terminal-focus";
import { isAngry } from "@/lib/turn-verdict";
import type { AskJudgement, SessionEvent, SessionView } from "@/lib/sessions";
import { speakDoneEvent, speakEvent, speechAvailable } from "@/lib/voice";
import DebugApp from "./DebugApp";
import { Garden } from "./garden";
import { bubbleText } from "./bubble";
import { type PerchSource } from "./source";
import { EVENT, EventIcon } from "./event-kind";
import { EventFeed } from "./event-feed";
import { Perch } from "./perch-list";
import { currentWindowMode, useWindowMode } from "./window-mode";
import { useUpdates } from "./use-updates";
import { onFadeHandlePointerDown, useGardenFade } from "./garden-fade";
import { useGardenGrow } from "./garden-grow";
import { BackBar } from "./back-bar";
import { AiKeySettings } from "./settings/ai-key-settings";
import { IconSetSettings, type IconSetRow } from "./settings/icon-set-settings";
import { RootAddDialog } from "./settings/root-add-dialog";
import { RootManager, type Editing } from "./settings/root-manager";
import { UpdateSettings } from "./settings/update-settings";
import { useSettings } from "./use-settings";
import { turnKey, useTurnJudgements } from "./use-turn-judgements";
import { useConcierge } from "./use-concierge";
import { ConciergeLine, ConciergeSettings } from "./concierge";
import { conciergeOnlyCounts, conciergeOnlyLabel, useConciergeOnly } from "./concierge-only";
import { ConciergeOnlyGarden } from "./concierge-only-garden";
import type { GardenMenu } from "./garden";
import { recordJump } from "@/lib/concierge";

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

// Grabbing the window background moves the whole window. Excludes clickable controls, text inputs, birds (garden
// drag), scrolling lists, and the window handle (it drags the window itself, garden-fade.ts)
const NO_WINDOW_DRAG =
  ".fade-handle, button, input, select, textarea, a, label, kbd, code, .garden-node, .bird, .chick, .event-card, .debug-log, .mock-panel, .root-add-overlay";

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
  const [windowMode, setWindowMode] = useWindowMode();
  const updates = useUpdates();
  const {
    muted,
    mutedRef,
    chirpVolume,
    voiceEnabled,
    voiceEnabledRef,
    voiceVolume,
    aiKeySet,
    retiredKeys,
    keyStoreAvailable,
    aiKeyTestState,
    aiProvider,
    localAi,
    summarySetUp,
    iconSetAssignments,
    loadSettings,
    toggleMuted,
    toggleVoiceEnabled,
    changeVoiceVolume,
    changeChirpVolume,
    saveAiKey,
    removeAiKey,
    removeRetiredKey,
    saveLocalAi,
    removeLocalAi,
    selectAiProvider,
    runAiKeyTest,
    assignIconSet,
    conciergeLook,
    changeConciergeLook,
  } = useSettings();
  const { requestJudgements, displaySessions } = useTurnJudgements(sessions, summarySetUp);
  // Readout is off where the WebView can't speak (some Linux builds; docs/design.md "Platforms")
  const canSpeak = speechAvailable();
  // When opened directly with ?debug=1, the debug log starts open. After that the URL is never touched;
  // it is a screen (like settings) opened and closed by this state alone
  const [showDebug, setShowDebug] = useState(
    () => new URLSearchParams(location.search).has("debug"),
  );
  // ?dialog=add-folder opens the add-folder dialog at launch (for checking screenshots; TOMARIGI_QUERY in the README)
  const [rootDialogOpen, setRootDialogOpen] = useState(
    () => new URLSearchParams(location.search).get("dialog") === "add-folder",
  );
  const closeDebug = useCallback(() => setShowDebug(false), []);
  // Esc leaves settings. Skipped while a dialog or a folder name edit is open, because their own Esc handlers close
  // just that one thing and the same key press shouldn't also drop the user out of settings
  useEffect(() => {
    if (!settingsOpen || showDebug || rootDialogOpen || editing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen, showDebug, rootDialogOpen, editing]);
  // The menu bar's update item opens settings at the update section, where its result and progress are shown
  // (tray.rs on_update_item)
  useEffect(() => {
    const unlisten = listen("open-updates", () => {
      setShowDebug(false);
      setSettingsOpen(true);
      // After the scroll reset below runs for the newly opened settings
      requestAnimationFrame(() => document.querySelector(".update-settings")?.scrollIntoView({ block: "center" }));
    });
    return () => void unlisten.then((f) => f());
  }, []);
  // Settings, the debug log, and the tabs share one scroll area, so start each side from the top instead of carrying over where the
  // other one was scrolled to
  const pageBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    pageBodyRef.current?.scrollTo(0, 0);
  }, [settingsOpen, showDebug]);
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
      } else if (source.displayRoots) {
        setRoots(source.displayRoots);
        setPerms(Object.fromEntries(source.displayRoots.map((r) => [r.id, "granted" as const])));
      }
      await loadSettings();
      setPhase("ready");
    })();
  }, []);

  // Unlock the AudioContext. WKWebView becomes running even without user interaction (checked in a spike),
  // but call it both at launch and on the first pointer action just in case
  useEffect(() => {
    primeAudio();
    const unlock = () => primeAudio();
    document.addEventListener("pointerdown", unlock, { once: true });
    return () => document.removeEventListener("pointerdown", unlock);
  }, []);

  // Grab the window background to move the window (see NO_WINDOW_DRAG). Left button only, not Control-click (macOS's
  // right click, which opens the Garden's menu)
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.ctrlKey) return;
      if (e.target instanceof Element && e.target.closest(NO_WINDOW_DRAG)) return;
      // A standard window moves by its title bar (so grabbing the background while maximized or fullscreen doesn't pull the window out)
      if (currentWindowMode() === "normal") return;
      void getCurrentWindow().startDragging();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
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
            // see deriveDoneEvent in lib/session-events.ts) stays in the log and feed but doesn't chirp
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
        // Write to the Rust log (~/Library/Logs/tomarigi-desktop/app-log.txt) only when the set of birds or their states change.
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
        requestJudgements(views);
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
    // Folders shown by mock are not saved
    if (!source.usesRoots) return;
    try {
      await saveRoots(next);
    } catch (e) {
      console.warn("[tomarigi] failed to save", e);
      setAddMessage(t("saveFailedMessage"));
    }
  }, []);

  const addRoot = useCallback(async (kind: RootKind) => {
    // mock has no folder picker
    if (!source.usesRoots) return;
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

  // Preview the three chirps individually (played in a row, you can't tell which sound is which state)
  const previewChirp = useCallback((chirp: () => void) => {
    primeAudio();
    chirp();
  }, []);

  // Clicking a bird or row jumps to its terminal pane. mock doesn't use roots, so it can't be matched and does nothing.
  // Jumps are an input of the concierge (which waiting session the user skipped)
  const onFocusSession = useCallback(
    (id: string) => {
      recordJump(id);
      void focusSession(id, roots).catch((e) => console.warn("[tomarigi] focus failed", e));
    },
    [roots],
  );
  const canFocus = useCallback((id: string) => focusTargetOf(id, roots) !== null, [roots]);

  // So that Recent activity and the garden markers also show a done as needs reply when the turn verdict for that
  // turn is asking, attach the verdict to the done event of the same turn (sessionId + time of the last response)
  // Recent activity rows get the same text as that turn's speech bubble (bubbleText). No extra summary is requested;
  // only the current turn of birds on screen is used (it isn't put into the persistent event log)
  const displayEvents = useMemo(() => {
    const askByTurn = new Map<string, AskJudgement>();
    const lineByDoneTurn = new Map<string, string>();
    const lineByWaitingSession = new Map<string, string>();
    const angrySessions = new Set<string>();
    for (const s of displaySessions) {
      if (isAngry(s)) angrySessions.add(s.id);
      const line = bubbleText(s);
      if (s.reply) {
        const key = turnKey(s.id, s.reply.at);
        if (s.ask) askByTurn.set(key, s.ask);
        if (line) lineByDoneTurn.set(key, line);
      } else if (s.state === "waiting" && line) {
        lineByWaitingSession.set(s.id, line);
      }
    }
    if (
      askByTurn.size === 0 &&
      lineByDoneTurn.size === 0 &&
      lineByWaitingSession.size === 0 &&
      angrySessions.size === 0
    ) {
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
      const angry = angrySessions.has(e.sessionId);
      if (!ask && !line && !angry) return e;
      return { ...e, ...(ask && { ask }), ...(line && { line }), ...(angry && { angry }) };
    });
  }, [events, displaySessions]);

  // The concierge (docs/design.md "Concierge"): shown while an OpenAI / Anthropic key is saved or Local is set up. It reads the same
  // sessions and events as the screens, so it sees the turn verdicts and bubble lines they show
  const agentOfSession = useCallback(
    (id: string) => roots.find((r) => id.startsWith(`${r.id}/`))?.kind,
    [roots],
  );
  const concierge = useConcierge(
    displaySessions,
    displayEvents,
    summarySetUp,
    agentOfSession,
    source.conciergeAdvice?.(displaySessions),
  );

  const grantedCount = roots.filter((r) => perms[r.id] === "granted").length;
  // The mock source doesn't use roots/perms, so grantedCount is always 0, but that isn't the
  // "no access" state, so it isn't used for the empty-state branch of Perch/Garden
  const hasGranted = !source.usesRoots || grantedCount > 0;

  const showTabs = phase === "ready" && (!source.usesRoots || roots.length > 0);
  // "Concierge only" (concierge-only.ts): the floating window shrinks to the concierge only on the Garden with nothing
  // over it; on the other tabs, settings and the debug log it is back at its frame
  const conciergeOnly = useConciergeOnly({
    available: concierge.available,
    loaded: phase === "ready",
    canShrink: windowMode === "floating" && showTabs && tab === "garden" && !settingsOpen && !showDebug,
  });
  const gardenMenu: GardenMenu = {
    conciergeAvailable: concierge.available,
    conciergeOnly: conciergeOnly.on,
    toggleConciergeOnly: conciergeOnly.toggle,
  };
  // Fade until hovered (garden-fade.ts). Not while settings, the debug log, or the folder dialog are open over the Garden
  useGardenFade(
    windowMode === "floating" &&
      showTabs &&
      tab === "garden" &&
      !settingsOpen &&
      !showDebug &&
      !rootDialogOpen,
  );
  // Grow the floating window when the Garden's birds don't fit (garden-grow.ts). The folder dialog only covers the
  // Garden, so it doesn't count
  const { onFit: onGardenFit, growRoom: gardenGrowRoom } = useGardenGrow(
    windowMode === "floating" && showTabs && tab === "garden" && !settingsOpen && !showDebug && !conciergeOnly.view,
    windowMode === "floating",
    displaySessions.length + (concierge.shown ? 1 : 0),
  );

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

  return (
    <main className="page">
      <div className="page-header">
        {/* The window handle while the Garden is faded (docs/design.md "Fade until hovered") */}
        <h1 className="brand fade-handle" onPointerDown={onFadeHandlePointerDown}>
          tomarigi
          {/* "Concierge only" is on: said beside the handle, the one thing always shown at rest, with the birds it hides
              and how many of them need a reply (docs/design.md "Concierge") */}
          {conciergeOnly.on && showTabs && <ConciergeOnlyLabel sessions={displaySessions} />}
        </h1>
        {/* Mute, debug, settings, and hide must always be visible on every tab, so they sit outside the tabs (in the header) */}
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
              onClick={() => {
                // Settings and the debug log are both screens shown in place of the tabs, so only one is open
                setSettingsOpen(false);
                setShowDebug((v) => !v);
              }}
              aria-label="Debug log"
              title="Debug log"
              aria-pressed={showDebug}
            >
              <MdBugReport size={16} />
            </button>
            <button
              className={settingsOpen ? "small active" : "small"}
              onClick={() => {
                setShowDebug(false);
                setSettingsOpen((v) => !v);
              }}
              aria-label={t("tabSettingsLabel")}
              aria-pressed={settingsOpen}
            >
              <MdSettings size={16} />
            </button>
            </>
          )}
          {/* Hides the window. It can be brought back from the menu bar icon. Labeled as "hide window" rather than "close",
              so it isn't mistaken for leaving settings or a dialog */}
          <button
            className="small"
            onClick={() => void invoke("hide_window")}
            aria-label={t("hideWindowButtonLabel")}
            title={t("hideWindowButtonLabel")}
          >
            <MdClose size={16} />
          </button>
        </div>
      </div>
      {/* While in settings, the tab row is replaced by a bar with Back and the title, so the way out is written on
          screen (⚙ again and Esc also close it). Tabs are only the "views"; settings are a separate level, so they
          aren't listed as a tab. This row sits outside .page-body so it stays put while the content scrolls */}
      {showDebug ? (
        <BackBar backLabel="Back" title="Event log (debug)" onBack={closeDebug} />
      ) : showTabs &&
        (settingsOpen ? (
          <BackBar
            backLabel={t("settingsBackButton")}
            title={t("tabSettingsLabel")}
            onBack={() => setSettingsOpen(false)}
          />
        ) : (
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
        ))}
      {/* Only this area scrolls, so the header (⚙ and ×) and the tab / settings row stay visible */}
      <div className="page-body" ref={pageBodyRef}>
      {phase === "loading" && <p className="note">{t("loadingLabel")}</p>}
      {phase === "ready" && source.usesRoots && roots.length === 0 && (
        <section className="setup">
          <p>{t("setupIntro")}</p>
          <button onClick={() => setRootDialogOpen(true)}>{t("setupButton")}</button>
          {addMessage && <p className="add-message">{addMessage}</p>}
        </section>
      )}
      {showTabs && (
        <>
          {/* Each tab panel stays mounted and is hidden with the hidden attribute (recreating it on every tab
              switch would lose internal state such as Garden's). Same hidden while in settings */}
          <section
            role="tabpanel"
            id="tabpanel-events"
            aria-labelledby="tab-btn-events"
            hidden={settingsOpen || showDebug || tab !== "events"}
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
            hidden={settingsOpen || showDebug || tab !== "perch"}
          >
            <div className="stage stage-perch">
              <ConciergeLine advice={concierge.advice} look={conciergeLook} onFocus={onFocusSession} canFocus={canFocus} />
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
            hidden={settingsOpen || showDebug || tab !== "garden"}
          >
            <div className="stage stage-garden">
              {/* The birds are only hidden: the Garden stays mounted and paused, so they come back as they were */}
              <Garden
                sessions={displaySessions}
                concierge={concierge.shown ? { advice: concierge.advice, look: conciergeLook } : undefined}
                hasGranted={hasGranted}
                iconSetAssignments={iconSetAssignments}
                onFocus={onFocusSession}
                canFocus={canFocus}
                onFit={onGardenFit}
                growRoom={gardenGrowRoom}
                paused={conciergeOnly.view}
                menu={gardenMenu}
              />
              {conciergeOnly.view && (
                <ConciergeOnlyGarden
                  concierge={concierge.shown ? { advice: concierge.advice, look: conciergeLook } : undefined}
                  hasGranted={hasGranted}
                  onFocus={onFocusSession}
                  canFocus={canFocus}
                  menu={gardenMenu}
                  onSize={conciergeOnly.fit}
                />
              )}
            </div>
          </section>
          <section className="settings-panel" hidden={!settingsOpen || showDebug}>
            {/* Watched folder management is the roots/perms subsystem itself. mock shows its fixed folders
                (source.displayRoots) so the list and the add dialog can be checked, without reading or saving.
                BYOK, volume, and readout settings work as the real thing even in mock (see AiKeySettings and
                voice-controls below) */}
            {(source.usesRoots || source.displayRoots) && (
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
              open={settingsOpen && !showDebug}
              keySet={aiKeySet}
              retiredKeys={retiredKeys}
              storeAvailable={keyStoreAvailable}
              localAi={localAi}
              onSaveLocal={(config) => void saveLocalAi(config)}
              onDeleteLocal={() => void removeLocalAi()}
              selectedProvider={aiProvider}
              testState={aiKeyTestState}
              onSaveKey={saveAiKey}
              onDeleteKey={(provider) => void removeAiKey(provider)}
              onDeleteRetiredKey={(provider) => void removeRetiredKey(provider)}
              onTest={(provider, localDraft) => void runAiKeyTest(provider, localDraft)}
              onSelect={(provider) => void selectAiProvider(provider)}
            />
            <ConciergeSettings look={conciergeLook} onChange={changeConciergeLook} />
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
                  <EventIcon kind="done" size={18} /> {EVENT.done.label}
                </button>
                <button className="small" onClick={() => previewChirp(chirpWaiting)}>
                  <MdVolumeUp size={14} className="preview-mic" />
                  <EventIcon kind="waiting" size={18} /> {EVENT.waiting.label}
                </button>
              </div>
              <label className="voice-enable-row">
                <input
                  type="checkbox"
                  checked={voiceEnabled && canSpeak}
                  disabled={!canSpeak}
                  onChange={toggleVoiceEnabled}
                />
                {t("voiceEnableLabel")}
              </label>
              {!canSpeak && <p className="settings-subrow settings-note">{t("voiceUnavailable")}</p>}
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
                  disabled={!voiceEnabled || !canSpeak}
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
            <UpdateSettings
              status={updates.status}
              version={updates.version}
              onCheck={updates.check}
              onInstall={updates.install}
            />
          </section>
        </>
      )}
      {/* The debug log takes the place of the tabs' content, like settings. English only (docs/design.md "Language") */}
      {showDebug && <DebugApp onClose={closeDebug} />}
      {/* Control panel only for the mock source (MockPanel passed by boot.tsx) */}
      {extraPanel}
      </div>
      {rootDialogOpen && (
        <RootAddDialog
          onClose={() => setRootDialogOpen(false)}
          onChoose={(kind) => {
            setRootDialogOpen(false);
            void addRoot(kind);
          }}
        />
      )}
    </main>
  );
}

/** "Concierge only" beside the handle's name, inside its backing: the mode, then the hidden birds and how many need a
    reply (conciergeOnlyLabel) */
function ConciergeOnlyLabel({ sessions }: { sessions: SessionView[] }) {
  const { badge, counts } = conciergeOnlyLabel(conciergeOnlyCounts(sessions));
  return (
    <span className="concierge-only-label">
      <span className="concierge-only-badge">{badge}</span>
      <span className="concierge-only-counts">{counts}</span>
    </span>
  );
}
