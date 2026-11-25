import { describe, expect, test } from "bun:test";
import { createServerSwitch } from "../src/perch/server-switch";

function fakeServer() {
  const log: string[] = [];
  let running: number | null = null;
  const pending: (() => void)[] = [];
  return {
    log,
    running: () => running,
    finishStart: () => pending.shift()?.(),
    calls: {
      start: (port: number) =>
        new Promise<string>((resolve) => {
          log.push(`start ${port}`);
          pending.push(() => {
            running = port;
            log.push(`started ${port}`);
            resolve(`cmd ${port}`);
          });
        }),
      stop: async () => {
        log.push("stop");
        running = null;
      },
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("createServerSwitch", () => {
  test("on then off at once: stop is sent after the start answers, and the start's result is dropped", async () => {
    const server = fakeServer();
    const sw = createServerSwitch(server.calls);
    const starting = sw.start(4844);
    const stopping = sw.stop();
    await settle();
    expect(server.log).toEqual(["start 4844"]);
    server.finishStart();
    expect(await starting).toBeNull();
    await stopping;
    expect(server.log).toEqual(["start 4844", "started 4844", "stop"]);
    expect(server.running()).toBeNull();
  });

  test("the last of two starts gives the result", async () => {
    const server = fakeServer();
    const sw = createServerSwitch(server.calls);
    const first = sw.start(4844);
    const second = sw.start(4845);
    await settle();
    server.finishStart();
    expect(await first).toBeNull();
    await settle();
    server.finishStart();
    expect(await second).toEqual({ ok: true, command: "cmd 4845" });
    expect(server.running()).toBe(4845);
  });

  test("a failed start says why, and the next call still runs", async () => {
    let taken = true;
    const sw = createServerSwitch({
      start: async (port) => {
        if (taken) throw "port-in-use";
        return `cmd ${port}`;
      },
      stop: async () => {},
    });
    expect(await sw.start(4844)).toEqual({ ok: false, reason: "port-in-use" });
    taken = false;
    expect(await sw.start(4844)).toEqual({ ok: true, command: "cmd 4844" });
  });
});
