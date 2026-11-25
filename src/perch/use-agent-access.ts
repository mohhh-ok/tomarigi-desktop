// Settings by an AI agent (docs/design.md "Settings by an AI agent (MCP)"): the on/off setting and port, starting and
// stopping the MCP server in Rust (src-tauri/src/mcp.rs), and running each tool call it hands over ("mcp-call") with
// the settings screen's own functions (lib/agent-tools.ts)
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { t } from "@/lib/i18n";
import { kvGet, kvPut } from "@/lib/settings-store";
import { onSettingsChanged } from "@/lib/settings-sync";
import { fetchLocalModels, testLocalConnection } from "@/lib/local-judge";
import { testOpenAiConnection } from "@/lib/openai-judge";
import { testJudgeConnection } from "@/lib/judge";
import { fetchIsVoicevoxEngine, fetchTtsModels, fetchTtsVoices } from "@/lib/tts-server";
import {
  AGENT_TOOLS,
  runAgentTool,
  type AgentChange,
  type AgentToolDeps,
  type SettingsSnapshot,
} from "@/lib/agent-tools";

const KEY_AGENT_ACCESS = "agentAccess";
/** What the settings window asks the floating window to do that isn't a saved setting (docs/design.md "Settings window") */
const AGENT_ACCESS_ACTION = "agent-access-action";
type AgentAccessAction = "renew" | "retry";
export const DEFAULT_AGENT_PORT = 4844;

interface AgentAccessSetting {
  enabled: boolean;
  port: number;
}

export type AgentAccessStatus = "off" | "starting" | "on" | "port-in-use" | "no-key-store" | "failed";

/** A change made by the agent, with when, for the note and the card's list */
export interface AgentChangeEntry extends AgentChange {
  id: number;
  at: number;
}

/** The port field's rule: the range a user's app may listen on */
export function isValidAgentPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function parseSetting(saved: unknown): AgentAccessSetting {
  const v = (typeof saved === "object" && saved !== null ? saved : {}) as Record<string, unknown>;
  const port = typeof v.port === "number" && isValidAgentPort(v.port) ? v.port : DEFAULT_AGENT_PORT;
  return { enabled: v.enabled === true, port };
}

function log(line: string) {
  void invoke("log", { line }).catch(() => {});
}

const RECENT_LIMIT = 10;
const NOTE_MS = 6_000;

/** `deps` is everything a tool call needs, without `snapshot`/`say`/`now` and the list and test functions, which are
 * the same for every caller. It is read from a ref on each call, so a call sees the latest values */
export type AgentAccessDeps = Omit<
  AgentToolDeps,
  | "say"
  | "now"
  | "fetchLocalModels"
  | "fetchTtsVoices"
  | "fetchTtsModels"
  | "fetchIsVoicevoxEngine"
  | "testLocalAi"
  | "testCloudAi"
  | "snapshot"
> & { snapshot(): Omit<SettingsSnapshot, "port"> };

