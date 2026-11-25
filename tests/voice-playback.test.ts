// playAudio (lib/voice.ts) on a fake AudioContext: an abort stops that one playback however far along it is, and the
// settings' Test plays under a handle of its own, so a readout's cancel doesn't touch it (docs/design.md "Readout voice
// (local TTS server)")
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("@tauri-apps/api/core", () => ({ invoke: async () => {} }));

const g = globalThis as Record<string, unknown>;
g.location = { search: "" };

let decode: Promise<void> = Promise.resolve();
const started: string[] = [];
const stopped: string[] = [];
g.AudioContext = class {
  state = "running";
  destination = {};
  resume = async () => {};
  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }
  decodeAudioData = async () => {
    await decode;
    return {};
  };
  createBufferSource() {
    const id = `source${started.length}`;
    const src = {
      buffer: undefined as unknown,
      onended: undefined as undefined | (() => void),
      connect() {},
      start() {
        started.push(id);
      },
      stop() {
        stopped.push(id);
        src.onended?.();
      },
    };
    return src;
  }
};

const { playAudio } = await import("../src/lib/voice.ts");
const { primeAudio } = await import("../src/lib/chirp.ts");
primeAudio();

const flush = () => new Promise((r) => setTimeout(r, 0));
const bytes = new ArrayBuffer(1);

beforeEach(() => {
  started.length = 0;
  stopped.length = 0;
  decode = Promise.resolve();
});

describe("playAudio", () => {
  test("aborted while decoding: no source is started", async () => {
    let finishDecode!: () => void;
    decode = new Promise<void>((r) => (finishDecode = r));
    const ac = new AbortController();
    const done = playAudio(bytes, 1, ac.signal);
    await flush();
    ac.abort();
    finishDecode();
    await done;
    expect(started).toEqual([]);
  });

  test("aborted before it starts: nothing is decoded or started", async () => {
    const ac = new AbortController();
    ac.abort();
    await playAudio(bytes, 1, ac.signal);
    expect(started).toEqual([]);
  });

  test("aborted while sounding: the source stops and the promise settles", async () => {
    const ac = new AbortController();
    const done = playAudio(bytes, 1, ac.signal);
    await flush();
    expect(started).toEqual(["source0"]);
    ac.abort();
    await done;
    expect(stopped).toEqual(["source0"]);
  });

  test("a playback under another handle (the settings' Test) keeps sounding when a readout's handle is aborted", async () => {
    const readout = new AbortController();
    const trial = new AbortController();
    const readoutDone = playAudio(bytes, 1, readout.signal);
    const testDone = playAudio(bytes, 1, trial.signal);
    await flush();
    expect(started).toEqual(["source0", "source1"]);
    readout.abort();
    await readoutDone;
    expect(stopped).toEqual(["source0"]);
    trial.abort();
    await testDone;
    expect(stopped).toEqual(["source0", "source1"]);
  });
});
