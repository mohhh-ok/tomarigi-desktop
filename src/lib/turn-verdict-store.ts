// The turn verdicts already answered, kept in the settings store so that a reload or a restart doesn't ask about the
// same turn again (docs/design.md "Turn verdicts": one verdict per turn, the first answer is the one used)
import { kvGet, kvPut } from "./settings-store";
import type { TurnOutcome } from "./summarize";

/** How many turns' verdicts are kept, the oldest dropped first (more than the turns on screen at once) */
export const MAX_KEPT_TURN_VERDICTS = 200;

const KEY_TURN_VERDICTS = "turnVerdicts";

/** Turn key (turnKey in perch/use-turn-judgements.ts) and its verdict, oldest first */
export type KeptTurnVerdicts = [string, TurnOutcome][];

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
