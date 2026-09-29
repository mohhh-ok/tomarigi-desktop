// Scans the watched folders for sessions (birds), their chicks, and their transition events. The steps live in
// the session-*.ts modules; the state kept across scans is in lib/session-store.ts
import { invoke } from "@tauri-apps/api/core";
import type { NativeDirectoryHandle, NativeFileHandle } from "./native-fs";
import type { RootEntry } from "./fsa";
import { watchingCount } from "./watching";
import { basename, projectLabels } from "./transcript";
import type {
  BirdState,
  ChickScan,
  ChickView,
  FoundEntry,
  LiveFoundEntry,
  ScanResult,
  SessionView,
} from "./session-types";
import {
  knownTranscriptIds,
  lastPeerStates,
  listedRootIds,
  pruneCaches,
  scanState,
  snippetCache,
  transcriptAppearedAt,
  userMessageCache,
} from "./session-store";
import {
  configDirOf,
  codexDirOf,
  inNeverSeenGrace,
  loadLiveCodexThreads,
  loadLiveSessions,
  logScan,
  sessionIdOfViewId,
  settleLiveness,
} from "./session-liveness";
import { codexSessionsDir, codexThreadIdOf, fileAt, findCodexRollout, forgetEndedRollouts, type CodexRollout } from "./codex-rollout";
import { readCodexTailCached, readTailCached, rememberUserMessage } from "./session-tail";
import { assignSdkChicks, isSdkSession, scanChicks } from "./session-chicks";
import { deriveSdkChickState, deriveState, escalateWithChicks, STATE_URGENCY } from "./bird-state";
import { extractQuestion, lastUserMessage, pickSnippet } from "./session-snippet";
import { deriveSessionEvents, updateBackgroundTasks } from "./session-events";
import { cacheEvent, recentEvents, saveEventLogIfDirty } from "./session-event-log";
import { rememberPeerStates, resolveWatchLinks, type WatchLinks } from "./session-watch";

export type { BirdState, ChickView, PeerLink, ScanResult, SessionEvent, SessionView } from "./session-types";
export { codexDirOf, configDirOf, predecessorsOf } from "./session-liveness";
export { codexThreadIdOf } from "./codex-rollout";
export { loadPersistedEvents, recordAngerJudgement, recordAskJudgement } from "./session-event-log";

export async function scanSessions(roots: RootEntry[]): Promise<ScanResult> {
  const now = Date.now();
  const found: LiveFoundEntry[] = [];
  const brokenIds: string[] = [];
  // ids of sessions whose tail was read but which were excluded from display (sdk-cli, Codex internal rollouts).
  // They aren't in found, but pruning them from tailCache would re-read them every 3 seconds, so keep them
  const skippedIds = new Set<string>();
  const nextContinuedFrom = new Map<string, string>();

  // Processes alive now. Read before walking the folders: which sessions are candidates for birds is decided from
  // them, not from how recently a transcript was written (see the NEVER_SEEN_GRACE_MS comment)
  const { sessions: liveSessions, presentConfigDirs, unreliableConfigDirs, unreadable } = await loadLiveSessions(roots);
  const liveSessionIds = new Set(liveSessions.map((l) => l.sessionId));
  const { threadIdsByCodexDir, unreliableCodexDirs } = await loadLiveCodexThreads(roots);
  const listing: RootListing = {
    now,
    found,
    skippedIds,
    nextContinuedFrom,
    liveSessionIds,
    presentConfigDirs,
    threadIdsByCodexDir,
  };

  for (const root of roots) {
    try {
      if (root.kind === "claude") await listClaudeRoot(root, listing);
      if (root.kind === "codex") await listCodexRoot(root, listing);
    } catch (e) {
      console.warn("[tomarigi] failed to scan root", root.id, e);
      brokenIds.push(root.id);
    }
  }

  scanState.continuedFrom = nextContinuedFrom;
  const endedIds = settleLiveness(
    found,
    skippedIds,
    { liveSessionIds, threadIdsByCodexDir, unreliableConfigDirs, unreliableCodexDirs },
    now,
  );
  forgetEndedRollouts(roots, threadIdsByCodexDir);
  const { displayEntries, sdkChicksByParentId } = assignSdkChicks(found, now);
  const { withTail, baseNameRoots } = displayNames(roots, found, displayEntries);
  const watch = await resolveWatchLinks(withTail, liveSessions);
  const views = buildViews(withTail, baseNameRoots, sdkChicksByParentId, watch, now);
  rememberPeerStates(views, watch, now);

  views.sort((a, b) => STATE_URGENCY[a.state] - STATE_URGENCY[b.state] || a.sinceMs - b.sinceMs);

  if (scanState.scanLogEnabled === undefined) {
    scanState.scanLogEnabled = await invoke<boolean>("scan_log_enabled").catch(() => false);
  }
  if (scanState.scanLogEnabled) logScan(views, liveSessions, unreliableConfigDirs, unreadable, endedIds);

  pruneCaches(found, skippedIds);
  const events = recentEvents(now);
  saveEventLogIfDirty();

  return { views, brokenIds, events };
}

