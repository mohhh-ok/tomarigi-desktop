// The file each editor window writes for Tomarigi (docs/design.md "Jumping to the terminal pane", VS Code / Cursor):
// ~/.tomarigi/vscode/<uriScheme>-<extension host pid>.json with a URI addressed to this window and the processId of
// every terminal in it. Tomarigi reads it with src-tauri/src/focus/vscode.rs. Nothing here imports vscode, so it runs
// under bun test
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WindowEntry {
  /** `<scheme>://<extension id>/focus?windowId=<n>` from env.asExternalUri */
  uri: string;
  extensionHostPid: number;
  terminalPids: number[];
}

export function registryDir(home = os.homedir()): string {
  return path.join(home, ".tomarigi", "vscode");
}

export function entryPath(dir: string, uriScheme: string, extensionHostPid: number): string {
  return path.join(dir, `${uriScheme}-${extensionHostPid}.json`);
}

/** Writes through a temporary file so Tomarigi never reads half a file */
export function writeEntry(file: string, entry: WindowEntry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry));
  fs.renameSync(tmp, file);
}

export function removeEntry(file: string): void {
  fs.rmSync(file, { force: true });
}

/** The pids Tomarigi put in the URI query (`pids=540,530,520`) */
export function pidsOf(query: string): number[] {
  const value = new URLSearchParams(query).get("pids") ?? "";
  return value
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** The first terminal whose shell is one of the pids. processId is undefined for terminals without a process */
export async function terminalOf<T extends { processId: PromiseLike<number | undefined> }>(
  terminals: readonly T[],
  pids: readonly number[],
): Promise<T | undefined> {
  const ids = await Promise.all(terminals.map((t) => t.processId));
  const index = ids.findIndex((id) => id !== undefined && pids.includes(id));
  return index < 0 ? undefined : terminals[index];
}

export async function terminalPids(terminals: readonly { processId: PromiseLike<number | undefined> }[]): Promise<number[]> {
  const ids = await Promise.all(terminals.map((t) => t.processId));
  return ids.filter((id): id is number => id !== undefined);
}
