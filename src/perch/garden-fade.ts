// Fade until hovered (docs/design.md "Fade until hovered"). While clicks go through, the WebView gets no mouse events,
// so the Rust side (fade_tick in src-tauri/src/fade.rs) watches the cursor. This sends it the bird rectangles and
// whether the fade applies, and copies its "garden-fade" event to <html data-fade="rest">, which styles/base.css fades
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

// Birds move by layout changes, resizing, and enter/leave animations. Looked up at this interval and sent only
// when changed
const MEASURE_MS = 250;

interface BirdRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The bird and its badges ("?", anger mark), which stick out of the glyph */
function birdRects(): BirdRect[] {
  const rects: BirdRect[] = [];
  for (const glyph of document.querySelectorAll(".garden-node .garden-glyph")) {
    let { left, top, right, bottom } = glyph.getBoundingClientRect();
    if (right <= left || bottom <= top) continue;
    for (const badge of glyph.querySelectorAll(".bird-badge")) {
      const b = badge.getBoundingClientRect();
      left = Math.min(left, b.left);
      top = Math.min(top, b.top);
      right = Math.max(right, b.right);
      bottom = Math.max(bottom, b.bottom);
    }
    rects.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return rects;
}

/** enabled: floating window, Garden tab, and nothing else open over it. With no birds there is nothing to hover to
 * bring the window back, so it doesn't fade then */
export function useGardenFade(enabled: boolean) {
  // The first send waits for this, so the state Rust emits in reply isn't lost before the listener is registered
  const listening = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    const root = document.documentElement;
    const unlisten = listen<boolean>("garden-fade", (e) => {
      if (e.payload) root.dataset.fade = "rest";
      else delete root.dataset.fade;
    });
    listening.current = unlisten;
    return () => void unlisten.then((f) => f());
  }, []);

  useEffect(() => {
    let last = "";
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    // resync: have Rust emit its current state again (the page may have been reloaded while it was faded)
    const send = (on: boolean, birds: BirdRect[], resync = false) => {
      const key = JSON.stringify([on, birds]);
      if (key === last && !resync) return;
      last = key;
      invoke("set_garden_fade", { enabled: on, birds, resync }).catch(() => {});
    };
    if (!enabled) {
      delete document.documentElement.dataset.fade;
      void listening.current.then(() => !stopped && send(false, [], true));
      return () => {
        stopped = true;
      };
    }
    const measure = (resync = false) => {
      const birds = birdRects();
      send(birds.length > 0, birds, resync);
    };
    void listening.current.then(() => {
      if (stopped) return;
      measure(true);
      timer = setInterval(measure, MEASURE_MS);
    });
    return () => {
      stopped = true;
      clearInterval(timer);
      send(false, []);
    };
  }, [enabled]);
}
