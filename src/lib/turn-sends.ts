// What each of a session's turns sent to other sessions, kept across scans (docs/design/watching.md "Sessions started by another
// session"). The question a reply asks reaches the parent only when the reply's own turn sent it a message, so the sends
// are looked up by the turn the reply belongs to, not the latest turn: the parent's answer can start a new turn right
// after the reply. A long turn's prompt falls out of the tail window, so the ledger is fed by the whole-file read
// (scan_peer_names in src-tauri) as well as by the tail window. Doesn't depend on UI components or Tauri

/** One turn in the ledger. startAt is the time of the prompt that started it; -Infinity for a turn whose start wasn't
 * read (the sends read before any start the ledger knows) */
export interface TurnSends {
  startAt: number;
  sentTo: Set<string>;
}

/** What one read of a transcript says of its turns' sends, in the names the messages give (peerNames) */
export interface TurnSendsRead {
  /** Each prompt that starts a turn in the part read, in order, with the sessions messaged after it in that part */
  turns: { startAt: number; sentTo: string[] }[];
  /** The sessions messaged in the part read before its first turn start: they belong to the turn that ran then */
  sentBefore: string[];
}

// A reply is the session's last event, and a prompt or two may come after it before the session writes again. Only the
// last few turns matter, so the ledger stays small however long the session runs (Claude's own decision)
export const TURN_SENDS_KEPT = 8;

/**
 * Adds one read to a session's ledger. replace: the read covers the whole file (from the top), so it stands for all the
 * turns. Reads overlap (the tail window is read again every scan), so a turn already in the ledger only gains names
 */
export function rememberTurnSends(
  ledgers: Map<string, TurnSends[]>,
  viewId: string,
  read: TurnSendsRead,
  opts?: { replace?: boolean },
): void {
  const ledger = opts?.replace ? [] : (ledgers.get(viewId) ?? []);
  if (read.sentBefore.length > 0) {
    const firstStart = read.turns[0]?.startAt ?? Infinity;
    let before = ledger.findLast((t) => t.startAt < firstStart);
    if (!before) {
      before = { startAt: -Infinity, sentTo: new Set() };
      ledger.unshift(before);
    }
    for (const name of read.sentBefore) before.sentTo.add(name);
  }
  for (const turn of read.turns) {
    let known = ledger.find((t) => t.startAt === turn.startAt);
    if (!known) {
      known = { startAt: turn.startAt, sentTo: new Set() };
      const i = ledger.findIndex((t) => t.startAt > turn.startAt);
      ledger.splice(i === -1 ? ledger.length : i, 0, known);
    }
    for (const name of turn.sentTo) known.sentTo.add(name);
  }
  if (ledger.length > TURN_SENDS_KEPT) ledger.splice(0, ledger.length - TURN_SENDS_KEPT);
  if (ledger.length === 0) ledgers.delete(viewId);
  else ledgers.set(viewId, ledger);
}

/** The sessions messaged in the turn that was running at `at` (the last turn that started at or before it); undefined
 * when the ledger has none */
export function turnSentToAt(ledger: readonly TurnSends[] | undefined, at: number | undefined): string[] | undefined {
  if (!ledger || at === undefined) return undefined;
  const turn = ledger.findLast((t) => t.startAt <= at);
  return turn ? [...turn.sentTo] : undefined;
}

/** What scan_peer_names in src-tauri returns of the turns' sends: the times as the transcript writes them */
export interface TurnSendsScan {
  turnSends?: { startAt: string; sentTo: string[] }[] | null;
  sentBeforeTurn?: string[] | null;
}

/** A scan's sends as a read of the ledger; a turn whose time doesn't parse is left out, its sends with it */
export function turnSendsOfScan(scan: TurnSendsScan): TurnSendsRead {
  const turns = (scan.turnSends ?? []).flatMap((t) => {
    const startAt = Date.parse(t.startAt);
    return Number.isFinite(startAt) ? [{ startAt, sentTo: t.sentTo }] : [];
  });
  return { turns, sentBefore: scan.sentBeforeTurn ?? [] };
}
