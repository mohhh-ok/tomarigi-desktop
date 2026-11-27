import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MdBugReport, MdClose, MdNotifications, MdNotificationsOff, MdSettings } from "react-icons/md";
import { t } from "@/lib/i18n";
import { chirpDone, chirpWaiting, primeAudio } from "@/lib/chirp";
import { focusSession, focusTargetOf } from "@/lib/terminal-focus";
import { isAngry } from "@/lib/turn-verdict";
import type { AskJudgement, SessionEvent, SessionView } from "@/lib/sessions";
import { speakDoneEvent, speakEvent, speakSuggestions } from "@/lib/voice";
import DebugApp from "./DebugApp";
import { Garden } from "./garden";
import { bubbleText } from "./bubble";
import { type PerchSource } from "./source";
import { EventFeed } from "./event-feed";
import { Perch } from "./perch-list";
import { currentWindowMode, useWindowMode } from "./window-mode";
import { onFadeHandlePointerDown, useGardenFade } from "./garden-fade";
import { useGardenGrow } from "./garden-grow";
import { BackBar } from "./back-bar";
import { RootAddDialog } from "./settings/root-add-dialog";
import { useSettings } from "./use-settings";
import { useRoots } from "./use-roots";
import { useSettingsFile } from "./use-settings-file";
import { SettingsFileNote } from "./settings-file-note";
import { runningProjects, usePublishSettingsRuntime } from "./settings-runtime";
import { useSettingsShortcut } from "./settings-app";
import { turnKey, useTurnJudgements } from "./use-turn-judgements";
import { useConcierge } from "./use-concierge";
import { ConciergeGlyph, ConciergeLine } from "./concierge";
import {
  conciergeTabCounts,
  conciergeTabContent,
  conciergeTabLabel,
  conciergeWantsSuggestions,
  tabOf,
  tabsShown,
  useConciergeTab,
  type Tab,
} from "./concierge-tab";
import { ConciergeTabView } from "./concierge-tab-view";
import { loadOpenTab, saveOpenTab } from "@/lib/settings-store";
import { recordJump } from "@/lib/concierge";

const POLL_MS = 3_000;

// The tab row's words; the Concierge tab is named by the concierge's own name
const TAB_LABEL = {
  concierge: "conciergeName",
  garden: "tabGardenLabel",
  perch: "tabPerchLabel",
  events: "tabEventsLabel",
} as const;

// Chirps fire from ScanResult.events (issue #6). Which chirp maps to each event type
// (started/closed don't chirp)
const EVENT_CHIRP: Partial<Record<SessionEvent["type"], () => void>> = {
  done: chirpDone,
  waiting: chirpWaiting,
};

// Within this long of an event's at, it counts as "new" and chirps. A freshness guard so that events that already happened
// in the past, reconstructed by the scan right after launch, don't chirp (see the comment inside tick below)
const EVENT_FRESHNESS_MS = 30_000;

// Reads a session event as outside the Concierge tab. Only done is eligible for the summary readout (when an API key
// is set); speakDoneEvent branches internally on whether a key exists, including fallback, so here it only routes by type
function speakSessionEvent(event: SessionEvent, stillEnabled: () => boolean): void {
  if (event.type === "done") void speakDoneEvent(event, stillEnabled);
  else speakEvent(event);
}

type Phase = "loading" | "ready";

