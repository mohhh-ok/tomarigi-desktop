// The settings window's page (docs/design.md "Settings window"): sections listed on the left, the chosen one on the
// right. It shows and saves the settings; the floating window runs what they drive and follows each save
// (lib/settings-sync.ts). The cards are the ones the floating window used to show
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "@/lib/i18n";
import { primeAudio } from "@/lib/chirp";
import type { RootEntry } from "@/lib/settings-store";
import { ConciergeSettings } from "./concierge";
import type { PerchSource } from "./source";
import { SettingsFileSettings, type SettingsFilePaths } from "./settings/settings-file-settings";
import { AiKeySettings } from "./settings/ai-key-settings";
import { IconSetSettings } from "./settings/icon-set-settings";
import { RootAddDialog } from "./settings/root-add-dialog";
import { finishEdit } from "./settings/edit-session";
import { RootManager, type Editing } from "./settings/root-manager";
import { SoundSettings } from "./settings/sound-settings";
import { UpdateSettings } from "./settings/update-settings";
import { WindowModeSettings } from "./settings/window-mode-settings";
import {
  loadSection,
  saveSection,
  SECTION_LABEL,
  sectionOf,
  SETTINGS_SECTIONS,
  urlWithSection,
  type SettingsSection,
} from "./settings-sections";
import { iconSetRowsOf, runningProjects, useSettingsRuntime, EMPTY_RUNTIME } from "./settings-runtime";
import { KEY_MCP_REMOVED_NOTE } from "./use-settings-file";
import { kvGet, kvPut } from "@/lib/kv";
import { onSettingsChanged } from "@/lib/settings-sync";
import { useRoots } from "./use-roots";
import { useSettings } from "./use-settings";
import { useUpdates } from "./use-updates";
import { useWindowMode } from "./window-mode";

const isMac = navigator.userAgent.includes("Mac");

