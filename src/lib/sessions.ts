// Scans the watched folders for sessions (birds), their chicks, and their transition events. The steps live in
// the session-*.ts modules; the state kept across scans is in lib/session-store.ts
import type { RootEntry } from "./settings-store";
import { watchingCount } from "./watching";
import { basename } from "./paths";
import { projectLabels } from "./transcript";
import type {
  BirdState,
  ChickScan,
  ChickView,
  FoundEntry,
  LiveFoundEntry,
  LiveSession,
  ScanResult,
  SessionView,
} from "./session-types";
import { lastPeerStates, pruneCaches, scanState, snippetCache } from "./session-store";
import { sessionIdOfViewId, settleLiveness } from "./session-liveness";
import { feedTurnMessages, turnUserMessages } from "./session-tail";
import { assignSdkChicks, isSdkSession } from "./session-chicks";
import { AGENTS, type AgentKind, type ScanListing } from "./agents";
import { loadAgentProcesses, type AgentProcessScan } from "./agent-processes";
import { deriveSdkChickState, deriveState, escalateWithChicks, STATE_URGENCY, waitingOnOf } from "./bird-state";
import { extractQuestion, pickSnippet } from "./session-snippet";
import { deriveSessionEvents, updateBackgroundTasks } from "./session-events";
import { cacheEvent, recentEvents, saveEventLogIfDirty } from "./session-event-log";
import { rememberPeerStates, resolveWatchLinks, type WatchLinks } from "./session-watch";

export type { AskJudgement, BirdState, ChickView, PeerLink, ScanResult, SessionEvent, SessionView } from "./session-types";
export { codexDirOf, configDirOf, predecessorsOf } from "./session-liveness";
export { codexThreadIdOf } from "./codex-rollout";
export { jumpPidOf } from "./session-liveness";
export { loadPersistedEvents, recordTurnVerdict } from "./session-event-log";

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
  const liveSessions: LiveSession[] = [];
  let processScan: Promise<{ byKind: Map<AgentKind, AgentProcessScan["processes"]>; reliable: boolean }> | undefined;
  const listing: ScanListing = {
    now,
    found,
    skippedIds,
    nextContinuedFrom,
    liveSessions,
    async processes(kind) {
      processScan ??= loadAgentProcesses(
        new Map(
          AGENTS.flatMap((a) =>
            a.matchesProcess && roots.some((r) => r.kind === a.kind) ? [[a.kind, a.matchesProcess] as const] : [],
          ),
        ),
      );
      const { byKind, reliable } = await processScan;
      return { processes: byKind.get(kind) ?? [], reliable };
    },
  };
  const adapters = AGENTS.map((agent) => ({ agent, roots: roots.filter((r) => r.kind === agent.kind) })).filter(
    (a) => a.roots.length > 0,
  );
  const prepared = new Map(
    await Promise.all(adapters.map(async ({ agent, roots }) => [agent.kind, await agent.prepare?.(roots, listing)] as const)),
  );

  for (const root of roots) {
    const agent = AGENTS.find((a) => a.kind === root.kind);
    if (!agent) continue;
    try {
      await agent.list(root, listing, prepared.get(agent.kind));
    } catch (e) {
      console.warn("[tomarigi] failed to scan root", root.id, e);
      brokenIds.push(root.id);
    }
  }

  scanState.continuedFrom = nextContinuedFrom;
  settleLiveness(found, skippedIds, now);
  for (const { agent, roots } of adapters) agent.finish?.(roots, prepared.get(agent.kind));
  scanState.jumpPids = new Map(found.flatMap((f) => (f.pid === undefined ? [] : [[f.id, f.pid] as const])));
  const { displayEntries, sdkChicksByParentId } = assignSdkChicks(found, now);
  const { withTail, baseNameRoots } = displayNames(roots, found, displayEntries);
  const watch = await resolveWatchLinks(withTail, liveSessions);
  const views = buildViews(withTail, baseNameRoots, sdkChicksByParentId, watch, now);
  rememberPeerStates(views, watch, now);

  views.sort((a, b) => STATE_URGENCY[a.state] - STATE_URGENCY[b.state] || a.sinceMs - b.sinceMs);

  pruneCaches(found, skippedIds);
  const events = recentEvents(now);
  saveEventLogIfDirty();

  return { views, brokenIds, events };
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
    const live = isSdk ? undefined : watch.liveBySessionId.get(sessionIdOfViewId(id));
    const state: BirdState = live?.status === "waiting" ? "waiting" : tailState;
    const waitingOn = state === "waiting" ? waitingOnOf(tailState === "waiting", live?.waitingFor) : undefined;
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
    feedTurnMessages(id, tail.events);
    // The messages of the stopped turn go with its turn verdict (docs/design.md "Turn verdicts")
    const userMessages = reply ? turnUserMessages(id, reply.at) : undefined;
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
      ...(waitingOn && { waitingOn }),
      userMessages,
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