// What one scan collects while walking the roots, and what it needs to decide the candidates
interface RootListing {
  now: number;
  found: LiveFoundEntry[];
  skippedIds: Set<string>;
  nextContinuedFrom: Map<string, string>;
  liveSessionIds: Set<string>;
  presentConfigDirs: Set<string>;
  threadIdsByCodexDir: Map<string, Set<string>>;
}

/** Lists the candidate transcripts of a Claude Code watched folder (<config>/projects) into listing.found */
async function listClaudeRoot(
  root: RootEntry,
  { now, found, skippedIds, nextContinuedFrom, liveSessionIds, presentConfigDirs }: RootListing,
): Promise<void> {
  const configDir = configDirOf(root);
  // Older Claude Code without <config>/sessions: there is no pid to check, so no birds
  if (!presentConfigDirs.has(configDir)) return;
  const firstListing = !listedRootIds.has(root.id);
  for await (const entry of root.handle.values()) {
    if (entry.kind !== "directory") continue;
    const projectDir = entry as NativeDirectoryHandle;
    for await (const child of projectDir.values()) {
      if (child.kind !== "file" || !child.name.endsWith(".jsonl")) continue;
      const file = await (child as NativeFileHandle).getFile();
      const id = `${root.id}/${projectDir.name}/${child.name}`;
      const sessionId = child.name.slice(0, -".jsonl".length);
      if (!knownTranscriptIds.has(id)) {
        knownTranscriptIds.add(id);
        if (!firstListing) transcriptAppearedAt.set(id, now);
      }
      // Candidates: the process is alive, the bird is already shown (it goes through the miss count in settleLiveness),
      // or the transcript appeared within NEVER_SEEN_GRACE_MS (the sessions file can lag behind it).
      // However long ago the transcript was written doesn't matter
      if (!liveSessionIds.has(sessionId) && !scanState.trackedIds.has(id) && !inNeverSeenGrace(id, now)) continue;
      // The completion check for chicks (subagents) treats the parent ledger (chickSignals in the parent
      // tail) as the source of truth, so read the parent's tail before scanChicks (see the isChick comment
      // in deriveState). The tail read here is reused when building withTail (displayNames) (to compute cwd/base
      // name), so it isn't read twice
      const tail = await readTailCached(id, file);
      // `claude -p` (entrypoint "sdk-cli") is out of scope for tomarigi (no birds, no events).
      // Most are started in the background by Claude Code as a command; neither child nor parent keeps the
      // other's id, so they can't be tied to a parent reliably (cwd is the launch directory too, with no
      // parent in the same directory). The launching parent's done is handled by background task
      // suppression (deriveDoneEvent). A `claude -p` typed by hand prints its result in that terminal,
      // so there is little need to watch it
      if (tail.entrypoint === "sdk-cli") {
        skippedIds.add(id);
        continue;
      }
      // Handed over to another session (TailInfo.continuedIn). The new session has its own transcript and
      // bird; the old process may stay alive, but this conversation no longer moves here
      if (tail.continuedIn) {
        nextContinuedFrom.set(tail.continuedIn, sessionIdOfViewId(id));
        skippedIds.add(id);
        continue;
      }
      const chicks = await scanChicks(projectDir, child.name, id, now, tail.chickSignals, file);
      found.push({
        agent: "claude",
        rootId: root.id,
        rootLabel: root.label,
        slug: projectDir.name,
        file,
        id,
        tail,
        chicks,
        liveKey: sessionId,
        liveDir: configDir,
      });
    }
  }
  // Only a listing that got through the whole folder counts (a failed one would make its unlisted files look
  // new on the next listing)
  listedRootIds.add(root.id);
}

