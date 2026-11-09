// What the voice reads while the Concierge tab is open (docs/design.md "Concierge", "Readout in the Concierge tab"):
// only the concierge's new suggestions, not every session's done and needs reply. The per-session events are held
// while the tab is open; they are read only when a request fails or gives no answer, and dropped when an answer comes
// or the tab is left. Chirps are not decided here: they stay as they are.
// The decisions are kept here, away from the screen, so they can be tested scene by scene; App.tsx and
// use-concierge.ts only feed it and speak what it returns.
import type { ConciergeSuggestion } from "./concierge";
import type { SessionEvent } from "./sessions";

/** The event types read per session outside the tab, and held in it */
const HELD_TYPES: ReadonlySet<SessionEvent["type"]> = new Set(["done", "waiting"]);

/** A suggestion is new when its session and kind were not among the suggestions of the answer just before */
function suggestionKey(s: Pick<ConciergeSuggestion, "sessionId" | "kind">): string {
  return `${s.sessionId}\u0000${s.kind}`;
}

/** The suggestions of `next` whose session and kind are not in `prev`, in next's order. Text is not compared, so a
    suggestion that comes again with other text is not new */
export function newSuggestions<T extends ConciergeSuggestion>(prev: readonly ConciergeSuggestion[], next: readonly T[]): T[] {
  const seen = new Set(prev.map(suggestionKey));
  return next.filter((s) => !seen.has(suggestionKey(s)));
}

export class ConciergeReadout<S extends ConciergeSuggestion = ConciergeSuggestion> {
  private open = false;
  /** The suggestions of the answer just before (or those shown when the tab opened) */
  private last: readonly ConciergeSuggestion[] = [];
  /** The next answer is the one to the request that opening the tab asked, taken as seen */
  private awaitingOpening = false;
  /** done and needs reply events that came since the last answer while the tab is open */
  private held: SessionEvent[] = [];

  /** Whether the tab is open, so the per-session events are held */
  get isOpen(): boolean {
    return this.open;
  }

  /**
   * The tab opened. shown: the suggestions on screen now, taken as seen. asking: opening the tab asked for suggestions
   * (the scheduler set a request), so the answer to it is taken as seen too
   */
  opened(shown: readonly ConciergeSuggestion[], asking: boolean): void {
    this.open = true;
    this.last = [...shown];
    this.awaitingOpening = asking;
    this.held = [];
  }

  /** The tab was left: events still waiting for an answer are dropped */
  closed(): void {
    this.open = false;
    this.awaitingOpening = false;
    this.held = [];
  }

  /**
   * A session event that passed the usual checks (fresh, not muted). "speak": read it as outside the tab. "held": the
   * tab is open, so it waits for an answer (dropped) or a failure (read). "skip": a type that isn't read anyway
   */
  event(event: SessionEvent): "speak" | "held" | "skip" {
    if (!HELD_TYPES.has(event.type)) return "skip";
    if (!this.open) return "speak";
    this.held.push(event);
    return "held";
  }

  /**
   * An answer with suggestions came. Returns the suggestions to read: the new ones, in the order shown, or none for the
   * answer to the request that opening asked. The held events are dropped either way
   */
  answered(shown: readonly S[]): S[] {
    if (!this.open) return [];
    const read = this.awaitingOpening ? [] : newSuggestions(this.last, shown);
    this.last = [...shown];
    this.awaitingOpening = false;
    this.held = [];
    return read;
  }

  /**
   * A request asked with suggestions failed or gave no answer (error, timeout, output that doesn't match). Returns the
   * held events, to be read the way they are outside the tab; they are not held any longer. The suggestions compared
   * against stay those of the answer before
   */
  failed(): SessionEvent[] {
    if (!this.open) return [];
    const read = this.held;
    this.held = [];
    this.awaitingOpening = false;
    return read;
  }

  /**
   * No session needs a reply or is done any more, so the suggestions went away (use-concierge's clearAdvice). One that
   * comes back later is new, and the held events are about sessions that moved on, so they are dropped
   */
  cleared(): void {
    this.last = [];
    this.awaitingOpening = false;
    this.held = [];
  }
}
