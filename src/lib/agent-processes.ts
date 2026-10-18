// Liveness of agents that write no pid file (docs/design.md "Agents"): a session is alive while a process of its
// agent runs in the session's cwd. The processes come from ps (tty_processes in Rust) and their cwd from lsof
// (process_cwds); which sessions they stand for is decided here (matchSessionsToProcesses)
import { invoke } from "@tauri-apps/api/core";
import { basename } from "./paths";

export interface AgentProcess {
  pid: number;
  tty: string;
  startedAt: number; // epoch ms, to the second
  cwd: string;
}

export interface AgentProcessScan {
  processes: AgentProcess[];
  // false when ps or lsof failed on this read; birds are not removed on such reads
  reliable: boolean;
}

/**
 * argv split on whitespace. A double-quoted part is one argument: Windows command lines come quoted where an
 * argument has spaces (tty_processes in Rust). ps on macOS / Linux prints no quotes, so a path with spaces there just
 * isn't recognised
 */
export function argvOf(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]).filter(Boolean);
}

/** The file name of a path, "/" or "\\" separated. A Windows ".exe" is dropped so `opencode.exe` reads as opencode */
export function basenameOf(path: string): string {
  return basename(path).replace(/\.exe$/i, "");
}

/**
 * The program a command line runs: argv[0], or the script after an interpreter (node / bun and their flags), so
 * that `node /opt/homebrew/bin/gemini` reads as gemini. Returns the full path
 */
export function programOf(argv: string[]): string | undefined {
  const first = argv[0];
  if (!first) return undefined;
  if (!/^(node|bun|nodejs)$/.test(basenameOf(first))) return first;
  return argv.slice(1).find((arg) => !arg.startsWith("-"));
}

/** Matcher for agents whose program is named `name` (a binary, or a script run by node / bun) */
export function programNamed(name: string): (argv: string[]) => boolean {
  return (argv) => {
    const program = programOf(argv);
    return program !== undefined && basenameOf(program) === name;
  };
}

/**
 * Processes with a tty per agent kind, with their cwd. One ps and one lsof per read, shared by every agent.
 * matchers: kind → whether a command line is that agent's process
 */
export async function loadAgentProcesses<K extends string>(
  matchers: Map<K, (argv: string[]) => boolean>,
): Promise<{ byKind: Map<K, AgentProcess[]>; reliable: boolean }> {
  const byKind = new Map<K, AgentProcess[]>([...matchers.keys()].map((k) => [k, []]));
  if (matchers.size === 0) return { byKind, reliable: true };
  const ps = await invoke<{
    processes: { pid: number; tty: string; startedAtMs: number; command: string }[];
    reliable: boolean;
  }>("tty_processes").catch(() => ({ processes: [], reliable: false }));
  if (!ps.reliable) return { byKind, reliable: false };
  const picked: { kind: K; pid: number; tty: string; startedAt: number }[] = [];
  for (const p of ps.processes) {
    const argv = argvOf(p.command);
    for (const [kind, matches] of matchers) {
      if (matches(argv)) {
        picked.push({ kind, pid: p.pid, tty: p.tty, startedAt: p.startedAtMs });
        break;
      }
    }
  }
  if (picked.length === 0) return { byKind, reliable: true };
  const lsof = await invoke<{ cwds: [number, string][]; reliable: boolean }>("process_cwds", {
    pids: picked.map((p) => p.pid),
  }).catch(() => ({ cwds: [] as [number, string][], reliable: false }));
  if (!lsof.reliable) return { byKind, reliable: false };
  const cwdOf = new Map(lsof.cwds);
  for (const p of picked) {
    const cwd = cwdOf.get(p.pid);
    // Ended between ps and lsof
    if (cwd === undefined) continue;
    byKind.get(p.kind)?.push({ pid: p.pid, tty: p.tty, startedAt: p.startedAt, cwd });
  }
  return { byKind, reliable: true };
}

// ps gives the start time to the second, and a session file can be created in the same second
const START_SLACK_MS = 2_000;

export interface SessionCandidate {
  id: string;
  key: string | undefined; // what a process's cwd is compared with (the cwd, or the folder name derived from it)
  writtenAt: number; // epoch ms of the session's last write
}

export interface ProcessMatch {
  // The pid to jump to. Only the session written last in a cwd gets one (the newest process there)
  pid?: number;
  cwd: string;
}

/** Earliest start among the processes; sessions last written before it can't belong to any of them */
export function earliestStart(processes: { startedAt: number }[]): number | undefined {
  return processes.length === 0 ? undefined : Math.min(...processes.map((p) => p.startedAt)) - START_SLACK_MS;
}

/**
 * Which sessions are alive (docs/design.md "Agents"): when N processes of one agent share a cwd, the N sessions in
 * that cwd written since that agent's processes started, latest first, are alive. The session written last gets
 * the newest process as its jump target; the others have no pid
 */
export function matchSessionsToProcesses(
  sessions: SessionCandidate[],
  processes: { pid: number; startedAt: number; cwd: string; key: string }[],
): Map<string, ProcessMatch> {
  const result = new Map<string, ProcessMatch>();
  const byKey = new Map<string, typeof processes>();
  for (const p of processes) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
  for (const [key, group] of byKey) {
    const newestFirst = [...group].sort((a, b) => b.startedAt - a.startedAt);
    const since = earliestStart(group) ?? Infinity;
    const alive = sessions
      .filter((s) => s.key === key && s.writtenAt >= since)
      .sort((a, b) => b.writtenAt - a.writtenAt)
      .slice(0, group.length);
    alive.forEach((s, i) => {
      result.set(s.id, { pid: i === 0 ? newestFirst[0].pid : undefined, cwd: newestFirst[0].cwd });
    });
  }
  return result;
}
