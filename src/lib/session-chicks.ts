// Chicks: subagents under a parent's transcript folder, and sessions started via the SDK
import type { NativeDirectoryHandle, NativeFile, NativeFileHandle } from "./native-fs";
import { scanChickSignals } from "./transcript";
import type { ChickMeta, ChickScan, ChickView, FoundEntry } from "./session-types";
import { chickMetaCache, chickSignalLedger } from "./session-store";
import { readTailCached } from "./session-tail";
import { deriveSdkChickState, deriveState } from "./bird-state";

// Tolerance when comparing a chick's completion signal (chickSignals) with the chick's last conversation time
// (tail.lastEventAt ?? file.lastModified). Normally the order is "chick's last write → notification written
// to the parent a few seconds later", so last conversation time <= signal always holds. A resumed chick's
// last conversation time moves clearly past the signal, so if it exceeds the signal by more than a few
// seconds' margin we treat it as resumed and invalidate the signal (see scanChicks)
const CHICK_SIGNAL_EPSILON_MS = 5_000;

/**
 * Looks into subagents/ only for parent sessions that are displayed
 * (<projectDir>/<sessionId>/subagents/agent-*.jsonl).
 * A missing directory (NotFoundError) is the normal no-chick case, so it is swallowed.
 *
 * parentTailSignals: chickSignals taken from the parent tail (already read by readTailCached), merged with the
 * whole-transcript ledger (chickSignalLedger). The chick completion check treats these as the source of truth
 * (see the isChick comment in deriveState), and a chick with a completion record is not listed under the parent.
 * The caller (scanSessions) must read the parent tail before scanChicks.
 */
export async function scanChicks(
  projectDir: NativeDirectoryHandle,
  sessionFileName: string,
  parentId: string,
  now: number,
  parentTailSignals: Map<string, number>,
  parentFile: NativeFile,
): Promise<ChickScan[]> {
  const sessionId = sessionFileName.replace(/\.jsonl$/, "");
  let subagentsDir: NativeDirectoryHandle;
  try {
    const sessionDir = await projectDir.getDirectoryHandle(sessionId);
    subagentsDir = await sessionDir.getDirectoryHandle("subagents");
  } catch (e) {
    // A missing directory (NotFoundError) is the normal no-chick case. Anything else is abnormal, so leave a trace
    if (!(e instanceof DOMException && e.name === "NotFoundError")) {
      console.warn("[tomarigi] failed to scan subagents", parentId, e);
    }
    return [];
  }

  // Completion records from the whole parent transcript, plus the tail window (it can be ahead of the ledger by
  // lines appended between the two reads). The latest time wins, as in TailInfo.chickSignals
  let ledger = chickSignalLedger.get(parentId);
  if (!ledger || parentFile.size < ledger.end) ledger = { end: 0, signals: new Map() };
  if (parentFile.size > ledger.end) {
    const scan = await scanChickSignals(parentFile, ledger.end);
    for (const [key, at] of scan.signals) ledger.signals.set(key, Math.max(ledger.signals.get(key) ?? 0, at));
    ledger.end = scan.end;
  }
  chickSignalLedger.set(parentId, ledger);
  const parentChickSignals = new Map(ledger.signals);
  for (const [key, at] of parentTailSignals) parentChickSignals.set(key, Math.max(parentChickSignals.get(key) ?? 0, at));

  const chicks: ChickScan[] = [];
  for await (const entry of subagentsDir.values()) {
    if (entry.kind !== "file" || !entry.name.endsWith(".jsonl")) continue;
    const file = await (entry as NativeFileHandle).getFile();

    const chickId = `${parentId}/${entry.name}`;
    const tail = await readTailCached(chickId, file, { includeSidechain: true });
    // Use tail.lastEventAt as the basis for the same reason as the parent scan's sinceMs (see the equivalent
    // place in scanSessions). sinceMs is for display, so the mtime fallback is acceptable
    const chickSinceBasis = tail.lastEventAt ?? file.lastModified;
    const sinceMs = now - chickSinceBasis;
    const meta = await resolveChickMeta(subagentsDir, entry.name, chickId);
    // Recover the task-id from the file name agent-<task-id>.jsonl. It matches <task-id> in
    // task-notification (confirmed in real data). Even with naming lacking the "agent-" prefix
    // (should it change in the future), it is just used as the key as-is; the signal simply won't be found
    // and it falls to the later fallback check, so it errs on the safe side
    const taskId = entry.name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    // Pass tail.lastEventAt as-is, before the mtime fallback, to the resume check (resolveChickDoneSignalAt).
    // Not trusting mtime is the very reason that function exists, and substituting chickSinceBasis (meant for
    // sinceMs) would bring back the same problem (mistaking a later touch for a resume)
    const chickDoneSignalAt = resolveChickDoneSignalAt(
      parentChickSignals,
      taskId,
      meta.toolUseId,
      tail.lastEventAt,
    );
    chicks.push({
      view: {
        id: chickId,
        name: meta.name,
        state: deriveState(tail, sinceMs, true, chickDoneSignalAt),
        sinceMs,
        toolName: tail.kind === "tool_use" ? tail.toolName : undefined,
      },
      completed: chickDoneSignalAt !== undefined,
    });
  }
  chicks.sort((a, b) => a.view.sinceMs - b.view.sinceMs);
  return chicks;
}

