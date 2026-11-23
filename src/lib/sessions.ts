// Scans the watched folders for sessions (birds), their chicks, and their transition events. The steps live in
// the session-*.ts modules; the state kept across scans is in lib/session-store.ts
import type { RootEntry } from "./settings-store";
import { askSentToParent, peerHoldChicks, peersWatchedBy, silentForParent, takenOverByParent, takenOverWorld, watchingCount } from "./watching";
import { basename } from "./paths";
import { lastWrittenAt, projectLabels } from "./transcript";
import { pendingProposalsOf } from "./transcript-desktop";
import { unstartedProposals } from "./proposals";
import type {
  ChickScan,
  FoundEntry,
  LiveFoundEntry,
  LiveSession,
  ScanResult,
  SessionView,
} from "./session-types";
import { lastPeerStates, pruneCaches, scanState, snippetCache } from "./session-store";
import { sessionIdOfViewId, settleLiveness } from "./session-liveness";
import { feedTurnMessages, turnUserMessages } from "./session-tail";
import { assignSdkChicks, chickListsOf, isSdkSession } from "./session-chicks";
import { AGENTS, type AgentKind, type ScanListing } from "./agents";
import { loadAgentProcesses, type AgentProcessScan } from "./agent-processes";
import { birdStateOf, STATE_URGENCY } from "./bird-state";
import { pickSnippet } from "./session-snippet";
import { deriveSessionEvents, updateBackgroundTasks } from "./session-events";
import { rootsWithFreshUnlinkedChild, unwakeableForMsOf, updateWakes, wakeSourceOf } from "./session-wake";
import { cacheEvent, recentEvents, saveEventLogIfDirty } from "./session-event-log";
import { rememberPeerStates, resolveWatchLinks, type WatchLinks } from "./session-watch";
import { displayNamesOf, type DisplayName } from "./display-names";

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
  const withTail = baseNames(roots, found, displayEntries);
  const watch = await resolveWatchLinks(withTail, liveSessions);
  const names = displayNamesOf(
    withTail.map((f) => {
      const live = f.isSdk ? undefined : watch.liveBySessionId.get(sessionIdOfViewId(f.id));
      return {
        id: f.id,
        base: f.base,
        rootId: f.rootId,
        rootLabel: f.rootLabel,
        // Only a name the user gave (Claude Code's /rename or --name). The one Claude Code makes up itself is the
        // project's name with a random suffix (e.g. 「app-p-cc」), which says nothing about the session
        // (Claude's own decision, docs/design.md "Display names")
        sessionName: live?.nameSource === "user" ? live.name : undefined,
        startedAt: live?.startedAt,
      };
    }),
  );
  const views = buildViews(withTail, names, sdkChicksByParentId, watch, now);
  rememberPeerStates(views, watch, now);

  views.sort((a, b) => STATE_URGENCY[a.state] - STATE_URGENCY[b.state] || a.sinceMs - b.sinceMs);

  pruneCaches(found, skippedIds);
  const events = recentEvents(now);
  saveEventLogIfDirty();

  return { views, brokenIds, events };
}

/** Base names of the entries shown as birds (the project's name, before sessions with the same one are told apart) */
function baseNames(
  roots: RootEntry[],
  found: FoundEntry[],
  displayEntries: FoundEntry[],
): (FoundEntry & { base: string; isSdk: boolean })[] {
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
  return withTail;
}