/** Lists the rollouts of live (or already shown) threads of a Codex watched folder into listing.found */
async function listCodexRoot(
  root: RootEntry,
  { found, skippedIds, threadIdsByCodexDir }: RootListing,
): Promise<void> {
  const codexDir = codexDirOf(root);
  const sessionsDir = await codexSessionsDir(root.handle);
  if (!sessionsDir) return;
  // Rollouts of live threads (however old), plus birds already shown so they go through the miss count
  const rollouts = new Map<string, CodexRollout>(); // key: path
  for (const threadId of threadIdsByCodexDir.get(codexDir) ?? []) {
    const rollout = await findCodexRollout(root.id, sessionsDir, threadId);
    if (rollout) rollouts.set(rollout.path, rollout);
  }
  const prefix = `${root.id}/codex/`;
  for (const trackedId of scanState.trackedIds) {
    if (!trackedId.startsWith(prefix)) continue;
    const path = trackedId.slice(prefix.length);
    if (rollouts.has(path)) continue;
    const file = await fileAt(sessionsDir, path);
    if (file) rollouts.set(path, { file, path });
  }
  for (const { file, path } of rollouts.values()) {
    const threadId = codexThreadIdOf(file.name);
    if (!threadId) continue;
    const id = `${prefix}${path}`;
    const tail = await readCodexTailCached(id, file);
    // Internal rollouts (subagents, guardian reviews, and future non-user sources) can
    // complete repeatedly while the parent is still working. Treating them as independent
    // sessions duplicates birds and emits false done events. Older rollouts may not have
    // thread_source, so keep those for backward compatibility and reject only explicit
    // non-user sources.
    if (tail.threadSource !== undefined && tail.threadSource !== "user") {
      skippedIds.add(id);
      continue;
    }
    const cwd = tail.cwd;
    const slug = cwd ? `codex:${cwd}` : `codex:${file.name}`;
    found.push({
      agent: "codex",
      rootId: root.id,
      rootLabel: root.label,
      slug,
      file,
      id,
      tail,
      chicks: [],
      liveKey: threadId,
      liveDir: codexDir,
    });
  }
}

/** Display names of the entries shown as birds */
function displayNames(
  roots: RootEntry[],
  found: FoundEntry[],
  displayEntries: FoundEntry[],
): { withTail: (FoundEntry & { base: string; isSdk: boolean })[]; baseNameRoots: Map<string, Set<string>> } {
  // Compute the display name table per root (fallback for sessions without a cwd. Stripping the common prefix
  // of slugs only makes sense within a root). Computing from found (all entries including SDK) gives the same
  // result as displayEntries (an SDK session's slug is always shared with some displayed session), but we
  // simply use every scanned entry
  const labelsByRoot = new Map<string, Map<string, string>>();
  for (const root of roots) {
    const slugs = [...new Set(found.filter((f) => f.rootId === root.id).map((f) => f.slug))];
    labelsByRoot.set(root.id, projectLabels(slugs));
  }

  // The base name prefers cwd when available (it matches across roots, so the duplicate detection below can
  // detect the same project). The tail was already read in the loop above.
  // isSdk is used for the state branch (switching between deriveState/deriveSdkChickState in the loop below).
  // The deriveSdkChickState fix for "stuck in working when ending on a structured output tool" also needs to
  // apply to orphanSdkEntries (the adult-display fallback for SDK sessions with no parent candidate), so the
  // isSdkSession result is carried along here
  const withTail: (FoundEntry & { base: string; isSdk: boolean })[] = [];
  for (const f of displayEntries) {
    const base = f.tail.cwd
      ? basename(f.tail.cwd)
      : (labelsByRoot.get(f.rootId)?.get(f.slug) ?? f.slug);
    withTail.push({ ...f, base, isSdk: isSdkSession(f) });
  }

  // Tally which roots each display name (without the root label) appears in, and append the root label only
  // to names duplicated across different roots to tell them apart
  const baseNameRoots = new Map<string, Set<string>>();
  for (const f of withTail) {
    if (!baseNameRoots.has(f.base)) baseNameRoots.set(f.base, new Set());
    baseNameRoots.get(f.base)?.add(f.rootId);
  }
  return { withTail, baseNameRoots };
}

