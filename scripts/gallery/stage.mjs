// The stage for shoot.mjs: a desktop with a terminal, and the Tomarigi mock in a frame on top. The terminal's tabs run
// four agents (one per bird); the open tab shows the blog session, whose question matches the blog bird's bubble.
// The terminal reaches past the window's right and bottom edges, so no terminal edge shows through the frosted glass
const TABS = [
  ["blog", "claude"],
  ["tomarigi", "codex"],
  ["figma-adapter", "gemini"],
  ["moh-tech-net", "opencode"],
];

// The blog session's conversation. It runs down the whole pane, so in the first image (window at rest) the birds and
// their bubbles sit over its text. The plan's lines ("i", and "d" for an item's second line) are long enough to run past
// all three birds on both sides
const LINES = {
  en: [
    ["u", "Sum up the changes since v0.3"],
    ["a", "I looked at the 42 commits since the v0.3 tag."],
    ["a", "Three new features and five fixes. They are in CHANGELOG.md."],
    ["i", "New: summaries in the bubbles, indented sessions in the perch, Recent activity"],
    ["i", "Fixed: five bugs people reported on GitHub"],
    ["u", "Write the v0.4 release post"],
    ["a", "I read CHANGELOG.md and the images in docs/images/. I'll write it in four parts:"],
    ["i", "1. What's new: when a session stops, its bird's bubble says in one line"],
    ["d", "what it last did, in the app's language. The five fixes go in a list."],
    ["i", "2. Screenshots: the garden at rest, where only the birds float over your"],
    ["d", "terminal, and the perch, which lists every session with its state."],
    ["i", "3. How to update: choose Check for Updates from the menu bar icon. The"],
    ["d", "settings and the birds' places carry over, so nothing is set up again."],
    ["i", "4. Thanks: name the people who reported bugs on GitHub, those who said"],
    ["d", "it's OK, and link each fix in the list to the issue it came from."],
    ["a", "The post opens with the garden shot, since it shows the bubble summaries best."],
    ["a", "It goes in src/content/posts/tomarigi-v0-4.md, with the two images."],
    ["a", "When the draft is done, I'll open a pull request so you can read it first."],
    ["q", "Approve this plan?"],
  ],
  ja: [
    ["u", "v0.3 からの変更をまとめて"],
    ["a", "v0.3 のタグから今までの 42 件のコミットを見ました。"],
    ["a", "新しい機能が 3 つ、直したことが 5 つ。CHANGELOG.md に書きました。"],
    ["i", "新しい機能: 吹き出しの要約、止まり木の字下げ、最近の動きの並び"],
    ["i", "直したこと: GitHub で報告してもらった不具合 5 つ"],
    ["u", "v0.4 のお知らせ記事を書いて"],
    ["a", "CHANGELOG.md と docs/images/ の画像を読みました。記事は 4 つの節に分けて書きます:"],
    ["i", "1. 変わったこと: 作業が止まったセッションの鳥の吹き出しに、最後にしたことを"],
    ["d", "1 行で出す。言葉はアプリの表示に合わせる。直したこと 5 つは最後に箇条書き。"],
    ["i", "2. 画面: にわと止まり木のスクショ。にわは透明のときの 1 枚で、鳥と吹き出しだけが"],
    ["d", "端末の上に浮かぶところ。止まり木は全部のセッションを 1 列で見るところ。"],
    ["i", "3. 更新のしかた: メニューバーのアイコンから「アップデートを確認」を選んでもらう。"],
    ["d", "設定と鳥の置き場所は引き継がれるので、更新のあとに設定し直さなくてよい。"],
    ["i", "4. お礼: GitHub で不具合を報告してくれた方へ。載せてよいと言われた方の名前を"],
    ["d", "書き、直したことの箇条書きの各項目から、それぞれの issue へリンクを張る。"],
    ["a", "書き出しは、吹き出しの要約がいちばん伝わるように、にわのスクショから始めます。"],
    ["a", "記事は src/content/posts/tomarigi-v0-4.md に、画像 2 枚と一緒に置きます。"],
    ["a", "下書きができたら、公開の前に読んでもらえるよう、プルリクエストにして知らせます。"],
    ["q", "この計画で進めてよいですか？"],
  ],
};

// The stage's size in CSS px (shoot.mjs shoots it at 3.33x). Tall enough for Perch and Recent activity to show every row
export const STAGE = { w: 762, h: 570 };

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
  .term{position:absolute;left:16px;top:12px;width:740px;height:${STAGE.h}px;background:#17191d;border-radius:10px;
    box-shadow:0 18px 40px rgba(0,0,0,.35),0 0 0 .5px rgba(0,0,0,.7);overflow:hidden}
  .bar{height:28px;display:flex;align-items:center;gap:8px;padding:0 12px;background:#202328}
  .bar i{width:12px;height:12px;border-radius:50%;display:block}
  .tabs{display:flex;background:#202328;border-bottom:1px solid #000;font:11px/1 -apple-system,sans-serif;color:#8a9099}
  .tab{flex:1;text-align:center;padding:7px 4px;border-left:1px solid #000;white-space:nowrap;overflow:hidden}
  .tab.on{background:#17191d;color:#d6d9de}
  .view{height:100%;overflow:hidden}.pane{padding:14px 16px;font:12px/1.65 "SF Mono",Menlo,"Hiragino Sans",monospace;color:#c9ccd1}
  .cmd{color:#8a9099;margin-bottom:10px}.dir{color:#7fb0d9}.pr{color:#8a9099}
  .u{color:#e8e9eb;margin:4px 0 8px}.a,.i,.d{color:#b4b9c0;white-space:nowrap}.i{padding-left:2ch}.d{padding-left:5ch}.q{color:#f0c46a;white-space:pre}
  .cursor{margin-top:12px}.cursor i{display:inline-block;width:7px;height:14px;background:#c9ccd1;vertical-align:-2px}
  .win{position:absolute;${win.left != null ? `left:${win.left}px` : "right:20px"};top:${win.top ?? Math.round((STAGE.h - win.h) / 2)}px;width:${win.w}px;height:${win.h}px}
  .glass{position:absolute;inset:0;border-radius:12px;${fade ? "display:none;" : "backdrop-filter:blur(22px) saturate(1.2);box-shadow:0 22px 50px rgba(0,0,0,.45),0 0 0 .5px rgba(0,0,0,.55);"}}
  .win iframe{position:absolute;inset:0;border:0;width:100%;height:100%;background:transparent;border-radius:12px}
  </style></head><body>
  <div class="term"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
  <div class="tabs">${tabs}</div><div class="view">${pane(lang)}</div></div>
  <div class="win"><div class="glass"></div><iframe src="${url}"></iframe></div>
  </body></html>`;
}
