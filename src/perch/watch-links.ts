import type { SessionView } from "@/lib/sessions";

/**
 * Perch ordering. Among birds linked by watching, the one started first (smaller startedAt; if absent,
 * the earlier in the list) becomes the parent, and the others are placed right after it. Only one level of
 * parent (a peer's peer goes under the same parent)
 */
export function orderByWatchLinks(sessions: SessionView[]): {
  ordered: SessionView[];
  parentOf: Map<string, SessionView>;
} {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rank = new Map(sessions.map((s, i) => [s.id, i]));
  const earlier = (a: SessionView, b: SessionView) =>
    (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
  // For each connected component, the bird started first becomes the parent
  const rootOf = new Map<string, SessionView>();
  for (const start of sessions) {
    if (rootOf.has(start.id) || !start.peers?.some((p) => p.viewId && byId.has(p.viewId))) continue;
    const component: SessionView[] = [];
    const queue = [start];
    const seen = new Set([start.id]);
    while (queue.length > 0) {
      const current = queue.shift() as SessionView;
      component.push(current);
      for (const peer of current.peers ?? []) {
        const next = peer.viewId ? byId.get(peer.viewId) : undefined;
        if (next && !seen.has(next.id)) {
          seen.add(next.id);
          queue.push(next);
        }
      }
    }
    const root = [...component].sort(earlier)[0];
    for (const member of component) rootOf.set(member.id, root);
  }
  const parentOf = new Map<string, SessionView>();
  for (const [id, root] of rootOf) if (root.id !== id) parentOf.set(id, root);
  const ordered: SessionView[] = [];
  for (const s of sessions) {
    if (parentOf.has(s.id)) continue;
    ordered.push(s);
    for (const child of sessions) if (parentOf.get(child.id)?.id === s.id) ordered.push(child);
  }
  return { ordered, parentOf };
}

/**
 * Name of a peer listed under a watching parent. Not shown if it is in the same folder as the parent
 * (undefined; the same in garden blocks). If under the parent, the path relative to the parent's working
 * folder; otherwise the folder name (display name)
 */
export function relativeLabel(parent: SessionView, child: SessionView): string | undefined {
  const base = parent.cwd?.replace(/\/+$/, "");
  const own = child.cwd?.replace(/\/+$/, "");
  if (base && own === base) return undefined;
  if (base && own?.startsWith(`${base}/`)) return own.slice(base.length + 1);
  return child.project;
}
