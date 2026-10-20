// The stage for shoot.mjs: a desktop with a terminal, and the Tomarigi mock in a frame on top. The terminal's tabs run
// four agents (one per bird); the open tab shows the blog session, whose question matches the blog bird's bubble.
// The terminal reaches past the window's right and top edges, so no terminal edge shows through the frosted glass
const TABS = [
  ["blog", "claude"],
  ["tomarigi", "codex"],
  ["figma-adapter", "gemini"],
  ["moh-tech-net", "opencode"],
];

// Short lines that run down the pane, so the first image (window at rest) shows the terminal's text behind the birds
const LINES = {
  en: [
    ["u", "Sum up the changes since v0.3"],
    ["a", "Three new features and five fixes. They are in CHANGELOG.md."],
    ["u", "Write the v0.4 release post"],
    ["a", "I'll write it in four parts:"],
    ["i", "1. What's new: summaries in the bubbles"],
    ["i", "2. Screenshots: the garden and the perch"],
    ["i", "3. How to update: from the app's menu"],
    ["i", "4. Thanks: to everyone who sent reports"],
    ["q", "Approve this plan?"],
  ],
  ja: [
    ["u", "v0.3 からの変更をまとめて"],
    ["a", "新しい機能が 3 つ、直したことが 5 つ。CHANGELOG.md に書きました。"],
    ["u", "v0.4 のお知らせ記事を書いて"],
    ["a", "4 つの節に分けて書きます:"],
    ["i", "1. 変わったこと: 吹き出しに要約が出る"],
    ["i", "2. 画面: にわと止まり木のスクショ"],
    ["i", "3. 更新のしかた: アプリのメニューから"],
    ["i", "4. お礼: 報告をくれた方へ"],
    ["q", "この計画で進めてよいですか？"],
  ],
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function pane(lang) {
  const rows = LINES[lang]
    .map(([k, t]) => (k === "u" ? `<div class="u"><span class="pr">›</span> ${esc(t)}</div>` : `<div class="${k}">${esc(t)}</div>`))
    .join("");
  return `<div class="pane"><div class="cmd"><span class="dir">~/Dev/blog</span> <span class="pr">$</span> claude</div>${rows}<div class="u cursor"><span class="pr">›</span> <i></i></div></div>`;
}

export function stage({ lang, url, win, fade }) {
  const tabs = TABS.map(([dir, cmd], i) => `<span class="tab${i === 0 ? " on" : ""}">${dir} — ${cmd}</span>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html{color-scheme:dark}html,body{margin:0;height:100%;overflow:hidden}
  body{background:#56636a;font-family:-apple-system,"Hiragino Sans",sans-serif}
  .term{position:absolute;left:16px;top:12px;width:740px;height:470px;background:#17191d;border-radius:10px;
    box-shadow:0 18px 40px rgba(0,0,0,.35),0 0 0 .5px rgba(0,0,0,.7);overflow:hidden}
  .bar{height:28px;display:flex;align-items:center;gap:8px;padding:0 12px;background:#202328}
  .bar i{width:12px;height:12px;border-radius:50%;display:block}
  .tabs{display:flex;background:#202328;border-bottom:1px solid #000;font:11px/1 -apple-system,sans-serif;color:#8a9099}
  .tab{flex:1;text-align:center;padding:7px 4px;border-left:1px solid #000;white-space:nowrap;overflow:hidden}
  .tab.on{background:#17191d;color:#d6d9de}
  .pane{padding:14px 16px;font:12px/1.65 "SF Mono",Menlo,"Hiragino Sans",monospace;color:#c9ccd1}
  .cmd{color:#8a9099;margin-bottom:10px}.dir{color:#7fb0d9}.pr{color:#8a9099}
  .u{color:#e8e9eb;margin:4px 0 8px}.a,.i{color:#b4b9c0;white-space:nowrap}.i{padding-left:2ch}.q{color:#f0c46a;white-space:pre}
  .cursor{margin-top:12px}.cursor i{display:inline-block;width:7px;height:14px;background:#c9ccd1;vertical-align:-2px}
  .win{position:absolute;${win.left != null ? `left:${win.left}px` : "right:20px"};top:${win.top ?? Math.round((456 - win.h) / 2)}px;width:${win.w}px;height:${win.h}px}
  .glass{position:absolute;inset:0;border-radius:12px;${fade ? "display:none;" : "backdrop-filter:blur(22px) saturate(1.2);box-shadow:0 22px 50px rgba(0,0,0,.45),0 0 0 .5px rgba(0,0,0,.55);"}}
  .win iframe{position:absolute;inset:0;border:0;width:100%;height:100%;background:transparent;border-radius:12px}
  </style></head><body>
  <div class="term"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
  <div class="tabs">${tabs}</div>${pane(lang)}</div>
  <div class="win"><div class="glass"></div><iframe src="${url}"></iframe></div>
  </body></html>`;
}
