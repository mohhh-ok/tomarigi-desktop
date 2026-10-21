// The stage for shoot.mjs: a desktop with a terminal, and the Tomarigi mock in a frame on top. The terminal's tabs run
// four agents (one per bird); the open tab shows the blog session, whose question matches the blog bird's bubble.
// Each scene sets the stage's size and where the terminal is (shoot.mjs). In the first image the whole terminal window
// shows; in the others it reaches past the window's right and bottom edges, so no terminal edge shows through the glass
const TABS = [
  ["blog", "claude"],
  ["tomarigi", "codex"],
  ["figma-adapter", "gemini"],
  ["moh-tech-net", "opencode"],
];

// The blog session's conversation: an ordinary task, ending in the plan's question that the "?" bird's bubble asks.
// In the first image (window at rest) the birds and their bubbles sit over the plan, whose lines ("i", and "d" for an
// item's second line) are long enough to run past the birds on both sides
const LINES = {
  en: [
    ["u", "Add pages that list posts by tag"],
    ["a", "I read the 38 posts in src/content/posts/ and the index page."],
    ["a", "Tags are in each post's frontmatter; there are 14 of them."],
    ["a", "Here is the plan:"],
    ["i", "1. Add src/pages/tags/[tag].astro: each tag's posts, newest first"],
    ["i", "2. Show each post's tags on the index page, linked to the tag pages"],
    ["i", "3. Leave tags with only one post out of the index page's tag list"],
    ["i", "4. Lowercase tags that differ only in case (\"React\", \"react\"),"],
    ["d", "and redirect the old tag URLs to the new ones"],
    ["i", "5. Build the site and check that every tag gets its page"],
    ["i", "6. Commit the changes and open a pull request for you to review"],
    ["q", "Approve this plan?"],
  ],
  ja: [
    ["u", "記事一覧に、タグで絞り込めるページを足して"],
    ["a", "src/content/posts/ の 38 本の記事と、一覧ページを読みました。"],
    ["a", "タグは各記事の frontmatter にあり、全部で 14 種類です。"],
    ["a", "次の順で進めます:"],
    ["i", "1. src/pages/tags/[tag].astro を作り、タグごとに記事を新しい順に並べる"],
    ["i", "2. 一覧ページの各記事の下にタグを出し、押すとそのタグのページへ移る"],
    ["i", "3. 記事が 1 本しかないタグは、一覧ページのタグの欄から外す"],
    ["i", "4. 大文字と小文字だけ違うタグ（React と react）は小文字にそろえ、"],
    ["d", "古い URL は新しい URL へ転送する"],
    ["i", "5. ビルドして、すべてのタグのページができることを確かめる"],
    ["i", "6. 変更をコミットし、プルリクエストを作って見てもらう"],
    ["q", "この計画で進めてよいですか？"],
  ],
};

// A stage's default size in CSS px and where the terminal sits on it (shoot.mjs shoots every stage at the same scale,
// 2540 / 762). Tall enough for Perch and Recent activity to show every row
export const STAGE = { w: 762, h: 570, term: { left: 16, top: 12, w: 740, h: 570 } };

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function pane(lang) {
  const rows = LINES[lang]
    .map(([k, t]) => (k === "u" ? `<div class="u"><span class="pr">›</span> ${esc(t)}</div>` : `<div class="${k}">${esc(t)}</div>`))
    .join("");
  return `<div class="pane"><div class="cmd"><span class="dir">~/Dev/blog</span> <span class="pr">$</span> claude</div>${rows}<div class="u cursor"><span class="pr">›</span> <i></i></div></div>`;
}

export function stage({ lang, url, win, fade, size = STAGE }) {
  const { term } = size;
  const tabs = TABS.map(([dir, cmd], i) => `<span class="tab${i === 0 ? " on" : ""}">${dir} — ${cmd}</span>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html{color-scheme:dark}html,body{margin:0;height:100%;overflow:hidden}
  body{background:#56636a;font-family:-apple-system,"Hiragino Sans",sans-serif}
  .term{position:absolute;left:${term.left}px;top:${term.top}px;width:${term.w}px;height:${term.h}px;background:#17191d;border-radius:10px;
    box-shadow:0 18px 40px rgba(0,0,0,.35),0 0 0 .5px rgba(0,0,0,.7);overflow:hidden}
  .bar{height:28px;display:flex;align-items:center;gap:8px;padding:0 12px;background:#202328}
  .bar i{width:12px;height:12px;border-radius:50%;display:block}
  .tabs{display:flex;background:#202328;border-bottom:1px solid #000;font:10px/1 -apple-system,sans-serif;color:#8a9099}
  .tab{flex:auto;text-align:center;padding:7px 4px;border-left:1px solid #000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tab.on{background:#17191d;color:#d6d9de}
  .view{height:100%;overflow:hidden}.pane{padding:12px 14px;font:11px/1.6 "SF Mono",Menlo,"Hiragino Sans",monospace;color:#c9ccd1}
  .cmd{color:#8a9099;margin-bottom:10px}.dir{color:#7fb0d9}.pr{color:#8a9099}
  .u{color:#e8e9eb;margin:4px 0 8px}.a,.i,.d{color:#b4b9c0;white-space:nowrap}.i{padding-left:2ch}.d{padding-left:5ch}.q{color:#f0c46a;white-space:pre;margin-top:14px}
  .cursor{margin-top:10px}.cursor i{display:inline-block;width:7px;height:13px;background:#c9ccd1;vertical-align:-2px}
  .win{position:absolute;${win.left != null ? `left:${win.left}px` : "right:20px"};top:${win.top ?? Math.round((size.h - win.h) / 2)}px;width:${win.w}px;height:${win.h}px}
  .glass{position:absolute;inset:0;border-radius:12px;${fade ? "display:none;" : "backdrop-filter:blur(22px) saturate(1.2);box-shadow:0 22px 50px rgba(0,0,0,.45),0 0 0 .5px rgba(0,0,0,.55);"}}
  .win iframe{position:absolute;inset:0;border:0;width:100%;height:100%;background:transparent;border-radius:12px}
  </style></head><body>
  <div class="term"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
  <div class="tabs">${tabs}</div><div class="view">${pane(lang)}</div></div>
  <div class="win"><div class="glass"></div><iframe src="${url}"></iframe></div>
  </body></html>`;
}
