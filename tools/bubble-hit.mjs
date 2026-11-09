// Checks in a headless browser what a click on a speech bubble reaches (docs/design.md "Fade until hovered"): the
// concierge's bubble takes clicks over its whole box, its empty space included, so a bird drawn under it isn't pressed
// through it; a bird's bubble lets clicks through to what is under it. Runs the mock (?mock=1&focusable=1, where a click
// that would jump to a pane logs "[mock] focus <id>") from a `vite build` output, with no dev server or port.
//   DIST=/tmp/tomarigi-desktop/dist PLAYWRIGHT=/tmp/pw/node_modules/playwright node tools/bubble-hit.mjs
// (setup and the build: tools/README.md "Playwright")
// Prints one line per check: OK or NG, what was checked, and what was found. Exits 1 when any check is NG.
// Scenes, each shown and at rest (data-fade="rest", as the app sets it):
// - garden: the Garden with the concierge and a bird put under the concierge's bubble (the same IndexedDB entry a drag
//   saves), and birds with their own bubbles (preset=asking)
// - concierge-tab: the Concierge tab, whose bubble holds the suggestions and the session names
import { launch, mockPath, routeMock, saveGardenPositions } from "./mock-browser.mjs";

const DIST = process.env.DIST;
if (!DIST) throw new Error("DIST=<a vite build --outDir directory> is required");
const ORIGIN = "http://tomarigi.bubble-hit";

const CONCIERGE = "concierge";
// The bird put under the concierge's bubble in the garden scene
const UNDER = "mock/asking/finished";
const BOX = ".fade-box";
let failed = 0;
const report = (ok, what, found) => {
  if (!ok) failed++;
  console.log(`${ok ? "OK" : "NG"}  ${what}  -> ${found}`);
};

// The element at a point, as a short path (tag.class) up to the first element with a class that says what it is
const describeAt = (page, x, y) =>
  page.evaluate(
    ([x, y, box]) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return { path: "(nothing)", inBox: false, node: null };
      const name = (e) => `${e.tagName.toLowerCase()}${e.classList.length ? `.${[...e.classList].join(".")}` : ""}`;
      return {
        path: name(el),
        inBox: Boolean(el.closest(box)),
        node: el.closest(".garden-node")?.dataset.sessionId ?? null,
      };
    },
    [x, y, BOX],
  );

const rectOf = (page, selector) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }, selector);

// A point in the bubble's empty space: inside its box, where no text is (the bottom left corner, inside the rounding)
const emptyPointOf = async (page, selector) => {
  const r = await rectOf(page, selector);
  return r && { x: r.left + 6, y: r.bottom - 3 };
};

// Clicks at a point and returns the "[mock] focus" lines and the Tauri calls (start_dragging) it caused
const clickAt = async (page, logs, x, y) => {
  logs.length = 0;
  await page.evaluate(() => (window.__calls = []));
  await page.mouse.click(x, y);
  await page.waitForTimeout(300);
  const calls = await page.evaluate(() => window.__calls);
  return { focus: logs.filter((l) => l.startsWith("[mock] focus")), calls };
};

// Presses at a point and moves away, as when grabbing to drag; returns the Tauri calls it caused
const dragFrom = async (page, x, y) => {
  await page.evaluate(() => (window.__calls = []));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y + 20, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  return page.evaluate(() => window.__calls);
};

const setRest = (page, rest) =>
  page.evaluate((rest) => {
    if (rest) document.documentElement.dataset.fade = "rest";
    else delete document.documentElement.dataset.fade;
  }, rest);

const conciergeBubble = `.garden-bubble-anchor[data-session-id="${CONCIERGE}"] ${BOX}`;