export function useAgentAccess(ready: boolean, deps: AgentAccessDeps) {
  const [setting, setSetting] = useState<AgentAccessSetting>({ enabled: false, port: DEFAULT_AGENT_PORT });
  const [status, setStatus] = useState<AgentAccessStatus>("off");
  const [command, setCommand] = useState<string | null>(null);
  // The command changed while the user may have registered an older one (renewed token or another port)
  const [replaced, setReplaced] = useState(false);
  const [recent, setRecent] = useState<AgentChangeEntry[]>([]);
  const [notes, setNotes] = useState<AgentChangeEntry[]>([]);
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const settingRef = useRef(setting);
  settingRef.current = setting;
  const nextId = useRef(0);

  const start = useCallback(async (port: number) => {
    setStatus("starting");
    try {
      const cmd = await invoke<string>("mcp_start", { port, tools: AGENT_TOOLS });
      setCommand(cmd);
      setStatus("on");
      return true;
    } catch (e) {
      const reason = String(e);
      log(`[mcp] start failed port=${port}: ${reason.slice(0, 120)}`);
      setCommand(null);
      setStatus(reason === "port-in-use" ? "port-in-use" : reason === "no-key-store" ? "no-key-store" : "failed");
      // Without a key store it can't be on at all on this computer, so the switch goes back off
      if (reason === "no-key-store") {
        settingRef.current = { ...settingRef.current, enabled: false };
        setSetting(settingRef.current);
        void kvPut(KEY_AGENT_ACCESS, settingRef.current);
      }
      return false;
    }
  }, []);

  const save = useCallback((next: AgentAccessSetting) => {
    settingRef.current = next;
    setSetting(next);
    void kvPut(KEY_AGENT_ACCESS, next);
  }, []);

  // After the settings are loaded, so the first call sees the saved values
  useEffect(() => {
    if (!ready) return;
    void (async () => {
      let loaded = parseSetting(await kvGet(KEY_AGENT_ACCESS));
      // For verification: TOMARIGI_AGENT_ACCESS=<port> turns it on with that port, `off` turns it off (README)
      const imported = await invoke<string | null>("agent_access_import").catch(() => null);
      if (imported === "off" || (imported && isValidAgentPort(Number(imported)))) {
        loaded = imported === "off" ? { ...loaded, enabled: false } : { enabled: true, port: Number(imported) };
        await kvPut(KEY_AGENT_ACCESS, loaded);
        log(`[mcp] imported setting ${imported === "off" ? "off" : `port=${imported}`}`);
      }
      settingRef.current = loaded;
      setSetting(loaded);
      if (loaded.enabled) void start(loaded.port);
    })();
  }, [ready, start]);

  /** Starts or stops the server for a setting already saved */
  const applyEnabled = useCallback(
    (enabled: boolean) => {
      setStatus(enabled ? "starting" : "off");
      if (enabled) {
        void start(settingRef.current.port);
      } else {
        void invoke("mcp_stop").catch(() => {});
        setStatus("off");
        setCommand(null);
      }
    },
    [start],
  );

  const changeEnabled = useCallback(
    (enabled: boolean) => {
      save({ ...settingRef.current, enabled });
      applyEnabled(enabled);
    },
    [save, applyEnabled],
  );

  /** Returns false for a port outside the field's rule (nothing is saved) */
  const changePort = useCallback(
    (port: number): boolean => {
      if (!isValidAgentPort(port)) return false;
      if (port === settingRef.current.port && status !== "port-in-use") return true;
      save({ ...settingRef.current, port });
      if (settingRef.current.enabled) {
        void start(port).then((ok) => ok && setReplaced(true));
      }
      return true;
    },
    [save, start, status],
  );

  // The settings window saves the setting; the floating window, which runs the server, follows it
  useEffect(() => {
    if (!ready) return;
    return onSettingsChanged([KEY_AGENT_ACCESS], () => {
      void kvGet(KEY_AGENT_ACCESS).then((saved) => {
        const next = parseSetting(saved);
        const prev = settingRef.current;
        settingRef.current = next;
        setSetting(next);
        if (next.enabled !== prev.enabled) applyEnabled(next.enabled);
        else if (next.enabled && next.port !== prev.port) void start(next.port).then((ok) => ok && setReplaced(true));
      });
    });
  }, [ready, applyEnabled, start]);

  const renewToken = useCallback(async () => {
    try {
      setCommand(await invoke<string>("mcp_renew_token", { port: settingRef.current.port }));
      setReplaced(true);
    } catch (e) {
      log(`[mcp] renew failed: ${String(e).slice(0, 120)}`);
    }
  }, []);

  const record = useCallback((tool: string, changes: AgentChange[]) => {
    if (changes.length === 0) return;
    const at = Date.now();
    const entries = changes.map((c) => ({ ...c, id: ++nextId.current, at }));
    for (const c of changes) log(`[mcp] changed tool=${tool} ${c.setting}: ${c.from} -> ${c.to}`);
    setRecent((prev) => [...entries.reverse(), ...prev].slice(0, RECENT_LIMIT));
    setNotes((prev) => [...prev, ...entries]);
    const ids = new Set(entries.map((e) => e.id));
    setTimeout(() => setNotes((prev) => prev.filter((n) => !ids.has(n.id))), NOTE_MS);
  }, []);

  useEffect(() => {
    const unlisten = listen<{ id: number; name: string; arguments: unknown }>("mcp-call", async ({ payload }) => {
      const d = depsRef.current;
      const toolDeps: AgentToolDeps = {
        ...d,
        snapshot: () => ({ ...depsRef.current.snapshot(), port: settingRef.current.port }),
        fetchLocalModels,
        fetchTtsVoices,
        fetchTtsModels,
        fetchIsVoicevoxEngine,
        testLocalAi: (config) => testLocalConnection(config),
        testCloudAi: (provider) => (provider === "openai" ? testOpenAiConnection() : testJudgeConnection()),
        say: t,
        now: () => performance.now(),
      };
      let reply: { ok: boolean; text: string; data?: unknown };
      try {
        const result = await runAgentTool(payload.name, payload.arguments, toolDeps);
        record(payload.name, result.changes);
        reply = { ok: result.ok, text: result.text, ...(result.data !== undefined && { data: result.data }) };
      } catch (e) {
        log(`[mcp] tool ${payload.name} threw: ${String(e).slice(0, 120)}`);
        reply = { ok: false, text: `Tomarigi failed while running ${payload.name}. The app log has the details.` };
      }
      void invoke("mcp_reply", { id: payload.id, reply }).catch(() => {});
    });
    return () => void unlisten.then((f) => f());
  }, [record]);

  useEffect(() => {
    const unlisten = listen<AgentAccessAction>(AGENT_ACCESS_ACTION, ({ payload }) => {
      if (payload === "renew") void renewToken();
      else if (payload === "retry" && settingRef.current.enabled) void start(settingRef.current.port);
    });
    return () => void unlisten.then((f) => f());
  }, [renewToken, start]);

  const dismissNotes = useCallback(() => setNotes([]), []);

  return {
    enabled: setting.enabled,
    port: setting.port,
    status,
    command,
    replaced,
    recent,
    notes,
    dismissNotes,
    changeEnabled,
    changePort,
    renewToken,
  };
}


