// The turn verdicts already answered, kept in the settings store so that a reload or a restart doesn't ask about the
// same turn again (docs/design.md "Turn verdicts": one verdict per turn, the first answer is the one used)
import { kvGet, kvPut } from "./settings-store";
import type { TurnOutcome } from "./summarize";

/** How many turns' verdicts are kept, the oldest dropped first (more than the turns on screen at once) */
export const MAX_KEPT_TURN_VERDICTS = 200;

const KEY_TURN_VERDICTS = "turnVerdicts";

/** Identifies a turn for the turn verdict. Same basis as the done event key (sessionId + time of the last response) */
export function turnKey(sessionId: string, at: number): string {
  return `${sessionId}:${at}`;
}

/** Turn key (turnKey) and its verdict, oldest first */
export type KeptTurnVerdicts = [string, TurnOutcome][];

/** Whether a session's bird has the anger mark, from the verdict of the turn whose last reply was at `at` */
export type Anger = { at: number; angry: boolean };

/**
 * The anger mark from a session's kept verdicts: abusive of its latest turn (by reply time) whose verdict has it. A kept
 * turn isn't asked again, so after a reload or a restart the mark comes from here, and it stays until the next turn's
 * verdict (docs/design.md "Anger mark for abuse toward the AI")
 */
export function keptAnger(list: Iterable<[string, TurnOutcome]>, sessionId: string): Anger | undefined {
  const prefix = `${sessionId}:`;
  let latest: Anger | undefined;
  for (const [key, outcome] of list) {
    if (!key.startsWith(prefix) || outcome.abusive === undefined) continue;
    const rest = key.slice(prefix.length);
    const at = Number(rest);
    if (rest === "" || !Number.isFinite(at)) continue;
    if (!latest || at > latest.at) latest = { at, angry: outcome.abusive };
  }
  return latest;
}

/** The anger of the newer turn */
export function newerAnger(a: Anger | undefined, b: Anger | undefined): Anger | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

/** The list with key's verdict added last. A key already kept keeps its first verdict */
export function keepTurnVerdict(list: KeptTurnVerdicts, key: string, outcome: TurnOutcome): KeptTurnVerdicts {
  if (list.some(([k]) => k === key)) return list;
  return [...list, [key, outcome] as [string, TurnOutcome]].slice(-MAX_KEPT_TURN_VERDICTS);
}

const isOutcome = (v: unknown): v is TurnOutcome => {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const ask = o.ask as { status?: unknown } | undefined;
  return (
    (ask?.status === "asking" || ask?.status === "not_asking") &&
    (o.line === undefined || typeof o.line === "string") &&
    (o.abusive === undefined || typeof o.abusive === "boolean") &&
    (o.continuing === undefined || typeof o.continuing === "boolean")
  );
};

/** The kept list as saved, without entries that aren't a turn key and an answered verdict (an older or broken value) */
export function parseKeptTurnVerdicts(saved: unknown): KeptTurnVerdicts {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((e): e is [string, TurnOutcome] => Array.isArray(e) && typeof e[0] === "string" && isOutcome(e[1]))
    .slice(-MAX_KEPT_TURN_VERDICTS);
}

export async function loadTurnVerdicts(): Promise<KeptTurnVerdicts> {
  return parseKeptTurnVerdicts(await kvGet(KEY_TURN_VERDICTS));
}

export async function saveTurnVerdicts(list: KeptTurnVerdicts): Promise<void> {
  await kvPut(KEY_TURN_VERDICTS, list);
}

/**
 * Whether to ask about a turn now: a summary provider is set up, its request hasn't started, the kept answers are
 * loaded (kept null until then), and the turn has no kept answer
 */
export function shouldAskTurn(
  key: string,
  setUp: boolean,
  requested: ReadonlySet<string>,
  kept: KeptTurnVerdicts | null,
): boolean {
  return setUp && !requested.has(key) && kept !== null && !kept.some(([k]) => k === key);
}