async function gardenScene(page, logs, url) {
  await page.goto(url);
  await page.waitForSelector(conciergeBubble, { timeout: 15000 });
  await page.waitForTimeout(1500);
  // Put the bird under the concierge's bubble: its glyph's center at the bubble's center, both as the user dropped them
  const garden = await rectOf(page, ".garden");
  const node = await rectOf(page, `.garden-node[data-session-id="${UNDER}"]`);
  const glyph = await rectOf(page, `.garden-node[data-session-id="${UNDER}"] .garden-glyph`);
  const conciergeNode = await rectOf(page, `.garden-node[data-session-id="${CONCIERGE}"]`);
  const bubble = await rectOf(page, conciergeBubble);
  const cx = 40;
  const conciergeTop = 4;
  const shiftY = bubble.top + bubble.height / 2 - conciergeNode.top;
  const glyphFromTop = glyph.top + glyph.height / 2 - node.top;
  const underTop = ((conciergeTop / 100) * garden.height + shiftY - glyphFromTop) / garden.height * 100;
  await saveGardenPositions(page, ORIGIN, {
    [CONCIERGE]: { x: cx, y: conciergeTop, byUser: true },
    [UNDER]: { x: cx, y: underTop, byUser: true },
  });
  await page.goto(url);
  await page.waitForSelector(conciergeBubble, { timeout: 15000 });
  await page.waitForTimeout(2500);

  for (const rest of [false, true]) {
    await setRest(page, rest);
    const state = rest ? "at rest" : "shown";
    const b = await rectOf(page, conciergeBubble);
    const g = await rectOf(page, `.garden-node[data-session-id="${UNDER}"] .garden-glyph`);
    const over = g && { left: Math.max(b.left, g.left), right: Math.min(b.right, g.right), top: Math.max(b.top, g.top), bottom: Math.min(b.bottom, g.bottom) };
    const overlaps = over && over.right > over.left && over.bottom > over.top;
    report(Boolean(overlaps), `garden ${state}: the bird ${UNDER} is under the concierge's bubble`, overlaps ? `overlap ${Math.round(over.right - over.left)}x${Math.round(over.bottom - over.top)}px` : `bubble ${JSON.stringify(b)} glyph ${JSON.stringify(g)}`);

    const empty = await emptyPointOf(page, conciergeBubble);
    const atEmpty = await describeAt(page, empty.x, empty.y);
    report(atEmpty.inBox, `garden ${state}: the concierge's bubble, empty space (${empty.x}, ${empty.y})`, atEmpty.path);

    if (overlaps) {
      const x = (over.left + over.right) / 2;
      const y = (over.top + over.bottom) / 2;
      const at = await describeAt(page, x, y);
      report(at.inBox && at.node === null, `garden ${state}: the concierge's bubble over the bird (${x}, ${y})`, `${at.path}${at.node ? ` (bird ${at.node})` : ""}`);
      const { focus } = await clickAt(page, logs, x, y);
      report(focus.length === 0, `garden ${state}: a click there jumps nowhere`, focus.length ? focus.join(" | ") : "no [mock] focus");
    }
    const { focus } = await clickAt(page, logs, empty.x, empty.y);
    report(focus.length === 0, `garden ${state}: a click on the bubble's empty space jumps nowhere (not even the concierge's)`, focus.length ? focus.join(" | ") : "no [mock] focus");
    const drag = await dragFrom(page, empty.x, empty.y);
    report(drag.includes("plugin:window|start_dragging"), `garden ${state}: grabbing the bubble moves the window`, drag.length ? drag.join(", ") : "no Tauri call");

    // A bird's own bubble lets clicks through
    const birdBubbles = await page.evaluate(() =>
      [...document.querySelectorAll(".garden-bubble-anchor:not(.concierge) .speech-bubble-below")].map((e) => {
        const r = e.getBoundingClientRect();
        return { id: e.closest(".garden-bubble-anchor").dataset.sessionId, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }),
    );
    report(birdBubbles.length > 0, `garden ${state}: birds with their own bubble`, `${birdBubbles.length}`);
    for (const p of birdBubbles) {
      const at = await describeAt(page, p.x, p.y);
      const onBubble = await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest(".speech-bubble-below")), [p.x, p.y]);
      report(!onBubble, `garden ${state}: ${p.id}'s bubble lets the click through (${Math.round(p.x)}, ${Math.round(p.y)})`, at.path);
    }

    // The concierge's own bird still jumps
    const cg = await rectOf(page, `.garden-node[data-session-id="${CONCIERGE}"] .garden-glyph`);
    const own = await clickAt(page, logs, cg.left + cg.width / 2, cg.top + cg.height / 2);
    report(own.focus.length === 1, `garden ${state}: a click on the concierge's bird jumps`, own.focus.join(" | ") || "no [mock] focus");
  }
}

async function conciergeTabScene(page, logs, url) {
  await page.goto(url);
  await page.waitForSelector(`.garden-concierge-only ${BOX}`, { timeout: 15000 });
  await page.waitForTimeout(2500);
  const bubble = `.garden-concierge-only ${BOX}`;
  for (const rest of [false, true]) {
    await setRest(page, rest);
    const state = rest ? "at rest" : "shown";
    const empty = await emptyPointOf(page, bubble);
    const at = await describeAt(page, empty.x, empty.y);
    report(at.inBox, `concierge tab ${state}: the bubble, empty space (${empty.x}, ${empty.y})`, at.path);
    const { focus } = await clickAt(page, logs, empty.x, empty.y);
    report(focus.length === 0, `concierge tab ${state}: a click on the empty space jumps nowhere`, focus.length ? focus.join(" | ") : "no [mock] focus");
    const drag = await dragFrom(page, empty.x, empty.y);
    report(drag.includes("plugin:window|start_dragging"), `concierge tab ${state}: grabbing the bubble moves the window`, drag.length ? drag.join(", ") : "no Tauri call");
    const name = await rectOf(page, `${bubble} .concierge-status-name`);
    report(Boolean(name), `concierge tab ${state}: a session name in the bubble`, name ? "found" : "none");
    if (name) {
      const hit = await clickAt(page, logs, name.left + Math.min(8, name.width / 2), name.top + name.height / 2);
      report(hit.focus.length === 1, `concierge tab ${state}: a click on the session name jumps`, hit.focus.join(" | ") || "no [mock] focus");
    }
  }
}

const browser = await launch();
try {
  for (const [scene, query, run] of [
    ["garden", "preset=asking&concierge=&focusable=1", gardenScene],
    ["concierge-tab", "preset=asking&tab=concierge&concierge=&focusable=1", conciergeTabScene],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: 760, height: 560 }, locale: "en-US" });
    const page = await ctx.newPage();
    await routeMock(page, ORIGIN, DIST);
    // Tauri calls are recorded and fail, as in a browser; start_dragging is what grabbing the window background calls
    await page.addInitScript(() => {
      window.__calls = [];
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
        invoke: (cmd) => {
          window.__calls.push(cmd);
          return Promise.reject(new Error("no Tauri"));
        },
        transformCallback: () => 0,
      };
    });
    const logs = [];
    page.on("console", (m) => logs.push(m.text()));
    console.log(`# ${scene}`);
    await run(page, logs, `${ORIGIN}${mockPath(query)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
