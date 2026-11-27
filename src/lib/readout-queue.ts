// The readout queue used while a local TTS server is the voice (docs/design/readout-voice.md "Readout voice (local TTS server)").
// speechSynthesis's own queue can't hold server audio, so this one keeps the order and plays one utterance at a time.
// Each utterance's request is sent when it is queued; it settles to the server's audio, the system voice, or nothing,
// at the first of: the audio came, the request failed, TTS_WAIT_MS passed since it was sent. Audio that comes after is
// dropped: the readout is the signal that a turn finished, so it isn't held back for a slow server.
// Its outside world is passed in, so tests drive it scene by scene (tests/readout-queue.test.ts)
import type { ReadoutRoute, TtsKind } from "./readout-voice";

export const TTS_WAIT_MS = 5_000;

/** What a readout is for, in the log line */
export type ReadoutTag = "done" | "waiting" | "concierge" | "test";

export type SynthesisResult = { ok: true; audio: ArrayBuffer } | { ok: false; error: string };

export interface ReadoutDeps {
  route(lang: string): ReadoutRoute;
  /** The server kind, for the log line */
  serverKind(): TtsKind | undefined;
  synthesize(text: string, lang: string): Promise<SynthesisResult>;
  /** Resolves when the audio has played (or failed to), or at once when `signal` aborts (it must then play nothing, even
      if it is still waiting to decode). Throws when it can't be played at all */
  playAudio(audio: ArrayBuffer, volume: number, signal: AbortSignal): Promise<void>;
  /** Resolves when the utterance has been spoken (or failed to) */
  speakSystem(text: string, lang: string, volume: number): Promise<void>;
  stopSystem(): void;
  systemAvailable(): boolean;
  wait(ms: number): Promise<void>;
  now(): number;
  volume(): number;
  log(line: string): void;
}

type Settled = { use: "server"; audio: ArrayBuffer } | { use: "system" } | { use: "none" };

interface Item {
  text: string;
  lang: string;
  settled: Promise<Settled>;
  /** Set once the item has settled; a server item that settles to server audio may still fail to play */
  logLine?: (used: "server" | "system" | "none", error?: string) => void;
}

/** The error kind written to the log, without the server's message */
function errorKind(error: string): string {
  return error.split(":")[0].trim() || "error";
}

export class ReadoutQueue {
  private items: Item[] = [];
  private playing = false;
  private generation = 0;
  // One per generation; cancel() aborts it, which stops the audio of that generation however far along it is
  private abort = new AbortController();

  constructor(private deps: ReadoutDeps) {}

  enqueue(text: string, lang: string, tag: ReadoutTag): void {
    const route = this.deps.route(lang);
    if (route === "none") return;
    if (route === "system") {
      this.items.push({ text, lang, settled: Promise.resolve({ use: "system" }) });
    } else {
      this.items.push(this.serverItem(text, lang, tag));
    }
    void this.drain();
  }

  private serverItem(text: string, lang: string, tag: ReadoutTag): Item {
    const sentAt = this.deps.now();
    const kind = this.deps.serverKind() ?? "server";
    const item: Item = { text, lang, settled: Promise.resolve({ use: "none" }) };
    // ms is how long the server took to answer (or the wait to run out), not counting the time spent queued behind
    // other readouts before playing
    let settledAt: number | undefined;
    const log = (used: "server" | "system" | "none", error?: string) =>
      this.deps.log(
        `[voice] for=${tag} server=${kind} ms=${Math.round((settledAt ?? this.deps.now()) - sentAt)} used=${used}${error ? ` error=${error}` : ""}`,
      );
    const fallback = (): Settled => (this.deps.systemAvailable() ? { use: "system" } : { use: "none" });
    const generation = this.generation;
    item.settled = new Promise<Settled>((resolve) => {
      let done = false;
      const settle = (value: Settled, error?: string) => {
        if (done) return;
        done = true;
        settledAt = this.deps.now();
        if (generation !== this.generation) {
          log("none", "cancelled");
          resolve({ use: "none" });
          return;
        }
        // A server answer is logged once it has played (or failed to), in play()
        if (value.use === "server") item.logLine = log;
        else log(value.use, error);
        resolve(value);
      };
      this.deps.synthesize(text, lang).then(
        (result) => (result.ok ? settle({ use: "server", audio: result.audio }) : settle(fallback(), errorKind(result.error))),
        (e) => settle(fallback(), errorKind(String(e))),
      );
      void this.deps.wait(TTS_WAIT_MS).then(() => settle(fallback(), "timeout"));
    });
    return item;
  }

  private async drain(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    const generation = this.generation;
    const signal = this.abort.signal;
    try {
      while (this.items.length > 0 && generation === this.generation) {
        const item = this.items[0];
        const settled = await item.settled;
        if (generation !== this.generation) return;
        this.items.shift();
        await this.play(item, settled, signal);
      }
    } finally {
      if (generation === this.generation) this.playing = false;
    }
  }

  private async play(item: Item, settled: Settled, signal: AbortSignal): Promise<void> {
    if (settled.use === "none") return;
    if (settled.use === "server") {
      try {
        await this.deps.playAudio(settled.audio, this.deps.volume(), signal);
        item.logLine?.("server");
        return;
      } catch {
        // Cancelled meanwhile: nothing more is read, by any voice
        if (signal.aborted) return;
        // Couldn't be played (no audio context before the first click, or undecodable): read it with the system voice
        const fallback = this.deps.systemAvailable();
        item.logLine?.(fallback ? "system" : "none", "audio");
        if (!fallback) return;
      }
    }
    await this.deps.speakSystem(item.text, item.lang, this.deps.volume());
  }

  /** Stops what is playing and drops what is queued; answers still on their way are dropped too */
  cancel(): void {
    this.generation++;
    // Answers that came but weren't played yet still get their one log line
    for (const item of this.items) item.logLine?.("none", "cancelled");
    this.items = [];
    this.playing = false;
    this.abort.abort();
    this.abort = new AbortController();
    this.deps.stopSystem();
  }
}