/** Builds the SessionView of each bird, and caches the transition events derived from its tail */
function buildViews(
  withTail: (FoundEntry & { base: string; isSdk: boolean })[],
  baseNameRoots: Map<string, Set<string>>,
  sdkChicksByParentId: Map<string, ChickScan[]>,
  watch: WatchLinks,
  now: number,
): SessionView[] {
  const views: SessionView[] = [];

  for (const { rootLabel, file, id, chicks, tail, base, slug, isSdk } of withTail) {
    const ambiguous = (baseNameRoots.get(base)?.size ?? 0) > 1;
    // The time basis for the state check is tail.lastEventAt (the last time of a line with a timestamp).
    // Later appends without a timestamp (last-prompt etc., a touch on a dead transcript hours later) only
    // advance file.lastModified, so using mtime as the basis makes ended sessions reappear (see the comment on
    // TailInfo.lastEventAt). Falls back to mtime only in the rare case where the tail window has no line with a timestamp
    const sinceMs = now - (tail.lastEventAt ?? file.lastModified);
    const project = ambiguous ? `${base} (${rootLabel})` : base;
    // Subagent chicks (from scanChicks) and SDK chicks (those for which this session was chosen as parent
    // candidate) are carried as separate lists and used differently depending on the destination.
    // - subagentChickViews (without SDK): passed only to deriveSessionEvents (done suppression check).
    //   SDK chicks are not children the parent started but unrelated processes running alongside, so an SDK
    //   chick merely running must not trigger the parent's done suppression (see the deriveDoneEvent comment;
    //   the suppression premise "a child the parent started" doesn't hold for SDK chicks).
    // - chickViews (merged with SDK): passed with SDK chicks included, as before, to escalateWithChicks
    //   (display escalation) and SessionView.chicks (display). Excluding them from escalation would show the
    //   parent dozing while its SDK chick is running, a regression compared to before they became chicks (when
    //   they were visible as adult birds), so they are deliberately kept on the display side.
    const subagentChickViews = chicks.map((c) => c.view);
    const sdkChickViews = (sdkChicksByParentId.get(id) ?? []).map((c) => c.view);
    const chickViews = [...subagentChickViews, ...sdkChickViews].sort(
      (a, b) => a.sinceMs - b.sinceMs,
    );
    // Listed under the parent: chicks whose completion the parent hasn't recorded yet
    const completedChickIds = new Set(chicks.filter((c) => c.completed).map((c) => c.view.id));
    const shownChickViews = chickViews.filter((c) => !completedChickIds.has(c.id));
    // deriveState is the only source for the "appearance (bird)". However, SDK orphans (SDK sessions with no
    // parent candidate that fell back to adult display, isSdk===true) use deriveSdkChickState —
    // the problem of getting stuck in working when ending on a structured output tool (tool_result) is still
    // unfixed in deriveState (see the deriveSdkChickState comment)
    const tailState = isSdk ? deriveSdkChickState(tail, sinceMs) : deriveState(tail, sinceMs, false);
    // While Claude Code shows choices (AskUserQuestion) or a permission prompt, it doesn't write that tool_use
    // to the transcript yet (it writes it after the answer). Instead the status in <config>/sessions/<pid>.json
    // becomes "waiting", so treat that as needs reply
    const state: BirdState =
      !isSdk && watch.liveBySessionId.get(sessionIdOfViewId(id))?.status === "waiting" ? "waiting" : tailState;
    // The display state is escalated to a chick's urgency while the chick is running (anything but done/dozing)
    const displayState = escalateWithChicks(state, chickViews);
    // Always attach the latest user message snippet ("what this session was asked to do" is the main info).
    // If there is no message in the window, use the last remembered snippet instead
    const snippet = pickSnippet(tail) ?? snippetCache.get(id);
    if (snippet) snippetCache.set(id, snippet);
    const peers = watch.peerLinksOf(sessionIdOfViewId(id));
    const watching = watchingCount(displayState, peers, now);
    const last = tail.events[tail.events.length - 1];
    const reply =
      (displayState === "done" || displayState === "dozing") &&
      last?.kind === "assistant_text" &&
      last.text
        ? { at: last.at, text: last.text }
        : undefined;
    const question =
      displayState === "waiting" && last?.kind === "tool_use" ? extractQuestion(last.text) : undefined;
    rememberUserMessage(id, lastUserMessage(tail.events));
    const userMessage = userMessageCache.get(id);
    views.push({
      id,
      project,
      slug,
      state: displayState,
      sinceMs,
      toolName: tail.kind === "tool_use" ? tail.toolName : undefined,
      chicks: shownChickViews.length > 0 ? shownChickViews : undefined,
      snippet,
      reply,
      question,
      userMessage,
      peers: peers.length > 0 ? peers : undefined,
      watching,
      cwd: tail.cwd,
      startedAt: watch.liveBySessionId.get(sessionIdOfViewId(id))?.startedAt,
    });
    // Only done also looks at the chicks' (subagents') status: while a chick is running it is still too early
    // as a "come back" signal. SDK chicks are not included here (see the comment above)
    const backgroundTasks = updateBackgroundTasks(id, tail);
    // A watching session's done is not emitted until all linked peers have stopped. Peers are passed to the
    // deriveDoneEvent suppression the same way as chicks (active peers as running chicks, stopped peers with
    // their last write time)
    const peerChicks: ChickView[] = peers.flatMap((p) => {
      const lastState = lastPeerStates.get(p.sessionId);
      if (p.active) return [{ id: `peer:${p.sessionId}`, name: p.name, state: "working" as const, sinceMs: 0 }];
      if (!lastState) return [];
      return [{ id: `peer:${p.sessionId}`, name: p.name, state: lastState.state, sinceMs: now - lastState.lastWriteAt }];
    });
    for (const event of deriveSessionEvents(
      tail,
      id,
      project,
      [...subagentChickViews, ...peerChicks],
      backgroundTasks,
      snippet,
      now,
    )) {
      cacheEvent(event);
    }
  }
  return views;
}
