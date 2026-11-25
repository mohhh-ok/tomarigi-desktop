// Starting and stopping the MCP server from the page (use-agent-access.ts). Tauri runs each async command in its own
// task, so two invokes sent one after the other can reach Rust in either order; each call here is sent only after the
// one before it has answered. A start that a later start or stop overtook answers null, so its result can't put back
// a state the user has already left

export interface ServerCalls {
  start(port: number): Promise<string>;
  stop(): Promise<void>;
}

export type StartResult = { ok: true; command: string } | { ok: false; reason: string };

export function createServerSwitch(calls: ServerCalls) {
  let queue: Promise<unknown> = Promise.resolve();
  let latest = 0;
  const enqueue = <T>(call: () => Promise<T>): Promise<T> => {
    const done = queue.then(call);
    queue = done.catch(() => {});
    return done;
  };
  return {
    async start(port: number): Promise<StartResult | null> {
      const mine = ++latest;
      try {
        const command = await enqueue(() => calls.start(port));
        return mine === latest ? { ok: true, command } : null;
      } catch (e) {
        return mine === latest ? { ok: false, reason: String(e) } : null;
      }
    },
    stop(): Promise<void> {
      ++latest;
      return enqueue(() => calls.stop()).catch(() => {});
    },
  };
}
