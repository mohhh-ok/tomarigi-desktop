// The readout voice setting and what is read from a local TTS server's answers (docs/design.md "Readout voice (local
// TTS server)")
import { describe, expect, test } from "bun:test";
import {
  baseUrlForKind,
  parseReadoutVoice,
  routeOf,
  voicevoxCreditOf,
  type ReadoutVoice,
} from "../src/lib/readout-voice.ts";
import {
  classifyTestError,
  isVoicevoxEngineManifest,
  parseOpenAiVoices,
  parseVoicevoxSpeakers,
} from "../src/lib/tts-server.ts";

const openai: ReadoutVoice = {
  source: "local",
  local: { kind: "openai", baseUrl: "http://localhost:8880/v1", voice: "jf_alpha", model: "kokoro" },
};
const voicevox: ReadoutVoice = { source: "local", local: { kind: "voicevox", baseUrl: "http://localhost:50021", voice: "3" } };

describe("routeOf", () => {
  test("system voice is today's readout", () => {
    expect(routeOf({ source: "system" }, "ja", true)).toBe("system");
    expect(routeOf({ source: "system", local: voicevox.local }, "ja", true)).toBe("system");
  });
  test("a local server reads through the server", () => {
    expect(routeOf(openai, "en", true)).toBe("server");
    expect(routeOf(voicevox, "ja", true)).toBe("server");
  });
  test("VOICEVOX-compatible reads Japanese only", () => {
    expect(routeOf(voicevox, "en", true)).toBe("system");
    expect(routeOf(voicevox, "en", false)).toBe("none");
  });
  test("local chosen but not set up reads with the system voice", () => {
    expect(routeOf({ source: "local" }, "ja", true)).toBe("system");
  });
});

describe("parseReadoutVoice", () => {
  test("missing or broken data is the system voice", () => {
    expect(parseReadoutVoice(undefined)).toEqual({ source: "system" });
    expect(parseReadoutVoice("local")).toEqual({ source: "system" });
    expect(parseReadoutVoice({ source: "local", local: { kind: "piper", baseUrl: "x", voice: "y" } })).toEqual({
      source: "local",
    });
  });
  test("an OpenAI-compatible config needs a model", () => {
    expect(parseReadoutVoice({ source: "local", local: { ...openai.local, model: "" } })).toEqual({ source: "local" });
  });
  test("a saved config is read back", () => {
    expect(parseReadoutVoice(openai)).toEqual({ ...openai, local: { ...openai.local!, voicevoxCredit: false } });
  });
});

describe("baseUrlForKind", () => {
  test("the default URL follows the kind; a typed URL stays", () => {
    expect(baseUrlForKind("http://localhost:8880/v1", "openai", "voicevox")).toBe("http://localhost:50021");
    expect(baseUrlForKind("", "voicevox", "openai")).toBe("http://localhost:8880/v1");
    expect(baseUrlForKind("http://localhost:10101", "voicevox", "openai")).toBe("http://localhost:10101");
  });
});

describe("the VOICEVOX credit", () => {
  test("only for VOICEVOX ENGINE itself, told by its manifest", () => {
    expect(isVoicevoxEngineManifest(JSON.stringify({ name: "VOICEVOX Engine", brand_name: "VOICEVOX" }))).toBe(true);
    expect(isVoicevoxEngineManifest(JSON.stringify({ name: "AivisSpeech Engine", brand_name: "AivisSpeech" }))).toBe(false);
    expect(isVoicevoxEngineManifest("<html>")).toBe(false);
    expect(voicevoxCreditOf({ kind: "voicevox", speaker: "四国めたん", voicevoxCredit: true })).toBe("VOICEVOX:四国めたん");
    expect(voicevoxCreditOf({ kind: "voicevox", speaker: "まい", voicevoxCredit: false })).toBeUndefined();
  });
});

describe("lists", () => {
  test("VOICEVOX speakers give one option per style", () => {
    const body = JSON.stringify([{ name: "四国めたん", styles: [{ name: "ノーマル", id: 2 }, { name: "あまあま", id: 0 }] }]);
    expect(parseVoicevoxSpeakers(body)).toEqual([
      { value: "2", label: "四国めたん（ノーマル）", speaker: "四国めたん" },
      { value: "0", label: "四国めたん（あまあま）", speaker: "四国めたん" },
    ]);
  });
  test("OpenAI-compatible voices in either shape", () => {
    expect(parseOpenAiVoices(JSON.stringify({ voices: ["af_heart", "jf_alpha"] }))?.map((v) => v.value)).toEqual([
      "af_heart",
      "jf_alpha",
    ]);
    expect(parseOpenAiVoices(JSON.stringify([{ id: "a" }, { name: "b" }]))?.map((v) => v.value)).toEqual(["a", "b"]);
    expect(parseOpenAiVoices("not json")).toBeUndefined();
  });
});

describe("classifyTestError", () => {
  test("says why the Test failed", () => {
    expect(classifyTestError("openai", "network: error sending request").reason).toBe("unreachable");
    expect(classifyTestError("openai", "timeout").reason).toBe("timeout");
    expect(classifyTestError("openai", "not-audio").reason).toBe("wrong-server");
    expect(classifyTestError("openai", "http-404: {\"detail\":\"Not Found\"}").reason).toBe("wrong-server");
    expect(classifyTestError("openai", "http-400: Voice 'x' not found").reason).toBe("no-voice");
    expect(classifyTestError("voicevox", "http-422: 該当するスタイル(style_id=999)が存在しません").reason).toBe("no-voice");
    expect(classifyTestError("voicevox", "http-500: boom")).toEqual({ reason: "server", status: 500 });
  });
});