/**
 * Resolves this chick's completion signal from the parent ledger (parentChickSignals). A chick can have two
 * kinds of identifier (async start = task-id, sync call = toolUseId in meta.json), so look up both, and if by
 * any chance both have a signal, take the newer one (repeated resumes can update both separately).
 *
 * Normally only one has a value: task-id (task-notification) fires every time the agent stops, so it can be
 * updated on each resume, whereas toolUseId (tool_result) gets a value only once, because once a blocking
 * call's result has returned the tool_use_id is resolved at the API level and never reused (later resumes go
 * through another path such as SendMessage and have a new tool_use_id). Both having a value would only happen
 * in an unexpected case like "the same chick was once started by a sync call and later also went through the
 * async notification path", not confirmed in real data. Math.max is insurance against that unexpected case.
 *
 * Even with a signal, if the chick's last conversation time (chickLastEventAt, tail.lastEventAt; no fallback
 * to mtime, reason below) is clearly after the signal (by more than CHICK_SIGNAL_EPSILON_MS), treat the chick
 * as resumed after the signal and writing again, and invalidate it (return undefined = treat as "no signal".
 * The parent can resume a chick with the same task-id and writes resume in the same jsonl, so pinning the
 * signal as a past one would leave it done forever even after the resume).
 * The last conversation time is used instead of mtime so that later appends without a timestamp (a touch that
 * only changes mtime) aren't mistaken for a resume — with an mtime basis every ghost touch would invalidate a
 * valid completion signal, and a chick that should be finished would look like it is working.
 *
 * If chickLastEventAt is undefined (the tail window has no line with a timestamp, so the last conversation
 * time is unknown), the resume check itself is skipped and the signal is treated as valid as-is. No fallback
 * to mtime — as above, not trusting mtime is the very reason this function exists, and substituting it would
 * bring back the same "a later touch revives a finished chick into working" problem.
 */
export function resolveChickDoneSignalAt(
  parentChickSignals: Map<string, number>,
  taskId: string,
  toolUseId: string | undefined,
  chickLastEventAt: number | undefined,
): number | undefined {
  const byTaskId = parentChickSignals.get(taskId);
  const byToolUseId = toolUseId ? parentChickSignals.get(toolUseId) : undefined;
  const signalAt =
    byTaskId === undefined ? byToolUseId : byToolUseId === undefined ? byTaskId : Math.max(byTaskId, byToolUseId);
  if (signalAt === undefined) return undefined;
  if (chickLastEventAt === undefined) return signalAt; // last conversation time unknown. No basis to conclude a resume, so return the signal as valid
  if (chickLastEventAt > signalAt + CHICK_SIGNAL_EPSILON_MS) return undefined; // resumed. The signal is invalid
  return signalAt;
}

/**
 * Reads agent-<id>.meta.json. Claude Code's real data has no name, only description, so fall back in order
 * name → description → file name.
 * toolUseId is the matching key for the sync chick completion signal (resolveChickDoneSignalAt).
 */
async function resolveChickMeta(
  subagentsDir: NativeDirectoryHandle,
  fileName: string,
  chickId: string,
): Promise<ChickMeta> {
  const cached = chickMetaCache.get(chickId);
  if (cached) return cached;

  const base = fileName.replace(/\.jsonl$/, "");
  let meta: ChickMeta = { name: base };
  try {
    const metaHandle = await subagentsDir.getFileHandle(`${base}.meta.json`);
    const metaFile = await metaHandle.getFile();
    const raw = JSON.parse(await metaFile.text()) as {
      name?: string;
      description?: string;
      toolUseId?: string;
    };
    meta = {
      name: raw.name ?? raw.description ?? base,
      toolUseId: typeof raw.toolUseId === "string" ? raw.toolUseId : undefined,
    };
  } catch {
    // If meta.json is missing/broken, fall back to the file name for the name and continue without toolUseId
    // (not fatal: even without toolUseId, signal matching via task-id still works)
  }
  chickMetaCache.set(chickId, meta);
  return meta;
}

