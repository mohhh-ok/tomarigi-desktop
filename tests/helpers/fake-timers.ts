// Timers driven by hand for the tests of ConciergeScheduler (lib/concierge.ts). Shared by tests/concierge.test.ts and
// tests/concierge-expiry.test.ts

/** Timers driven by hand: advance(ms) runs what is due, in order. now() is the hand-driven clock */
export function fakeTimers() {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      now: () => now,
      set: (fn: () => void, ms: number) => {
        pending.set(++next, { at: now + ms, fn });
        return next;
      },
      clear: (handle: unknown) => void pending.delete(handle as number),
    },
    now: () => now,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}
