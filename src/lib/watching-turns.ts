// Who started a session's latest turn and whose messages arrived during it, as watching reads it (docs/design.md
// "Watching"). Doesn't depend on UI components or Tauri
import type { LiveSession } from "./session-types";

/** The session a message from another session came from, as its transcript line names it (PeerRef in src-tauri):
 * `origin.name`, `origin.verifiedPeerPid`, `origin.from` (`uds:/tmp/cc-socks/<pid>.sock` or a desktop app `local_…` id) */
export interface PeerRef {
  name?: string;
  pid?: number;
  from?: string;
}

/** Who started a turn (TurnStarter in src-tauri): a typed prompt, another session's message, or anything else (the
 * desktop app's own turns, whose send_message leaves no sender, task notifications, ...) */
export type TurnStarter = { kind: "typed" } | ({ kind: "peer" } & PeerRef) | { kind: "other" };

/** A session's latest turn after its first prompt: who started it (undefined while only the first prompt has come) and
 * the sessions whose messages arrived while it ran */
export interface LatestTurn {
  starter?: TurnStarter;
  peers: PeerRef[];
}

/** What one read of a transcript (scan_peer_names in src-tauri) says of its latest turn */
export interface TurnRead {
  /** Where the read started: 0 when it read from the top (also when the file had shrunk below the position asked for) */
  start: number;
  lastTurnStarter?: TurnStarter | null;
  turnPeers?: PeerRef[] | null;
  /** The part read has a prompt that starts a turn, so turnPeers are all of the latest turn's. A prompt the user typed
   * while it worked sets lastTurnStarter without it: the senders that arrived earlier in that turn stay */
  turnStarted?: boolean;
}

const samePeer = (a: PeerRef, b: PeerRef) => a.name === b.name && a.pid === b.pid && a.from === b.from;

function uniquePeers(peers: readonly PeerRef[]): PeerRef[] {
  return peers.filter((p, i) => peers.findIndex((q) => samePeer(p, q)) === i);
}

/**
 * Records, after one read of a session's transcript (scan_peer_names in src-tauri), its latest turn: a read from the
 * top replaces it; a later read with a new turn replaces it, and one without adds the senders that arrived meanwhile
 * (its starter, if any, is a prompt the user typed while it worked)
 */
export function rememberLatestTurn(turns: Map<string, LatestTurn>, viewId: string, read: TurnRead): void {
  const fromTop = read.start === 0;
  const peers = read.turnPeers ?? [];
  const previous = fromTop ? undefined : turns.get(viewId);
  const replace = fromTop || read.turnStarted === true;
  const turn: LatestTurn = {
    starter: read.lastTurnStarter ?? previous?.starter,
    peers: uniquePeers(replace ? peers : [...(previous?.peers ?? []), ...peers]),
  };
  if (turn.starter === undefined) delete turn.starter;
  if (!turn.starter && turn.peers.length === 0) turns.delete(viewId);
  else turns.set(viewId, turn);
}

/** The pid in a Claude Code messaging socket path, `…/<pid>.sock` */
function pidOfSocket(from: string | undefined): number | undefined {
  const m = from?.match(/\/(\d+)\.sock$/);
  return m ? Number(m[1]) : undefined;
}

/**
 * Whether a message came from the session own: by the sender's pid (`verifiedPeerPid`, else the pid in its socket
 * path) against own's pid in sessions/<pid>.json, and by its name or desktop app id (peerLookup). Own's pid changes
 * when it is resumed, so a pid that differs still counts as own's when the name or id names own. "unknown" when
 * neither tells (docs/design.md "Watching")
 */
export function turnStarterSession(
  ref: PeerRef,
  own: { sessionId: string; pid?: number },
  lookup: (trace: string) => LiveSession | undefined,
): "self" | "other" | "unknown" {
  const pid = ref.pid ?? pidOfSocket(ref.from);
  const pidKnown = pid !== undefined && own.pid !== undefined;
  if (pidKnown && pid === own.pid) return "self";
  const live = (ref.from !== undefined ? lookup(ref.from) : undefined) ?? (ref.name !== undefined ? lookup(ref.name) : undefined);
  if (live) return live.sessionId === own.sessionId ? "self" : "other";
  return pidKnown ? "other" : "unknown";
}

/** Who started a session's latest turn, as seen from own (latestTurnBy in LinkWorld) */
export type TurnBy = "self" | "typed" | "other" | "unknown";

/**
 * Who started peer's latest turn as seen from own: "self" when own's message started it or arrived during it, "typed"
 * for the user's input, "other" for a third session's message, "unknown" when it isn't known who; undefined while peer
 * has only its first prompt
 */
export function latestTurnBy(
  turn: LatestTurn | undefined,
  own: { sessionId: string; pid?: number },
  lookup: (trace: string) => LiveSession | undefined,
): TurnBy | undefined {
  if (!turn) return undefined;
  if (turn.peers.some((p) => turnStarterSession(p, own, lookup) === "self")) return "self";
  const starter = turn.starter;
  if (!starter) return undefined;
  if (starter.kind === "typed") return "typed";
  if (starter.kind === "other") return "unknown";
  return turnStarterSession(starter, own, lookup);
}