// Tabs switch the view (Concierge, Garden, Perch, events; concierge-tab.ts). The open one is saved and opened again
// after a relaunch. Settings are a window of their own (⚙ → open_settings; docs/design/settings-window.md "Settings window")

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
  const rootsApi = useRoots(source);
  const settingsFile = useSettingsFile();
  const { roots, perms, addMessage, addRoot } = rootsApi;
  const [brokenIds, setBrokenIds] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  // The Garden is the most fun to watch = the face of the product, so it is the default tab
  // ?tab=concierge|perch|events chooses the screen at launch (for checking screenshots; TOMARIGI_QUERY in
  // the README); without it the tab saved last opens
  const [chosenTab, setChosenTab] = useState<Tab>(
    () => tabOf(new URLSearchParams(location.search).get("tab")) ?? "garden",
  );
  useEffect(() => {
    if (new URLSearchParams(location.search).has("tab")) return;
    void loadOpenTab().then((v) => {
      const saved = tabOf(v);
      if (saved) setChosenTab(saved);
    }, () => {});
  }, []);
  const setTab = useCallback((next: Tab) => {
    setChosenTab(next);
    void saveOpenTab(next).catch(() => {});
  }, []);
  const [windowMode] = useWindowMode();
  const settingsApi = useSettings("owner");
  const {
    muted,
    mutedRef,
    voiceEnabledRef,
    summarySetUp,
    iconSetAssignments,
    loadSettings,
    toggleMuted,
    conciergeLook,
  } = settingsApi;
  const { requestJudgements, displaySessions } = useTurnJudgements(sessions, summarySetUp);
  // When opened directly with ?debug=1, the debug log starts open. After that the URL is never touched;
  // it is a screen opened and closed by this state alone
  const [showDebug, setShowDebug] = useState(
    () => new URLSearchParams(location.search).has("debug"),
  );
  // ?dialog=add-folder opens the add-folder dialog at launch (for checking screenshots; TOMARIGI_QUERY in the README)
  const [rootDialogOpen, setRootDialogOpen] = useState(
    () => new URLSearchParams(location.search).get("dialog") === "add-folder",
  );
  const closeDebug = useCallback(() => setShowDebug(false), []);
  useSettingsShortcut();
  // The Concierge tab without a provider opens the settings window at the AI section, where a key or Local is set up
  const openAiSettings = useCallback(() => void invoke("open_settings", { section: "ai" }).catch(() => {}), []);
  // The debug log and the tabs share one scroll area, so start each side from the top instead of carrying over where the
  // other one was scrolled to
  const pageBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    pageBodyRef.current?.scrollTo(0, 0);
  }, [showDebug]);
  // The concierge's readout routing (use-concierge.ts), set once the concierge is made below; read from the scan loop
  const conciergeReadoutEventRef = useRef<(event: SessionEvent) => "speak" | "held" | "skip">(() => "speak");
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
      // The mock source (source.usesRoots === false) doesn't use the roots/perms subsystem at all; it skips the
      // setup screen, watched folder settings, and permission checks entirely (use-roots.ts)
      // The settings file first: the folders and the settings are read from what it applied (docs/design/settings-file.md "Settings file")
      await settingsFile.load();
      await rootsApi.loadAll();
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
              line: `[event] ${event.type} ${event.project} chirp=${!mutedRef.current && Boolean(EVENT_CHIRP[event.type])} voice=${voiceEnabledRef.current}${event.silent ? " silent=true" : ""}`,
            });
            // Readout is an opt-in setting independent of mute (chirps). See lib/voice.ts for constraints.
            // While the Concierge tab is open, done and needs reply are held and the voice reads the concierge's new
            // suggestions instead (docs/design/concierge.md "Readout in the Concierge tab")
            if (voiceEnabledRef.current && conciergeReadoutEventRef.current(event) === "speak") {
              speakSessionEvent(event, () => voiceEnabledRef.current);
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

  // Clicking a bird or row jumps to its terminal pane. mock doesn't use roots, so it can't be matched and does nothing.
  // Jumps are an input of the concierge (which waiting session the user skipped)
  const onFocusSession = useCallback(
    (id: string) => {
      if (source.focusLogOnly) return console.info(`[mock] focus ${id}`);
      recordJump(id);
      void focusSession(id, roots).catch((e) => console.warn("[tomarigi] focus failed", e));
    },
    [roots, source.focusLogOnly],
  );
  const canFocus = useCallback(
    (id: string) => Boolean(source.focusLogOnly) || focusTargetOf(id, roots) !== null,
    [roots, source.focusLogOnly],
  );

  // So that Recent activity and the garden markers also show a done as needs reply when the turn verdict for that
  // turn is asking, attach the verdict to the done event of the same turn (sessionId + time of the last response)
  // Recent activity rows get the same text as that turn's speech bubble (bubbleText). No extra summary is requested;
  // only the current turn of birds on screen is used (it isn't put into the persistent event log)
  const displayEvents = useMemo(() => {
    const askByTurn = new Map<string, AskJudgement>();
    const lineByDoneTurn = new Map<string, string>();
    const lineByWaitingSession = new Map<string, string>();
    const angrySessions = new Set<string>();
    const sessionById = new Map(displaySessions.map((s) => [s.id, s]));
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
      angrySessions.size === 0 &&
      !displaySessions.some((s) => s.projectSuffix)
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
      // The event keeps the name it had; the part that tells it apart is kept visible only while that is still the
      // session's name (docs/design/display-names.md "Display names")
      const session = sessionById.get(e.sessionId);
      const projectSuffix = session?.project === e.project ? session.projectSuffix : undefined;
      if (!ask && !line && !angry && !projectSuffix) return e;
      return { ...e, ...(ask && { ask }), ...(line && { line }), ...(angry && { angry }), ...(projectSuffix && { projectSuffix }) };
    });
  }, [events, displaySessions]);

  // The concierge (docs/design/concierge.md "Concierge"): shown while an OpenAI / Anthropic key is saved or Local is set up. It reads the same
  // sessions and events as the screens, so it sees the turn verdicts and bubble lines they show
  const agentOfSession = useCallback(
    (id: string) => roots.find((r) => id.startsWith(`${r.id}/`))?.kind,
    [roots],
  );
  // Suggestions are asked for with the advice only while the Concierge tab is open. Which tab is open depends on the
  // concierge being available, so it comes here a render later (wantSuggestions, set below)
  const [wantSuggestions, setWantSuggestions] = useState(false);
  // The Concierge tab's readout, gated by the "Read aloud" setting like the per-session readout (mute only silences
  // chirps). Read at the moment of speaking, so it is stable across renders
  const conciergeReadoutSink = useMemo(
    () => ({
      suggestions: (list: { name: string; text: string }[]) => {
        if (voiceEnabledRef.current) speakSuggestions(list);
      },
      events: (list: SessionEvent[]) => {
        for (const event of list) if (voiceEnabledRef.current) speakSessionEvent(event, () => voiceEnabledRef.current);
      },
    }),
    [voiceEnabledRef],
  );
  const concierge = useConcierge(
    displaySessions,
    displayEvents,
    summarySetUp,
    agentOfSession,
    source.conciergeAdvice?.(displaySessions),
    wantSuggestions,
    source.conciergeSuggestions?.(displaySessions),
    conciergeReadoutSink,
  );
  conciergeReadoutEventRef.current = concierge.readoutEvent;

  const grantedCount = roots.filter((r) => perms[r.id] === "granted").length;
  // The mock source doesn't use roots/perms, so grantedCount is always 0, but that isn't the
  // "no access" state, so it isn't used for the empty-state branch of Perch/Garden
  const hasGranted = !source.usesRoots || grantedCount > 0;

  const showTabs = phase === "ready" && (!source.usesRoots || roots.length > 0);
  // The Concierge tab is always there; without a provider it says what the concierge needs (docs/design/concierge.md "Concierge")
  const tab = chosenTab;
  // The Concierge tab (concierge-tab.ts): the floating window shrinks to the concierge while it is open with nothing
  // over it; on the other tabs, settings and the debug log it is back at its frame
  const conciergeTab = useConciergeTab({
    open: showTabs && tab === "concierge",
    canShrink: windowMode === "floating" && !showDebug,
  });
  // Without a provider nothing is asked and the readout stays per session, as outside the tab
  useEffect(
    () => setWantSuggestions(conciergeWantsSuggestions({ tab, available: concierge.available })),
    [tab, concierge.available],
  );
  // At rest the header's empty rows fold so the concierge sits right under the handle (styles/concierge.css)
  useEffect(() => {
    const root = document.documentElement;
    if (conciergeTab.view) root.dataset.conciergeOnly = "";
    else delete root.dataset.conciergeOnly;
  }, [conciergeTab.view]);
  // Fade until hovered (garden-fade.ts). Not while the debug log or the folder dialog are open over the Garden
  useGardenFade(
    windowMode === "floating" &&
      showTabs &&
      (tab === "garden" || tab === "concierge") &&
      !showDebug &&
      !rootDialogOpen,
  );
  // Grow the floating window when the Garden's birds don't fit (garden-grow.ts). The folder dialog only covers the
  // Garden, so it doesn't count
  const { onFit: onGardenFit, growRoom: gardenGrowRoom } = useGardenGrow(
    windowMode === "floating" && showTabs && tab === "garden" && !showDebug && !conciergeTab.view,
    windowMode === "floating",
    displaySessions.length + (concierge.shown ? 1 : 0),
  );

  // Rows of the icon set settings, for the settings window (settings-runtime.ts)
  const running = useMemo(() => runningProjects(sessions), [sessions]);

  // What the settings window shows but isn't saved (docs/design/settings-window.md "Settings window")
  usePublishSettingsRuntime({
    running,
    brokenIds,
    settingsFile: settingsFile.recent,
  });

  return (
    <main className="page">
      <SettingsFileNote notes={settingsFile.notes} onDismiss={settingsFile.dismissNotes} />
      <div className="page-header">
        {/* The window handle while the Garden is faded (docs/design/fade-until-hovered.md "Fade until hovered") */}
        <h1 className="brand fade-handle" onPointerDown={onFadeHandlePointerDown}>
          tomarigi
        </h1>
        {/* Mute, debug, settings, and hide must always be visible on every tab, so they sit outside the tabs (in the header) */}
        <div className="header-controls">
          {showTabs && (
            <>
            <button
              className="small"
              onClick={toggleMuted}
              aria-label={t(muted ? "unmuteButtonAria" : "muteButtonAria")}
              title={t(muted ? "unmuteButtonAria" : "muteButtonAria")}
            >
              {/* A single-color icon from the same set as the buttons beside it, not the emoji WebKit draws in color */}
              {muted ? <MdNotificationsOff size={16} /> : <MdNotifications size={16} />}
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
            {/* Opens the settings window, or brings it to the front (docs/design/settings-window.md "Settings window") */}
            <button
              className="small"
              onClick={() => void invoke("open_settings").catch(() => {})}
              aria-label={t("tabSettingsLabel")}
              title={t("tabSettingsLabel")}
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
        {/* The Concierge tab is open: said right under the handle, on the same backing and shown at rest like it (the
            tab row is hidden then), with the other birds and how many of them need a reply. A row of its own, so the
            window's width follows the concierge, not this text (docs/design/concierge.md "Concierge") */}
        {tab === "concierge" && showTabs && !showDebug && (
          <div className="concierge-only-row">
            <ConciergeTabLabel sessions={displaySessions} />
          </div>
        )}
      </div>
      {/* While the debug log is open, the tab row is replaced by a bar with Back and the title, so the way out is
          written on screen. This row sits outside .page-body so it stays put while the content scrolls */}
      {showDebug ? (
        <BackBar backLabel="Back" title="Event log (debug)" onBack={closeDebug} />
      ) : showTabs && (
            <div className="tabs" role="tablist">
              {tabsShown().map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`tab-btn-${id}`}
                  aria-selected={tab === id}
                  aria-controls={`tabpanel-${id === "concierge" ? "garden" : id}`}
                  className={`tab-btn tab-btn-${id}${tab === id ? " active" : ""}`}
                  onClick={() => setTab(id)}
                  // The Concierge tab is the concierge's picture, named in its tooltip: four words don't fit the
                  // narrowest window (docs/design/concierge.md "Concierge")
                  {...(id === "concierge" && { "aria-label": t(TAB_LABEL[id]), title: t(TAB_LABEL[id]) })}
                >
                  {id === "concierge" ? <ConciergeGlyph look={conciergeLook} size={18} /> : t(TAB_LABEL[id])}
                </button>
              ))}
            </div>
      )}
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
              switch would lose internal state such as Garden's). Same hidden while the debug log is open */}
          <section
            role="tabpanel"
            id="tabpanel-events"
            aria-labelledby="tab-btn-events"
            hidden={showDebug || tab !== "events"}
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
            hidden={showDebug || tab !== "perch"}
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
          {/* The Garden and the Concierge tab share one panel: the Garden's birds stay mounted and paused while the
              concierge is shown alone, so they come back as they were */}
          <section
            role="tabpanel"
            id="tabpanel-garden"
            aria-labelledby={tab === "concierge" ? "tab-btn-concierge" : "tab-btn-garden"}
            hidden={showDebug || (tab !== "garden" && tab !== "concierge")}
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
                paused={conciergeTab.view}
              />
              {conciergeTab.view && (
                <ConciergeTabView
                  content={conciergeTabContent({
                    available: concierge.available,
                    sessions: displaySessions.length,
                  })}
                  look={conciergeLook}
                  concierge={{ advice: concierge.advice, suggestions: concierge.suggestions }}
                  onOpenAiSettings={openAiSettings}
                  hasGranted={hasGranted}
                  onFocus={onFocusSession}
                  canFocus={canFocus}
                  onSize={conciergeTab.fit}
                  sessions={displaySessions}
                />
              )}
            </div>
          </section>
        </>
      )}
      {/* The debug log takes the place of the tabs' content. English only (docs/design/language.md "Language") */}
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

/** Right under the handle while the Concierge tab is open, inside its backing: which tab this is, then the other birds
    and how many of them need a reply (conciergeTabLabel). A second handle, like the Garden's empty message: dragging it
    moves the window, a click shows it at rest */
function ConciergeTabLabel({ sessions }: { sessions: SessionView[] }) {
  const { badge, counts } = conciergeTabLabel(conciergeTabCounts(sessions));
  return (
    <span className="concierge-only-label fade-handle" onPointerDown={onFadeHandlePointerDown}>
      <span className="concierge-only-badge">{badge}</span>
      <span className="concierge-only-counts">{counts}</span>
    </span>
  );
}
