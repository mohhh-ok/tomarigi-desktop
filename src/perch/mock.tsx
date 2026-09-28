import { useCallback, useRef, useState } from "react";
import type { SessionEvent, SessionView } from "@/lib/sessions";
import type { PerchSource } from "./source";

// mock 用の固定基準時刻。formatEventTime は Date にかけるため、
// 実時刻を使うとスクリーンショットのたびに秒表示がぶれる。決め打ちで安定させる。
export const BASE = new Date("2026-07-30T14:00:00").getTime();

export interface Preset {
  id: string;
  label: string;
  build: () => { sessions: SessionView[]; events: SessionEvent[] };
}

export const PRESETS: Preset[] = [
  {
    id: "empty",
    label: "empty",
    build: () => ({ sessions: [], events: [] }),
  },
  {
    id: "mix",
    label: "3状態ミックス",
    build: () => ({
      sessions: [
        {
          id: "mock/mix/working",
          project: "tomarigi",
          slug: "tomarigi",
          state: "working",
          sinceMs: 3_000,
          toolName: "Edit",
        },
        {
          id: "mock/mix/attention",
          project: "blog",
          slug: "blog",
          state: "working",
          sinceMs: 42_000,
          toolName: "Bash",
        },
        {
          id: "mock/mix/done",
          project: "figma-adapter",
          slug: "figma-adapter",
          state: "done",
          sinceMs: 90_000,
        },
        {
          id: "mock/mix/dozing",
          project: "sandbox",
          slug: "sandbox",
          state: "dozing",
          sinceMs: 22 * 60_000,
        },
      ],
      events: [],
    }),
  },
  {
    id: "chicks",
    label: "ひな入り",
    build: () => ({
      sessions: [
        {
          id: "mock/chicks/parent-a",
          project: "tomarigi",
          slug: "tomarigi",
          state: "working",
          sinceMs: 2_000,
          toolName: "Edit",
          chicks: [
            { id: "mock/chicks/parent-a/c1", name: "Explore", state: "working", sinceMs: 4_000, toolName: "Grep" },
            // 長時間 Bash でも working のまま止まる例(許可待ち疑いの推測は廃止済み)
            { id: "mock/chicks/parent-a/c2", name: "code-reviewer", state: "working", sinceMs: 5 * 60_000, toolName: "Bash" },
            { id: "mock/chicks/parent-a/c3", name: "Plan", state: "done", sinceMs: 60_000 },
          ],
        },
        {
          id: "mock/chicks/parent-b",
          project: "blog",
          slug: "blog",
          state: "working",
          sinceMs: 55_000,
          toolName: "WebFetch",
          chicks: [
            { id: "mock/chicks/parent-b/c1", name: "researcher", state: "dozing", sinceMs: 6 * 60_000 },
          ],
        },
      ],
      events: [],
    }),
  },
  {
    id: "events",
    label: "イベントフィード",
    build: () => {
      const sessions: SessionView[] = [
        {
          id: "mock/events/tomarigi-a",
          project: "tomarigi",
          slug: "tomarigi",
          state: "working",
          sinceMs: 20_000,
          toolName: "Edit",
          snippet: "UI mock 追加",
        },
        {
          id: "mock/events/tomarigi-b",
          project: "tomarigi",
          slug: "tomarigi",
          state: "working",
          sinceMs: 5_000,
          toolName: "Bash",
          snippet: "pnpm build 確認",
        },
        {
          id: "mock/events/blog",
          project: "blog",
          slug: "blog",
          state: "done",
          sinceMs: 4 * 60_000,
        },
      ];
      // カード化検証用: 同じ sessionId で複数イベントが並ぶ状況を再現する。
      // events は「新しい順」で来る前提(lib/sessions.ts の deriveSessionEvents)
      const events: SessionEvent[] = [
        // tomarigi-a: waiting ← started (2件)
        { key: "ev1", sessionId: "s1", project: "tomarigi", snippet: "UI mock 追加", type: "waiting", at: BASE - 15_000 },
        { key: "ev2", sessionId: "s1", project: "tomarigi", snippet: "UI mock 追加", type: "started", at: BASE - 90_000 },
        // tomarigi-b: started(1件のみ)
        { key: "ev5", sessionId: "s2", project: "tomarigi", snippet: "pnpm build 確認", type: "started", at: BASE - 45_000 },
        // blog: done ← waiting ← started (3件)
        { key: "ev6", sessionId: "s3", project: "blog", type: "done", at: BASE - 2 * 60_000 },
        { key: "ev7", sessionId: "s3", project: "blog", type: "waiting", at: BASE - 4 * 60_000 },
        { key: "ev8", sessionId: "s3", project: "blog", snippet: "記事の校正", type: "started", at: BASE - 6 * 60_000 },
        // figma-adapter: waiting(1件のみ)
        { key: "ev10", sessionId: "s5", project: "figma-adapter", type: "waiting", at: BASE - 7 * 60_000 },
        // old-project: closed(古め、カード数上限に落ちるか確認できる)
        { key: "ev11", sessionId: "s7", project: "old-project", type: "closed", at: BASE - 20 * 60_000 },
      ];
      return { sessions, events };
    },
  },
  {
    id: "crowd",
    label: "満員",
    build: () => ({
      sessions: [
        { id: "mock/crowd/1", project: "tomarigi", slug: "tomarigi", state: "working", sinceMs: 2_000, toolName: "Edit" },
        { id: "mock/crowd/2", project: "blog", slug: "blog", state: "working", sinceMs: 12_000, toolName: "Read" },
        { id: "mock/crowd/3", project: "moh-tech-net", slug: "moh-tech-net", state: "working", sinceMs: 40_000, toolName: "Bash" },
        { id: "mock/crowd/4", project: "figma-adapter", slug: "figma-adapter", state: "working", sinceMs: 70_000, toolName: "WebFetch" },
        { id: "mock/crowd/5", project: "docs-migration", slug: "docs-migration", state: "done", sinceMs: 80_000 },
        { id: "mock/crowd/6", project: "cloudflare-lab", slug: "cloudflare-lab", state: "done", sinceMs: 3 * 60_000 },
        { id: "mock/crowd/7", project: "old-experiment", slug: "old-experiment", state: "dozing", sinceMs: 18 * 60_000 },
      ],
      events: [
        { key: "cev1", sessionId: "s1", project: "tomarigi", type: "started", at: BASE - 30_000 },
        { key: "cev2", sessionId: "s2", project: "moh-tech-net", type: "waiting", at: BASE - 60_000 },
      ],
    }),
  },
  {
    // 返事待ちの「?」(lib/jev.ts の needsAnswer)。機械判定の waiting と、done / dozing を
    // Jev が asking と判定したもの。not_asking・pending の鳥には付かないことも並べて見せる
    id: "asking",
    label: "返事待ち(?)",
    build: () => ({
      sessions: [
        {
          id: "mock/asking/tool",
          project: "tomarigi",
          slug: "tomarigi",
          state: "waiting",
          sinceMs: 40_000,
          toolName: "AskUserQuestion",
          snippet: "設定画面の配置",
        },
        {
          id: "mock/asking/text",
          project: "blog",
          slug: "blog",
          state: "done",
          sinceMs: 90_000,
          snippet: "見出しの案を出して",
          // 最近の動きで同じターンの done(aev2)に判定を結び付けるため、at を aev2 と揃える
          reply: { at: BASE - 90_000, text: "見出しの案を 3 つ出しました。どれにしますか。" },
          ask: { status: "asking", probability: 0.95 },
        },
        {
          // 要約用のキーが無い状態で Jev が返事待ちと判定した鳥(summary を持たない)。吹き出しには最後の応答文の
          // 最後の 1 文が出る(箇条書きとコードブロックの後の質問)
          id: "mock/asking/review",
          project: "review-bot",
          slug: "review-bot",
          state: "done",
          sinceMs: 45_000,
          snippet: "差分のレビュー",
          reply: {
            at: BASE - 45_000,
            text: "次の 3 つを直しました。\n- 型の誤り\n- 余白\n- 文言\n\n```ts\nconst a = 1;\n```\n\n**push してよいですか？**",
          },
          ask: { status: "asking", probability: 0.91 },
        },
        {
          id: "mock/asking/finished",
          project: "moh-tech-net",
          slug: "moh-tech-net",
          state: "done",
          sinceMs: 2 * 60_000,
          snippet: "README の誤字",
          ask: { status: "not_asking", probability: 0.06 },
        },
        {
          id: "mock/asking/pending",
          project: "figma-adapter",
          slug: "figma-adapter",
          state: "done",
          sinceMs: 10_000,
          ask: { status: "pending" },
        },
        {
          id: "mock/asking/working",
          project: "docs-migration",
          slug: "docs-migration",
          state: "working",
          sinceMs: 3_000,
          toolName: "Edit",
        },
        {
          id: "mock/asking/dozing",
          project: "cloudflare-lab",
          slug: "cloudflare-lab",
          state: "dozing",
          sinceMs: 12 * 60_000,
          ask: { status: "asking", probability: 0.88 },
        },
      ],
      events: [
        { key: "aev1", sessionId: "mock/asking/tool", project: "tomarigi", type: "waiting", at: BASE - 40_000 },
        { key: "aev2", sessionId: "mock/asking/text", project: "blog", type: "done", at: BASE - 90_000 },
        { key: "aev4", sessionId: "mock/asking/review", project: "review-bot", type: "done", at: BASE - 45_000 },
        // 「?」の付かない鳥の下には今までどおり印が出る(比較用)
        { key: "aev3", sessionId: "mock/asking/finished", project: "moh-tech-net", type: "done", at: BASE - 2 * 60_000 },
      ],
    }),
  },
  {
    // 鳥のセリフの吹き出し(perch/bubble.tsx)。質問ツールの質問文・計画の承認・BYOK の要約(summary を
    // データで持たせるのでキー無しでも出る)。working には出ない。長い文は「…」で切れる
    id: "bubble",
    label: "吹き出し",
    build: () => ({
      sessions: [
        {
          id: "mock/bubble/ask-tool",
          project: "tomarigi",
          slug: "tomarigi",
          state: "waiting",
          sinceMs: 30_000,
          toolName: "AskUserQuestion",
          snippet: "設定画面の配置",
          question: "設定画面の配置は右上にまとめるか下部にタブで分けるか、どちらにしますか？",
        },
        {
          id: "mock/bubble/plan",
          project: "blog",
          slug: "blog",
          state: "waiting",
          sinceMs: 70_000,
          toolName: "ExitPlanMode",
        },
        {
          id: "mock/bubble/ask-text",
          project: "figma-adapter",
          slug: "figma-adapter",
          state: "done",
          sinceMs: 20_000,
          reply: { at: BASE - 20_000, text: "見出しの案を 2 つ出しました。A と B のどちらにしますか。" },
          ask: { status: "asking", probability: 0.93 },
          summary: "見出しは A と B のどちら？",
        },
        {
          id: "mock/bubble/done",
          project: "moh-tech-net",
          slug: "moh-tech-net",
          state: "done",
          sinceMs: 2 * 60_000,
          reply: { at: BASE - 2 * 60_000, text: "README の誤字を直しました。" },
          ask: { status: "not_asking", probability: 0.06 },
          summary: "README の誤字を直した",
        },
        {
          id: "mock/bubble/working",
          project: "docs-migration",
          slug: "docs-migration",
          state: "working",
          sinceMs: 3_000,
          toolName: "Edit",
        },
        {
          id: "mock/bubble/dozing",
          project: "cloudflare-lab",
          slug: "cloudflare-lab",
          state: "dozing",
          sinceMs: 9 * 60_000,
          reply: { at: BASE - 9 * 60_000, text: "..." },
          ask: { status: "not_asking", probability: 0.1 },
          summary: "Workers のビルド設定を更新した",
        },
      ],
      events: [
        { key: "bev1", sessionId: "mock/bubble/ask-tool", project: "tomarigi", type: "waiting", at: BASE - 30_000 },
        { key: "bev2", sessionId: "mock/bubble/ask-text", project: "figma-adapter", type: "done", at: BASE - 20_000 },
        { key: "bev3", sessionId: "mock/bubble/done", project: "moh-tech-net", type: "done", at: BASE - 2 * 60_000 },
        { key: "bev4", sessionId: "mock/bubble/plan", project: "blog", type: "waiting", at: BASE - 70_000 },
      ],
    }),
  },
  {
    // 見守り中(docs/design.md)。親 tomarigi が 3 つのセッションに作業を任せて待っている。
    // packages/api は作業中、apps/web は質問ツールで返事待ち(親にも「?」が伝わる)、other-docs は完了
    // (配下でないのでフォルダ名で呼ぶ)。blog はつながりの無い鳥
    id: "watching",
    label: "見守り中",
    build: () => {
      const parent = "mock/watch/parent";
      const api = "mock/watch/api";
      const web = "mock/watch/web";
      const docs = "mock/watch/docs";
      const root = "/Users/me/Dev/tomarigi";
      return {
        sessions: [
          {
            id: parent,
            project: "tomarigi",
            slug: "tomarigi",
            state: "done",
            sinceMs: 4 * 60_000,
            cwd: root,
            startedAt: BASE - 60 * 60_000,
            watching: 2,
            peers: [
              { sessionId: "api", viewId: api, name: "tomarigi-api", cwd: `${root}/packages/api`, active: true },
              { sessionId: "web", viewId: web, name: "tomarigi-web", cwd: `${root}/apps/web`, active: true },
              { sessionId: "docs", viewId: docs, name: "other-docs", cwd: "/Users/me/Dev/other-docs", active: false },
            ],
          },
          {
            id: api,
            project: "api",
            slug: "api",
            state: "working",
            sinceMs: 3_000,
            toolName: "Edit",
            cwd: `${root}/packages/api`,
            startedAt: BASE - 30 * 60_000,
            peers: [{ sessionId: "parent", viewId: parent, name: "tomarigi-ed", cwd: root, active: false }],
          },
          {
            id: web,
            project: "web",
            slug: "web",
            state: "waiting",
            sinceMs: 50_000,
            toolName: "AskUserQuestion",
            question: "ボタンの色は緑と青のどちらにしますか？",
            cwd: `${root}/apps/web`,
            startedAt: BASE - 25 * 60_000,
            peers: [{ sessionId: "parent", viewId: parent, name: "tomarigi-ed", cwd: root, active: false }],
          },
          {
            id: docs,
            project: "other-docs",
            slug: "other-docs",
            state: "done",
            sinceMs: 2 * 60_000,
            cwd: "/Users/me/Dev/other-docs",
            startedAt: BASE - 20 * 60_000,
            peers: [{ sessionId: "parent", viewId: parent, name: "tomarigi-ed", cwd: root, active: false }],
          },
          { id: "mock/watch/blog", project: "blog", slug: "blog", state: "done", sinceMs: 6 * 60_000 },
        ],
        events: [
          { key: "wev1", sessionId: web, project: "web", type: "waiting", at: BASE - 50_000 },
          { key: "wev2", sessionId: docs, project: "other-docs", type: "done", at: BASE - 2 * 60_000 },
        ],
      };
    },
  },
  {
    // 見守り中で、親と同じフォルダの鳥がいる(docs/design.md「ブロックで囲んだときは名前を 1 つにする」)。
    // 同じフォルダの鳥は名前を出さない。apps/frontend/web は深い配下(相対パスの長さを見る用)
    id: "watching-same",
    label: "見守り(同じフォルダ)",
    build: () => {
      const parent = "mock/watch-same/parent";
      const same = "mock/watch-same/same";
      const deep = "mock/watch-same/deep";
      const root = "/Users/me/Dev/tomarigi";
      const back = [{ sessionId: "parent", viewId: parent, name: "tomarigi", cwd: root, active: false }];
      return {
        sessions: [
          {
            id: parent,
            project: "tomarigi",
            slug: "tomarigi",
            state: "done",
            sinceMs: 5 * 60_000,
            cwd: root,
            startedAt: BASE - 60 * 60_000,
            watching: 2,
            peers: [
              { sessionId: "same", viewId: same, name: "tomarigi", cwd: root, active: true },
              { sessionId: "deep", viewId: deep, name: "web", cwd: `${root}/apps/frontend/web`, active: true },
            ],
          },
          {
            id: same,
            project: "tomarigi",
            slug: "tomarigi",
            state: "working",
            sinceMs: 12_000,
            toolName: "Bash",
            cwd: root,
            startedAt: BASE - 30 * 60_000,
            peers: back,
          },
          {
            id: deep,
            project: "web",
            slug: "web",
            state: "done",
            sinceMs: 40_000,
            summary: "ヘッダーの余白を直しました",
            cwd: `${root}/apps/frontend/web`,
            startedAt: BASE - 20 * 60_000,
            peers: back,
          },
          { id: "mock/watch-same/blog", project: "blog", slug: "blog", state: "done", sinceMs: 6 * 60_000 },
        ],
        events: [],
      };
    },
  },
  {
    // Jev に実際に聞く(ask をデータで持たない)。保存した TypeSafe のキーで判定が動くかを確かめる用。
    // 判定結果はログ(/tmp/tomarigi-desktop/app-log.txt の [jev])と鳥の「?」に出る
    id: "jev-live",
    label: "Jev 実判定",
    build: () => ({
      sessions: [
        {
          id: "mock/jev/asking",
          project: "jev-asking",
          slug: "jev-asking",
          state: "done",
          sinceMs: 30_000,
          reply: { at: BASE - 30_000, text: "設定画面の配置案を 2 つ用意しました。A: 右上にまとめる B: 下部にタブで分ける。どれにしますか。" },
        },
        {
          id: "mock/jev/finished",
          project: "jev-finished",
          slug: "jev-finished",
          state: "done",
          sinceMs: 60_000,
          reply: { at: BASE - 60_000, text: "ボタンの色を修正し、型チェックとビルドが通ることを確認しました。完了しました。" },
        },
      ],
      events: [],
    }),
  },
];