// Turning sessions started via the SDK (Claude Agent SDK) into chicks. The entrypoint field is an
// internal spec; cli/sdk-py were confirmed in real data (2026-08-08; see the comment on TailInfo.entrypoint).
// Sessions where it can't be read because the tail window has no line with entrypoint stay undefined
// = there is no basis to conclude they were SDK-started, so err on the safe side and keep treating them as cli (adults).
const SDK_ENTRYPOINT_RE = /^sdk/;
export function isSdkSession(f: FoundEntry): boolean {
  return f.agent === "claude" && SDK_ENTRYPOINT_RE.test(f.tail.entrypoint ?? "");
}
// Use the same time basis as the state check (tail.lastEventAt, else file.lastModified; see the comment on
// TailInfo.lastEventAt) for choosing parent candidates too
function effectiveLastEventAt(f: FoundEntry): number {
  return f.tail.lastEventAt ?? f.file.lastModified;
}

/**
 * Makes each SDK session a chick of its parent candidate. Returns the entries shown as birds (non-SDK sessions and
 * SDK orphans) and the SDK chicks by parent id
 */
export function assignSdkChicks(
  found: FoundEntry[],
  now: number,
): { displayEntries: FoundEntry[]; sdkChicksByParentId: Map<string, ChickScan[]> } {
  const sdkEntries = found.filter(isSdkSession);
  const nonSdkEntries = found.filter((f) => !isSdkSession(f));

  // Parent candidate: within "the same project directory" = same root and same slug, the non-SDK session with
  // the newest last conversation time. found is still every entry whose process is alive, and
  // non-SDK sessions always become displayed via withTail after this, so the "is displayed" condition is also
  // satisfied automatically
  const parentCandidateByGroup = new Map<string, FoundEntry>(); // key: `${rootId}/${slug}`
  for (const f of nonSdkEntries) {
    const key = `${f.rootId}/${f.slug}`;
    const current = parentCandidateByGroup.get(key);
    if (!current || effectiveLastEventAt(f) > effectiveLastEventAt(current)) {
      parentCandidateByGroup.set(key, f);
    }
  }

  // SDK sessions are collected as chicks (ChickScan) keyed by the parent candidate's id. Orphans with no parent
  // candidate (= no other non-SDK session in the same project directory) are not dropped but fall back to being
  // shown as adult birds as before (orphanSdkEntries).
  // Parent candidates are only recomputed on each scan (not persisted), so when a newer non-SDK session appears
  // the SDK chick naturally moves to it (never tied to the previous parent again)
  const sdkChicksByParentId = new Map<string, ChickScan[]>();
  const orphanSdkEntries: FoundEntry[] = [];
  for (const f of sdkEntries) {
    const parent = parentCandidateByGroup.get(`${f.rootId}/${f.slug}`);
    if (!parent) {
      orphanSdkEntries.push(f);
      continue;
    }
    const sinceMs = now - effectiveLastEventAt(f);
    // The chick id is fixed based on the file name (stable even when the parent changes. File names are unique
    // within a project directory, so combined with slug they don't collide across roots).
    // It is in a separate "sdk:" namespace from existing subagent chick ids (`${parent id}/${file name}`) and
    // SessionEvent.key (`${sessionId}:${at}:${type}`, always derived from the parent id), so it collides with
    // neither chickMetaCache nor event deduplication
    const chickId = `sdk:${f.slug}/${f.file.name}`;
    const view: ChickView = {
      id: chickId,
      name: "SDK", // no meta.json exists (SDK starts don't have one), so a fixed name instead of resolveChickMeta
      // The parent ledger (chickSignals) has no completion signal for SDK chicks (it is a mechanism on the
      // parent transcript side, so it doesn't appear in the SDK session's own tail). Use the dedicated
      // deriveSdkChickState instead of deriveState (see the comment on its definition for why)
      state: deriveSdkChickState(f.tail, sinceMs),
      sinceMs,
      toolName: f.tail.kind === "tool_use" ? f.tail.toolName : undefined,
    };
    const list = sdkChicksByParentId.get(parent.id) ?? [];
    // An SDK chick is its own process: it is shown while that process is alive (the liveness check above), so it
    // never counts as completed here
    list.push({ view, completed: false });
    sdkChicksByParentId.set(parent.id, list);
  }

  // Displayed entries (those that can become a SessionView) = non-SDK sessions + SDK orphans with no parent candidate
  const displayEntries = [...nonSdkEntries, ...orphanSdkEntries];
  return { displayEntries, sdkChicksByParentId };
}
