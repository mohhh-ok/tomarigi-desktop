// Finding the rollout files of live Codex threads under ~/.codex/sessions
import type { NativeDirectoryHandle, NativeFile, NativeFileHandle } from "./native-fs";
import type { RootEntry } from "./settings-store";
import { codexRolloutPathCache } from "./session-store";
import { codexDirOf } from "./session-liveness";

export interface CodexRollout {
  file: NativeFile;
  path: string; // YYYY/MM/DD/<file name>, relative to the sessions folder
}

/** ~/.codex/sessions for either accepted watched folder (~/.codex/sessions or ~/.codex). undefined if missing */
export async function codexSessionsDir(selectedRoot: NativeDirectoryHandle): Promise<NativeDirectoryHandle | undefined> {
  if (selectedRoot.name === "sessions") return selectedRoot;
  try {
    return await selectedRoot.getDirectoryHandle("sessions");
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotFoundError") return undefined;
    throw e;
  }
}

/** The threadId at the end of a rollout file name (`rollout-<time>-<threadId>.jsonl`) */
export function codexThreadIdOf(fileName: string): string | undefined {
  return /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(fileName)?.[1];
}

/** The file at a path relative to dir, or undefined if it doesn't exist */
export async function fileAt(dir: NativeDirectoryHandle, path: string): Promise<NativeFile | undefined> {
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  try {
    let current = dir;
    for (const part of parts) current = await current.getDirectoryHandle(part);
    return await (await current.getFileHandle(name)).getFile();
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotFoundError") return undefined;
    throw e;
  }
}

function datePathOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}/${month}/${day}`;
}

/**
 * Finds the rollout of a live thread. Codex stores rollouts below the YYYY/MM/DD (local time) of the thread's
 * creation, and threadIds are UUIDv7 whose first 48 bits are that time in ms, so only that day and its neighbours
 * are listed (a thread resumed days later still lives in its creation day's folder). A threadId that isn't
 * UUIDv7 falls back to listing every day folder. undefined while codex hasn't written the rollout yet, and for
 * internal threads that never get one
 */
export async function findCodexRollout(
  rootId: string,
  sessionsDir: NativeDirectoryHandle,
  threadId: string,
): Promise<CodexRollout | undefined> {
  const cacheKey = `${rootId}:${threadId}`;
  const cachedPath = codexRolloutPathCache.get(cacheKey);
  if (cachedPath) {
    const file = await fileAt(sessionsDir, cachedPath);
    if (file) return { file, path: cachedPath };
    codexRolloutPathCache.delete(cacheKey);
  }

  const hex = threadId.replace(/-/g, "");
  const dayDirs: string[] = [];
  if (hex[12] === "7") {
    const createdAt = parseInt(hex.slice(0, 12), 16);
    for (const offset of [0, -1, 1]) dayDirs.push(datePathOf(new Date(createdAt + offset * 24 * 60 * 60_000)));
  } else {
    for await (const year of sessionsDir.values()) {
      if (year.kind !== "directory") continue;
      for await (const month of year.values()) {
        if (month.kind !== "directory") continue;
        for await (const day of month.values()) {
          if (day.kind === "directory") dayDirs.push(`${year.name}/${month.name}/${day.name}`);
        }
      }
    }
  }

  const suffix = `-${threadId}.jsonl`;
  for (const datePath of dayDirs) {
    try {
      let dir = sessionsDir;
      for (const part of datePath.split("/")) dir = await dir.getDirectoryHandle(part);
      for await (const entry of dir.values()) {
        if (entry.kind !== "file" || !entry.name.startsWith("rollout-") || !entry.name.endsWith(suffix)) continue;
        const path = `${datePath}/${entry.name}`;
        codexRolloutPathCache.set(cacheKey, path);
        return { file: await (entry as NativeFileHandle).getFile(), path };
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
    }
  }
  return undefined;
}

/** Forgets where rollouts of ended threads are */
export function forgetEndedRollouts(roots: RootEntry[], threadIdsByCodexDir: Map<string, Set<string>>): void {
  const liveThreadKeys = new Set(
    roots
      .filter((r) => r.kind === "codex")
      .flatMap((r) => [...(threadIdsByCodexDir.get(codexDirOf(r)) ?? [])].map((t) => `${r.id}:${t}`)),
  );
  for (const key of codexRolloutPathCache.keys()) if (!liveThreadKeys.has(key)) codexRolloutPathCache.delete(key);
}
