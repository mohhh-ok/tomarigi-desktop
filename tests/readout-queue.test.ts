// The readout through a local TTS server, scene by scene: when the server's audio is played, when the system voice
// reads instead, and that the order is kept (docs/design.md "Readout voice (local TTS server)")
import { describe, expect, test } from "bun:test";
import { ReadoutQueue, TTS_WAIT_MS, type ReadoutDeps, type SynthesisResult } from "../src/lib/readout-queue.ts";
import { routeOf, type ReadoutVoice } from "../src/lib/readout-voice.ts";

const VOICEVOX: ReadoutVoice = {
  source: "local",
  local: { kind: "voicevox", baseUrl: "http://localhost:50021", voice: "3" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function audioOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** A queue whose server answers, waits, and playback are driven by the test. played: what was heard, in order */
function scene(options: { voice?: ReadoutVoice; systemAvailable?: boolean } = {}) {
  const voice = options.voice ?? VOICEVOX;
  const systemAvailable = options.systemAvailable ?? true;
  const requests = new Map<string, ReturnType<typeof deferred<SynthesisResult>>>();
  const waits: Array<() => void> = [];
  const played: string[] = [];
  const log: string[] = [];
  // Playback that is still going, so a test can see nothing starts over it
  let playing: { text: string; end: () => void } | undefined;
  let overlap = false;
  let clock = 0;
  const start = (label: string) =>
    new Promise<void>((resolve) => {
      if (playing) overlap = true;
      played.push(label);
      playing = {
        text: label,
        end: () => {
          playing = undefined;
          resolve();
        },
      };
    });
  const deps: ReadoutDeps = {
    route: (lang) => routeOf(voice, lang, systemAvailable),
    serverKind: () => voice.local?.kind,
    synthesize: (text) => {
      const d = deferred<SynthesisResult>();
      requests.set(text, d);
      return d.promise;
    },
    playAudio: (audio) => start(`server:${new TextDecoder().decode(audio)}`),
    speakSystem: (text) => start(`system:${text}`),
    stopAudio: () => playing?.end(),
    stopSystem: () => playing?.end(),
    systemAvailable: () => systemAvailable,
    wait: (ms) => {
      expect(ms).toBe(TTS_WAIT_MS);
      return new Promise((resolve) => waits.push(resolve));
    },
    now: () => clock,
    volume: () => 1,
    log: (line) => log.push(line),
  };
  const queue = new ReadoutQueue(deps);
  return {
    queue,
    played,
    log,
    get overlap() {
      return overlap;
    },
    requested: () => [...requests.keys()],
    answer: async (text: string, ms = 800) => {
      clock = ms;
      requests.get(text)!.resolve({ ok: true, audio: audioOf(text) });
      await flush();
    },
    fail: async (text: string, error: string) => {
      requests.get(text)!.resolve({ ok: false, error });
      await flush();
    },
    /** The 5 seconds of every request sent so far pass */
    timeOut: async () => {
      clock = TTS_WAIT_MS;
      for (const w of waits.splice(0)) w();
      await flush();
    },
    tick: (ms: number) => {
      clock += ms;
    },
    /** The utterance playing now ends */
    end: async () => {
      playing?.end();
      await flush();
    },
  };
}

describe("ReadoutQueue", () => {
  test("the server answers in time: its audio is played and logged as used, with the time it took to answer", async () => {
    const s = scene();
    s.queue.enqueue("app", "ja", "done");
    await s.answer("app", 812);
    // Playback takes a while; the logged time is the server's
    s.tick(3000);
    await s.end();
    expect(s.played).toEqual(["server:app"]);
    expect(s.log).toEqual(["[voice] for=done server=voicevox ms=812 used=server"]);
  });

  test("the server answers with an error: the system voice reads it", async () => {
    const s = scene();
    s.queue.enqueue("app", "ja", "waiting");
    await s.fail("app", "http-500: Internal Server Error");
    expect(s.played).toEqual(["system:app"]);
    expect(s.log).toEqual(["[voice] for=waiting server=voicevox ms=0 used=system error=http-500"]);
  });

  test("no audio within 5 seconds: the system voice reads it, and the audio that comes later is dropped", async () => {
    const s = scene();
    s.queue.enqueue("app", "ja", "done");
    await s.timeOut();
    expect(s.played).toEqual(["system:app"]);
    await s.end();
    await s.answer("app", 6200);
    expect(s.played).toEqual(["system:app"]);
    expect(s.log).toEqual(["[voice] for=done server=voicevox ms=5000 used=system error=timeout"]);
  });

  test("English UI with a VOICEVOX-compatible server: the system voice reads it with no request", async () => {
    const s = scene();
    s.queue.enqueue("app", "en", "done");
    await flush();
    expect(s.requested()).toEqual([]);
    expect(s.played).toEqual(["system:app"]);
    expect(s.log).toEqual([]);
  });

  test("no system voice: a failed utterance is skipped and logged, and the next one still plays", async () => {
    const s = scene({ systemAvailable: false });
    s.queue.enqueue("app", "ja", "done");
    s.queue.enqueue("fixed the bug", "ja", "done");
    await s.fail("app", "network: connection refused");
    await s.answer("fixed the bug");
    expect(s.played).toEqual(["server:fixed the bug"]);
    expect(s.log[0]).toBe("[voice] for=done server=voicevox ms=0 used=none error=network");
  });

  test("no system voice and English UI with VOICEVOX: nothing is queued", async () => {
    const s = scene({ systemAvailable: false });
    s.queue.enqueue("app", "en", "done");
    await flush();
    expect(s.requested()).toEqual([]);
    expect(s.played).toEqual([]);
  });

  test("several events: played in the order queued, one at a time, even when a later request answers first", async () => {
    const s = scene();
    s.queue.enqueue("app", "ja", "done");
    s.queue.enqueue("fixed the bug", "ja", "done");
    s.queue.enqueue("site is waiting for your reply", "ja", "waiting");
    // Every request is sent at once
    expect(s.requested()).toEqual(["app", "fixed the bug", "site is waiting for your reply"]);
    await s.answer("site is waiting for your reply");
    await s.answer("fixed the bug");
    expect(s.played).toEqual([]);
    await s.answer("app");
    expect(s.played).toEqual(["server:app"]);
    await s.end();
    expect(s.played).toEqual(["server:app", "server:fixed the bug"]);
    await s.end();
    expect(s.played).toEqual(["server:app", "server:fixed the bug", "server:site is waiting for your reply"]);
    expect(s.overlap).toBe(false);
  });

  test("a done whose body falls back plays both in order, in two voices (each utterance is decided by itself)", async () => {
    const s = scene();
    s.queue.enqueue("app", "ja", "done");
    s.queue.enqueue("fixed the bug", "ja", "done");
    await s.answer("app");
    await s.fail("fixed the bug", "http-422: style not found");
    await s.end();
    expect(s.played).toEqual(["server:app", "system:fixed the bug"]);
  });

  test("audio that can't be played is read with the system voice", async () => {
    const s = scene();
    const log: string[] = [];
    const q = new ReadoutQueue({
      route: () => "server",
      serverKind: () => "openai",
      synthesize: async () => ({ ok: true, audio: audioOf("x") }),
      playAudio: async () => {
        throw new Error("no audio context");
      },
      speakSystem: async (text) => void s.played.push(`system:${text}`),
      stopAudio: () => {},
      stopSystem: () => {},
      systemAvailable: () => true,
      wait: () => new Promise(() => {}),
      now: () => 0,
      volume: () => 1,
      log: (line) => log.push(line),
    });
    q.enqueue("app", "en", "concierge");
    await flush();
    await flush();
    expect(s.played).toEqual(["system:app"]);
    expect(log).toEqual(["[voice] for=concierge server=openai ms=0 used=system error=audio"]);
  });

  test("cancel stops what plays, drops the queue, and drops an answer still on its way", async () => {
    const s = scene();
    s.queue.enqueue("app", "ja", "done");
    s.queue.enqueue("fixed the bug", "ja", "done");
    await s.answer("app");
    expect(s.played).toEqual(["server:app"]);
    s.queue.cancel();
    await flush();
    await s.answer("fixed the bug");
    expect(s.played).toEqual(["server:app"]);
    // A new readout after cancel plays
    s.queue.enqueue("site", "ja", "waiting");
    await s.answer("site");
    expect(s.played).toEqual(["server:app", "server:site"]);
  });
});
