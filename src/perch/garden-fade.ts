// Fade until hovered (docs/design.md "Fade until hovered"). While clicks go through, the WebView gets no mouse events,
// so the Rust side (fade_tick in src-tauri/src/fade.rs) watches the cursor. This sends it the bird and window handles'
// rectangles and whether the fade applies, and copies its "garden-fade" event to <html data-fade="rest">, which
// styles/base.css fades, and its "garden-fade-bird" event (cursor on a bird at rest) to <html data-fade-bird>, which
// makes the handle stand out
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";
import { currentWindowMode } from "./window-mode";

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

/** The window handles: "Tomarigi" in the header (App.tsx), and the Garden's empty message while it has no birds
 * (garden.tsx) */
const HANDLE_SELECTOR = ".fade-handle";

function handleRects(): BirdRect[] {
  const rects: BirdRect[] = [];
  for (const el of document.querySelectorAll(HANDLE_SELECTOR)) {
    const { left, top, right, bottom } = el.getBoundingClientRect();
    if (right <= left || bottom <= top) continue;
    rects.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return rects;
}

/** The Garden's empty message (garden.tsx), shown instead of birds */
const EMPTY_SELECTOR = ".garden-empty";

// Moving this far with the button held makes a press on the handle a drag instead of a click
const HANDLE_DRAG_PX = 4;

/** pointerdown on the window handle: dragging moves the window, a click shows the whole window while faded. The
 * window drag starts only once the pointer moves, since a drag started on press swallows the release and the click
 * would never be seen */
export function onFadeHandlePointerDown(e: ReactPointerEvent<HTMLElement>) {
  if (e.button !== 0 || currentWindowMode() === "normal") return;
  e.preventDefault();
  const { screenX: x0, screenY: y0, pointerId } = e;
  const end = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", end);
  };
  const onMove = (m: PointerEvent) => {
    if (m.pointerId !== pointerId) return;
    if (Math.hypot(m.screenX - x0, m.screenY - y0) < HANDLE_DRAG_PX) return;
    end();
    void getCurrentWindow().startDragging();
  };
  const onUp = (u: PointerEvent) => {
    if (u.pointerId !== pointerId) return;
    end();
    if (document.documentElement.dataset.fade === "rest") invoke("reveal_garden").catch(() => {});
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", end);
}

/** enabled: floating window, Garden tab, and nothing else open over it. It fades with birds, or with the empty
 * message in their place (it stays at rest). Neither (e.g. still loading) leaves nothing to show, so no fade then */
export function useGardenFade(enabled: boolean) {
  // The first send waits for this, so the state Rust emits in reply isn't lost before the listener is registered
  const listening = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    const root = document.documentElement;
    const unlisten = listen<boolean>("garden-fade", (e) => {
      if (e.payload) root.dataset.fade = "rest";
      else delete root.dataset.fade;
    });
    const unlistenBird = listen<boolean>("garden-fade-bird", (e) => {
      if (e.payload) root.dataset.fadeBird = "";
      else delete root.dataset.fadeBird;
    });
    listening.current = Promise.all([unlisten, unlistenBird]);
    return () => {
      void unlisten.then((f) => f());
      void unlistenBird.then((f) => f());
    };
  }, []);

  useEffect(() => {
    let last = "";
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    // resync: have Rust emit its current state again (the page may have been reloaded while it was faded)
    const send = (on: boolean, birds: BirdRect[], handles: BirdRect[], resync = false) => {
      const key = JSON.stringify([on, birds, handles]);
      if (key === last && !resync) return;
      last = key;
      invoke("set_garden_fade", { enabled: on, birds, handles, resync }).catch(() => {});
    };
    if (!enabled) {
      delete document.documentElement.dataset.fade;
      delete document.documentElement.dataset.fadeBird;
      void listening.current.then(() => !stopped && send(false, [], [], true));
      return () => {
        stopped = true;
      };
    }
    const measure = (resync = false) => {
      const birds = birdRects();
      const empty = document.querySelector(EMPTY_SELECTOR) !== null;
      send(birds.length > 0 || empty, birds, handleRects(), resync);
    };
    void listening.current.then(() => {
      if (stopped) return;
      measure(true);
      timer = setInterval(measure, MEASURE_MS);
    });
    return () => {
      stopped = true;
      clearInterval(timer);
      send(false, [], []);
    };
  }, [enabled]);
}