export const DEFAULT_PRESET = PRESETS[1];

// 起動時のプリセット。?preset=<id>(TOMARIGI_QUERY="preset=asking" 等)で選べる。スクショ確認用
const INITIAL_PRESET =
  PRESETS.find((p) => p.id === new URLSearchParams(location.search).get("preset")) ?? DEFAULT_PRESET;

export interface MockData {
  sessions: SessionView[];
  events: SessionEvent[];
}

export interface MockSource extends PerchSource {
  getData(): MockData;
  setData(next: MockData): void;
}

// scan() は毎ポーリング(3秒ごと)呼ばれる。brokenIds は mock に「壊れたルート」概念が
// 無いため常に空配列で足りるが、毎回 [] を新規生成すると App.tsx 側の setBrokenIds が
// 参照の変わった配列を受け取り続け、値が同じでも再レンダーが毎ポーリング起き続けてしまう
// (Garden の motion/AnimatePresence ツリーに波及する)。モジュール定数として1つに固定する。
const NO_BROKEN: string[] = [];

/** PerchSource 実装 + MockPanel が使う操作 API を1つに束ねたインスタンスを作る。
 * main.tsx がこれを1つ生成して App と MockPanel の両方に渡すことで、
 * パネルでの編集が(App.tsx 側の subscribe 経由で)即座に反映される */
