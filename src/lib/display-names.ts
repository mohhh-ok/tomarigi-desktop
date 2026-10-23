// Display names of the sessions on screen (docs/design.md "Display names")

export interface NameCandidate {
  id: string;
  /** The project's name (the cwd's folder, or the slug's label) */
  base: string;
  rootId: string;
  rootLabel: string;
  /** The session's own name from the agent, when the user or the agent gave it one */
  sessionName?: string;
  /** When the session started (epoch ms), for numbering sessions whose names are still the same */
  startedAt?: number;
}

export interface DisplayName {
  name: string;
  /** The end of the name that tells it apart from another session's (the folder's label, the rest of a session name
   * that starts with the project's name, the number), kept visible when the name is cut to fit */
  suffix?: string;
}

const countsOf = (names: Iterable<string>) => {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
};

/**
 * The display name of each session, by id. A project in more than one agent folder gets the folder's label; sessions
 * that would still show the same name show their own session name when they have one, and the ones still the same
 * after that are numbered in the order they started, the first keeping the plain name
 */
export function displayNamesOf(entries: NameCandidate[]): Map<string, DisplayName> {
  const rootsByBase = new Map<string, Set<string>>();
  for (const e of entries) {
    if (!rootsByBase.has(e.base)) rootsByBase.set(e.base, new Set());
    rootsByBase.get(e.base)?.add(e.rootId);
  }
  const labeled = new Map(
    entries.map((e) => [e.id, (rootsByBase.get(e.base)?.size ?? 0) > 1 ? `${e.base} (${e.rootLabel})` : e.base]),
  );
  const labeledCounts = countsOf(labeled.values());
  const names = new Map<string, string>();
  for (const e of entries) {
    const name = labeled.get(e.id) ?? e.base;
    const own = e.sessionName?.trim();
    const useOwn = (labeledCounts.get(name) ?? 0) > 1 && own && own !== e.base && own !== name;
    names.set(e.id, useOwn ? own : name);
  }

  // Number the ones still the same. Sessions without a start time go after those with one, then by id, so the
  // numbers stay the same from one scan to the next; a number already taken by another name on screen is skipped
  const taken = new Set(names.values());
  const numberedFrom = new Map<string, string>();
  const byName = new Map<string, NameCandidate[]>();
  for (const e of entries) {
    const name = names.get(e.id) ?? e.base;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name)?.push(e);
  }
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    group.sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let n = 1;
    for (const e of group.slice(1)) {
      do n += 1;
      while (taken.has(`${name} ${n}`));
      taken.add(`${name} ${n}`);
      names.set(e.id, `${name} ${n}`);
      numberedFrom.set(e.id, name);
    }
  }

  const result = new Map<string, DisplayName>();
  for (const e of entries) {
    const name = names.get(e.id) ?? e.base;
    const head = name !== e.base && name.startsWith(e.base) ? e.base : numberedFrom.get(e.id);
    result.set(e.id, head === undefined ? { name } : { name, suffix: name.slice(head.length) });
  }
  return result;
}
