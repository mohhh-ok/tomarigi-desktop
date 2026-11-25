// Settings by an AI agent (docs/design.md "Settings by an AI agent (MCP)"): the on/off setting and port, starting and
// stopping the MCP server in Rust (src-tauri/src/mcp.rs), and running each tool call it hands over ("mcp-call") with
// the settings screen's own functions (lib/agent-tools.ts)
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "@/lib/i18n";
import { kvGet, kvPut } from "@/lib/settings-store";
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

  const changeEnabled = useCallback(
    (enabled: boolean) => {
      save({ ...settingRef.current, enabled });
      setStatus(enabled ? "starting" : "off");
      if (enabled) {
        void start(settingRef.current.port);
      } else {
        void invoke("mcp_stop").catch(() => {});
        setStatus("off");
        setCommand(null);
      }
    },
    [save, start],
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

  return {
    enabled: setting.enabled,
    port: setting.port,
    status,
    command,
    replaced,
    recent,
    notes,
    changeEnabled,
    changePort,
    renewToken,
  };
}