/** Builds the SessionView of each bird, and caches the transition events derived from its tail */
function buildViews(
  withTail: (FoundEntry & { base: string; isSdk: boolean })[],
  names: Map<string, DisplayName>,
  sdkChicksByParentId: Map<string, ChickScan[]>,
  watch: WatchLinks,
  now: number,
): SessionView[] {
  const views: SessionView[] = [];
  // Which sessions a parent takes over (docs/design.md "Watching", "Sessions started by another session")
  const linkWorld = takenOverWorld(watch);
  // Where a child started by another session isn't linked to anyone yet (docs/design.md "Turn verdicts")
  const freshChildRoots = rootsWithFreshUnlinkedChild(
    withTail
      .filter((f) => f.agent === "claude" && !f.isSdk)
      .map((f) => {
        const sessionId = sessionIdOfViewId(f.id);
        return {
          rootId: f.rootId,
          sessionId,
          startedBySession: watch.childOf(f.id),
          linked: watch.peerLinksOf(sessionId).length > 0,
          startedAt: watch.liveBySessionId.get(sessionId)?.startedAt,
        };
      }),
    now,
  );

  for (const { file, id, chicks, tail, base, slug, isSdk, agent, rootId } of withTail) {
    // The time basis for the state check is tail.lastEventAt (the last time of a line with a timestamp).
    // Later appends without a timestamp (last-prompt etc., a touch on a dead transcript hours later) only
    // advance file.lastModified, so using mtime as the basis makes ended sessions reappear (see the comment on
    // TailInfo.lastEventAt). Falls back to mtime only in the rare case where the tail window has no line with a timestamp
    const writtenAt = lastWrittenAt(tail, file.lastModified);
    const sinceMs = now - writtenAt;
    const project = names.get(id)?.name ?? base;
    const projectSuffix = names.get(id)?.suffix;
    const { subagentChickViews, chickViews, completedChickIds, shownChickViews } = chickListsOf(
      chicks,
      sdkChicksByParentId.get(id) ?? [],
    );
    // While Claude Code shows choices (AskUserQuestion) or a permission prompt, it doesn't write that tool_use
    // to the transcript yet (it writes it after the answer). Instead the status in <config>/sessions/<pid>.json
    // becomes "waiting", so treat that as needs reply
    const live = isSdk ? undefined : watch.liveBySessionId.get(sessionIdOfViewId(id));
    const peers = watch.peerLinksOf(sessionIdOfViewId(id));
    const cards = isSdk ? [] : unstartedProposals(pendingProposalsOf(tail.events), id, watch.startedCards);
    const { wait, displayState } = birdStateOf({ tail, sinceMs, isSdk, live, cards, chickViews });
    const waitingOn = wait?.waitingOn;
    const wrapUpAsk = wait?.source === "wrap_up_ask";
    const snippet = pickSnippet(tail) ?? snippetCache.get(id);
    if (snippet) snippetCache.set(id, snippet);
    // Its own turn ended at its last write (the basis of sinceMs), so the grace period ends once it finished a turn after the
    // linked sessions last wrote (docs/design.md "Watching")
    const watched = peersWatchedBy(sessionIdOfViewId(id), peers, linkWorld);
    const watching = watchingCount(displayState, watched, now, writtenAt);
    const takenOver = takenOverByParent(sessionIdOfViewId(id), linkWorld);
    const sentToParent = takenOver && askSentToParent(sessionIdOfViewId(id), tail.lastTurnSentTo, linkWorld);
    const last = tail.events[tail.events.length - 1];
    const reply =
      (displayState === "done" || displayState === "dozing") &&
      last?.kind === "assistant_text" &&
      last.text
        ? { at: last.at, text: last.text }
        : undefined;
    // The question tool's question, the desktop app's wrap_up's ask, or the titles of the cards not started
    const question = displayState === "waiting" ? wait?.question : undefined;
    feedTurnMessages(id, tail.events);
    // The messages of the stopped turn go with its turn verdict (docs/design.md "Turn verdicts")
    const userMessages = reply ? turnUserMessages(id, reply.at) : undefined;
    const backgroundTasks = updateBackgroundTasks(id, tail);
    const wakes = updateWakes(id, tail);
    // Only Claude Code's own sessions: a Codex session's wakes aren't read, and an SDK session is run by its caller
    const wakeable =
      agent === "claude" && !isSdk
        ? wakeSourceOf({
            backgroundTasks,
            wakes,
            // Not SDK chicks: they are processes running alongside, not work the session started (see subagentChickViews)
            chicks: subagentChickViews.filter((c) => !completedChickIds.has(c.id)),
            freshUnlinkedChild: freshChildRoots.has(rootId),
            now,
          })
        : undefined;
    const unwakeableForMs = wakeable === undefined ? undefined : unwakeableForMsOf(id, wakeable, writtenAt, now);
    views.push({
      id,
      project,
      ...(projectSuffix && { projectSuffix }),
      ...(project !== base && { projectBase: base }),
      slug,
      state: displayState,
      sinceMs,
      toolName: tail.kind === "tool_use" ? tail.toolName : undefined,
      chicks: shownChickViews.length > 0 ? shownChickViews : undefined,
      snippet,
      reply,
      question,
      ...(waitingOn && { waitingOn }),
      ...(wrapUpAsk && { wrapUpAsk: true as const }),
      userMessages,
      peers: peers.length > 0 ? peers : undefined,
      watching,
      ...(takenOver && { parentTakesOver: true as const }),
      ...(sentToParent && { askSentToParent: true as const }),
      ...(watch.childOf(id) && { child: true as const }),
      cwd: tail.cwd,
      startedAt: watch.liveBySessionId.get(sessionIdOfViewId(id))?.startedAt,
      ...(unwakeableForMs !== undefined && { unwakeableForMs }),
    });
    // Only done also looks at the chicks' (subagents') status: while a chick is running it is still too early
    // as a "come back" signal. SDK chicks are not included here (see the comment above)
    const peerChicks = peerHoldChicks(watched, (sessionId) => lastPeerStates.get(sessionId), now);
    for (const event of deriveSessionEvents(
      tail,
      id,
      project,
      [...subagentChickViews, ...peerChicks],
      backgroundTasks,
      snippet,
      now,
    )) {
      // The parent takes its result and its wrap_up's ask, so those aren't read aloud on their own (a question tool is;
      // a permission prompt makes no event)
      // (silentForParent in lib/watching.ts; docs/design.md "Watching")
      cacheEvent(silentForParent(event, takenOver));
    }
  }
  return views;
}