export function createMockSource(): MockSource {
  let data: MockData = INITIAL_PRESET.build();
  const listeners = new Set<() => void>();

  return {
    usesRoots: false,
    async scan() {
      // 現在の sessions/events をそのまま返す(コピーしない)。setData 以外でこの参照が
      // 変わることは無いため、App.tsx 側は値が変わらない限り同じ配列参照を受け取り続ける
      return { views: data.sessions, brokenIds: NO_BROKEN, events: data.events };
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getData() {
      return data;
    },
    setData(next) {
      data = next;
      for (const cb of listeners) cb();
    },
  };
}

export function MockPanel({ source }: { source: MockSource }) {
  const [presetId, setPresetId] = useState<string>(INITIAL_PRESET.id);
  const [draft, setDraft] = useState<string>(() => JSON.stringify(INITIAL_PRESET.build(), null, 2));
  const [parseError, setParseError] = useState<string | null>(null);

  const applyPreset = useCallback(
    (id: string) => {
      const preset = PRESETS.find((p) => p.id === id) ?? DEFAULT_PRESET;
      const next = preset.build();
      setPresetId(preset.id);
      source.setData(next);
      setDraft(JSON.stringify(next, null, 2));
      setParseError(null);
    },
    [source],
  );

  const applyDraft = useCallback(() => {
    try {
      const parsed = JSON.parse(draft);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.events)) {
        setParseError("sessions と events(配列)を含む JSON にしてください");
        return;
      }
      source.setData({ sessions: parsed.sessions, events: parsed.events });
      setParseError(null);
    } catch (e) {
      setParseError(String((e as Error).message ?? e));
    }
  }, [draft, source]);

  // にわのアニメーション確認用: 鳥の出入りを手で起こす。
  // 追加=上空から入場 / 寝かす=巣箱へ / 起こす=巣箱から / 閉じる=フェード
  const mockBirdSeq = useRef(0);
  const addBird = useCallback(() => {
    const n = ++mockBirdSeq.current;
    const d = source.getData();
    source.setData({
      ...d,
      sessions: [
        ...d.sessions,
        { id: `mock/anim/${n}`, project: `new-bird-${n}`, slug: `new-bird-${n}`, state: "working", sinceMs: 1_000 },
      ],
    });
  }, [source]);
  const sleepBird = useCallback(() => {
    const d = source.getData();
    const target = d.sessions.find((s) => s.state !== "dozing");
    if (!target) return;
    source.setData({
      ...d,
      sessions: d.sessions.map((s) => (s.id === target.id ? { ...s, state: "dozing" as const } : s)),
    });
  }, [source]);
  const wakeBird = useCallback(() => {
    const d = source.getData();
    const target = d.sessions.find((s) => s.state === "dozing");
    if (!target) return;
    source.setData({
      ...d,
      sessions: d.sessions.map((s) => (s.id === target.id ? { ...s, state: "working" as const } : s)),
    });
  }, [source]);
  const closeBird = useCallback(() => {
    const d = source.getData();
    const target = [...d.sessions].reverse().find((s) => s.state !== "dozing");
    if (!target) return;
    source.setData({ ...d, sessions: d.sessions.filter((s) => s.id !== target.id) });
  }, [source]);

  const hint =
    "sessions[].state: working | waiting | done | dozing\n" +
    "sessions[].ask: { status: pending | asking | not_asking | error, probability? }\n" +
    "sessions[].question / summary: 吹き出しの文\n" +
    "sessions[].peers / watching: 見守り中のつながりと動いている相手の数\n" +
    "events[].type: started | done | waiting | closed";

  return (
    <section className="mock-panel">
      <h2>mock コントロール</h2>
      {/* にわのアニメーション確認: 出入りイベントを手で起こす */}
      <div className="mock-preset-row">
        <button className="small" onClick={addBird}>
          + 鳥を追加(上空から)
        </button>
        <button className="small" onClick={sleepBird}>
          1羽寝かす(巣箱へ)
        </button>
        <button className="small" onClick={wakeBird}>
          1羽起こす(巣箱から)
        </button>
        <button className="small" onClick={closeBird}>
          1羽閉じる(フェード)
        </button>
      </div>
      <div className="mock-preset-row">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            className={`small ${p.id === presetId ? "mock-preset-active" : ""}`}
            onClick={() => applyPreset(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="mock-hint">{hint}</p>
      <textarea
        className="mock-editor"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        rows={16}
      />
      <div className="mock-editor-actions">
        <button className="small" onClick={applyDraft}>
          JSON を反映
        </button>
        {parseError && <span className="mock-error">{parseError}</span>}
      </div>
    </section>
  );
}