export default function SettingsApp({ source }: { source: PerchSource }) {
  const params = new URLSearchParams(location.search);
  const [section, setSectionState] = useState<SettingsSection | null>(() => sectionOf(params.get("section")));
  const settings = useSettings("settings");
  const rootsApi = useRoots(source);
  const [windowMode, setWindowMode] = useWindowMode(false);
  const updates = useUpdates();
  // Outside the app (the browser mock) the running projects come from one scan of the mock source
  const runtime = useSettingsRuntime(async () => {
    const { views } = await source.scan([]);
    return { ...EMPTY_RUNTIME, running: runningProjects(views) };
  });
  const fileSection = useSettingsFileSection();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [rootDialogOpen, setRootDialogOpen] = useState(() => params.get("dialog") === "add-folder");
  const contentRef = useRef<HTMLDivElement>(null);
  useSettingsShortcut();

  const setSection = useCallback((next: SettingsSection) => {
    setSectionState(next);
    history.replaceState(null, "", urlWithSection(location.href, next));
    void saveSection(next).catch(() => {});
  }, []);

  useEffect(() => {
    void rootsApi.loadAll();
    void settings.loadSettings();
    if (!section) void loadSection().then(setSection, () => setSection("sound"));
    // The title bar in the UI language
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(`${t("tabSettingsLabel")} — tomarigi`))
      .catch(() => {});
    document.title = `${t("tabSettingsLabel")} — tomarigi`;
    if (params.has("selftest")) void import("./settings-selftest").then((m) => m.runSettingsSelfTest());
  }, []);

  // Opened again at a section (the menu bar's update item, the Concierge tab's "set up AI")
  useEffect(() => {
    let stop: (() => void) | undefined;
    let stopped = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<string>("settings-section", (e) => {
        const next = sectionOf(e.payload);
        if (next) setSection(next);
      }))
      .then((f) => (stopped ? f() : (stop = f)))
      .catch(() => {});
    return () => {
      stopped = true;
      stop?.();
    };
  }, [setSection]);

  // Each section starts at its top
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
  }, [section]);

  // ?scrollTo=<class name> scrolls to that element (for screenshots; TOMARIGI_QUERY in the README)
  useEffect(() => {
    const target = params.get("scrollTo");
    if (!section || !target || !/^[\w-]+$/.test(target)) return;
    requestAnimationFrame(() => document.querySelector(`.${target}`)?.scrollIntoView({ block: "center" }));
  }, [section]);

  // Cmd+W (Ctrl+W) closes the window, as in other apps' settings windows
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close()).catch(() => {});
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // The sound previews and the readout sample play in this window
  useEffect(() => {
    const unlock = () => primeAudio();
    document.addEventListener("pointerdown", unlock, { once: true });
    return () => document.removeEventListener("pointerdown", unlock);
  }, []);

  // What is being edited, as a ref too: the first call that closes the edit decides save or not, and the blur that the
  // closing causes (Chromium and WebKit fire it when the focused field is removed) finds it already closed
  const editSession = useRef<Editing | null>(null);
  const openEdit = useCallback((next: Editing | null) => {
    editSession.current = next;
    setEditing(next);
  }, []);

  const closeEdit = useCallback(
    async (save: boolean) => {
      const toSave = finishEdit(editSession, save);
      setEditing(null);
      // An empty label keeps the original value (renameRoot refuses it)
      if (toSave) await rootsApi.renameRoot(toSave.id, toSave.draft);
    },
    [rootsApi.renameRoot],
  );
  const commitEdit = useCallback(() => closeEdit(true), [closeEdit]);
  const cancelEdit = useCallback(() => closeEdit(false), [closeEdit]);

  const removeRootRow = useCallback(
    async (id: string) => {
      await rootsApi.removeRoot(id);
      if (editSession.current?.id === id) openEdit(null);
    },
    [rootsApi.removeRoot, openEdit],
  );

  const content = (() => {
    switch (section) {
      case "sound":
        return (
          <section className="sound-settings">
            <h2>{t("soundSettingsHeading")}</h2>
            <SoundSettings
              open
              muted={settings.muted}
              chirpVolume={settings.chirpVolume}
              voiceEnabled={settings.voiceEnabled}
              voiceVolume={settings.voiceVolume}
              readoutVoice={settings.readoutVoice}
              onToggleMuted={settings.toggleMuted}
              onChirpVolume={settings.changeChirpVolume}
              onToggleVoice={settings.toggleVoiceEnabled}
              onVoiceVolume={settings.changeVoiceVolume}
              onReadoutSource={settings.changeReadoutSource}
              onSaveLocalTts={settings.saveLocalTts}
              onDeleteLocalTts={settings.removeLocalTts}
              onTestTts={settings.runTtsTest}
            />
          </section>
        );
      case "ai":
        return (
          <AiKeySettings
            open
            keySet={settings.aiKeySet}
            retiredKeys={settings.retiredKeys}
            storeAvailable={settings.keyStoreAvailable}
            localAi={settings.localAi}
            onSaveLocal={(config) => void settings.saveLocalAi(config)}
            onDeleteLocal={() => void settings.removeLocalAi()}
            selectedProvider={settings.aiProvider}
            testState={settings.aiKeyTestState}
            onSaveKey={settings.saveAiKey}
            onDeleteKey={(provider) => void settings.removeAiKey(provider)}
            onDeleteRetiredKey={(provider) => void settings.removeRetiredKey(provider)}
            onTest={(provider, localDraft) => void settings.runAiKeyTest(provider, localDraft)}
            onSelect={(provider) => void settings.selectAiProvider(provider)}
          />
        );
      case "concierge":
        return <ConciergeSettings look={settings.conciergeLook} onChange={settings.changeConciergeLook} />;
      case "folders":
        return (
          <RootManager
            roots={rootsApi.roots}
            perms={rootsApi.perms}
            brokenIds={runtime.brokenIds}
            editing={editing}
            addMessage={rootsApi.addMessage}
            onRequestAdd={() => setRootDialogOpen(true)}
            onRemove={(id) => void removeRootRow(id)}
            onStartEdit={(root: RootEntry) => openEdit({ id: root.id, draft: root.label })}
            onEditChange={(draft) => {
              if (editSession.current) openEdit({ ...editSession.current, draft });
            }}
            onCommitEdit={commitEdit}
            onCancelEdit={cancelEdit}
          />
        );
      case "icons":
        return (
          <IconSetSettings
            rows={iconSetRowsOf(runtime.running, settings.iconSetAssignments)}
            assignments={settings.iconSetAssignments}
            onChange={settings.assignIconSet}
          />
        );
      case "window":
        return <WindowModeSettings mode={windowMode} onChange={setWindowMode} />;
      case "settingsFile":
        return (
          <SettingsFileSettings
            paths={fileSection.paths}
            recent={runtime.settingsFile}
            mcpNote={fileSection.mcpNote}
            onCloseMcpNote={fileSection.closeMcpNote}
            onReveal={(path) => void import("@tauri-apps/plugin-opener").then((m) => m.revealItemInDir(path)).catch(() => {})}
          />
        );
      case "updates":
        return (
          <UpdateSettings
            status={updates.status}
            version={updates.version}
            onCheck={updates.check}
            onInstall={updates.install}
          />
        );
      case null:
        return null;
    }
  })();

  return (
    <main className="settings-page">
      <nav className="settings-nav" aria-label={t("tabSettingsLabel")}>
        {SETTINGS_SECTIONS.map((id) => (
          <button
            key={id}
            type="button"
            className={id === section ? "settings-nav-item active" : "settings-nav-item"}
            aria-current={id === section ? "page" : undefined}
            onClick={() => setSection(id)}
          >
            {t(SECTION_LABEL[id])}
          </button>
        ))}
      </nav>
      <div className="settings-content" ref={contentRef}>
        <div className="settings-panel">{content}</div>
      </div>
      {rootDialogOpen && (
        <RootAddDialog
          onClose={() => setRootDialogOpen(false)}
          onChoose={(kind) => {
            setRootDialogOpen(false);
            void rootsApi.addRoot(kind);
          }}
        />
      )}
    </main>
  );
}

/** Cmd+, (Ctrl+, elsewhere) opens the settings window from either page */
export function useSettingsShortcut(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        void invoke("open_settings").catch(() => {});
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** The settings file's paths (from Rust) and whether the MCP removal note still shows */
function useSettingsFileSection() {
  const [paths, setPaths] = useState<SettingsFilePaths | null>(null);
  const [mcpNote, setMcpNote] = useState(false);
  useEffect(() => {
    // Outside the app (the browser mock) the everyday build's paths, so the section can be looked at
    void invoke<SettingsFilePaths | null>("settings_file_paths").then(setPaths, () =>
      setPaths({ settings: "~/.tomarigi/settings.json", settingsAbsolute: "", readme: "~/.tomarigi/README.md", log: "" }),
    );
    const load = () => void kvGet(KEY_MCP_REMOVED_NOTE).then((v) => setMcpNote(v === "shown"), () => {});
    load();
    return onSettingsChanged([KEY_MCP_REMOVED_NOTE], load);
  }, []);
  const closeMcpNote = () => {
    setMcpNote(false);
    void kvPut(KEY_MCP_REMOVED_NOTE, "closed");
  };
  return { paths, mcpNote, closeMcpNote };
}