/** What the floating window shows of the agent access that isn't saved, sent to the settings window */
export interface AgentAccessRuntime {
  status: AgentAccessStatus;
  command: string | null;
  replaced: boolean;
  recent: AgentChangeEntry[];
}

export const AGENT_ACCESS_OFF: AgentAccessRuntime = { status: "off", command: null, replaced: false, recent: [] };

/** The settings window's side: the saved setting, the floating window's runtime state, and saves that the floating
 * window follows. Renewing the token and retrying a port in use are sent to it as actions */
export function useAgentAccessView(runtime: AgentAccessRuntime) {
  const [setting, setSetting] = useState<AgentAccessSetting>({ enabled: false, port: DEFAULT_AGENT_PORT });
  const settingRef = useRef(setting);
  settingRef.current = setting;

  useEffect(() => {
    const load = () => void kvGet(KEY_AGENT_ACCESS).then((saved) => setSetting(parseSetting(saved)), () => {});
    load();
    return onSettingsChanged([KEY_AGENT_ACCESS], load);
  }, []);

  const save = useCallback((next: AgentAccessSetting) => {
    settingRef.current = next;
    setSetting(next);
    void kvPut(KEY_AGENT_ACCESS, next);
  }, []);

  const act = (action: AgentAccessAction) => void emitTo("main", AGENT_ACCESS_ACTION, action).catch(() => {});

  return {
    enabled: setting.enabled,
    port: setting.port,
    ...runtime,
    // Off shows at once, before the floating window has stopped the server. A failure stays shown: without a key store
    // the floating window turns the setting back off and keeps saying why
    status: !setting.enabled && (runtime.status === "on" || runtime.status === "starting") ? ("off" as const) : runtime.status,
    changeEnabled: (enabled: boolean) => save({ ...settingRef.current, enabled }),
    changePort: (port: number): boolean => {
      if (!isValidAgentPort(port)) return false;
      if (port === settingRef.current.port) {
        if (runtime.status === "port-in-use") act("retry");
        return true;
      }
      save({ ...settingRef.current, port });
      return true;
    },
    renewToken: async () => act("renew"),
  };
}
