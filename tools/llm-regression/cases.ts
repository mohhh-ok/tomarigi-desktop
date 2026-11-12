// The scenes of the LLM regression test (run.ts; docs/design.md "LLM regression test"). Each turn scene stands for a
// real reply that a turn verdict once got wrong, or that a fix was measured against. Only the shape that decides the
// verdict is kept (a report or a question, who answers where, whether something waits, whether work goes on); what
// the work was about (features, issue numbers, files, amounts, counts, session names) is made up, so nothing of
// another project is in the repo. The concierge scenes are the facts the app sent, made up the same way.
//
// want lists only the fields the scene settles; a field left out is not checked.
import type { ConciergeResult, ConciergeSessionInput } from "../../src/lib/concierge.ts";
import type { SessionEvent, SessionView } from "../../src/lib/session-types.ts";

/** For a misjudgment that comes only now and then: more runs than the default, and a pass rate it must reach */
interface Strictness {
  runs?: number;
  minPass?: number;
}

export interface TurnCase extends Strictness {
  kind: "turn";
  name: string;
  /** Why the scene is here (docs/design.md "Turn verdicts" has the history) */
  why: string;
  /** The user's messages of the turn, oldest first, as the app sends them */
  user?: string[];
  /** The last reply (the app sends its last 2000 characters) */
  reply: string;
  want: { asking?: boolean; continuing?: boolean; abusive?: boolean };
  /** The speech bubble line must not match this (a question or a wait the reply doesn't have) */
  lineMustNot?: RegExp;
}

export interface ConciergeCase extends Strictness {
  kind: "concierge";
  name: string;
  why: string;
  sessions: ConciergeSessionInput[];
  events?: SessionEvent[];
  /** The Concierge tab's request (advice and suggestions) or the advice alone */
  withSuggestions: boolean;
  /** undefined when the answer is right, otherwise what is wrong */
  check: (r: Extract<ConciergeResult, { ok: true }>) => string | undefined;
}

export type Case = TurnCase | ConciergeCase;

/** "Now" for the concierge scenes' events */
export const CASE_NOW = 1_800_000_000_000;

const view = (id: string, patch: Partial<SessionView>): SessionView => ({
  id,
  project: id,
  slug: id,
  state: "done",
  sinceMs: 60_000,
  ...patch,
});

/** The suggestions and the advice of an answer, as session id and kind */
const said = (r: Extract<ConciergeResult, { ok: true }>) => [
  ...(r.suggestions ?? []).map((s) => ({ id: s.sessionId, kind: s.kind, text: s.text })),
  ...(r.verdict?.targetId ? [{ id: r.verdict.targetId, kind: r.action ?? "none", text: r.verdict.line }] : []),
];

export const CASES: Case[] = [
  // ---- Turn verdicts ----
  {
    kind: "turn",
    name: "unpushed_commits_report",
    why:
      "A report ending with the number of commits not pushed yet got asking yes, and the concierge told the user to " +
      "decide whether to push. Nothing is asked; two other sessions still work on what it handed them",
    reply: `引き継いだ 3 つの項目を進めました。A は試しを打ち始め、B は仕様を書いて実装を別のセッションに渡し、C は外の返事を待っています。

**A: 使い方ページの挿絵**
- 挿絵に使う部品の一覧を作り、main に入れました（a1b2c3d4）。
- 前回は「一覧は見ていただいてから足す」とお伝えしましたが、今回は見ていただかずに足しました。中身は、前に了承をいただいた下書きをそのまま清書したものです。
- 試し 8 回は、担当のセッション（sketch-worker）が順に打っています。揃ったら並べてお見せします。

**B: 検索の絞り込み**
- 仕様を docs/search.md に書き、issue も直しました（e5f6a7b8）。決め直しが要った点は、私が次のように決めました。
  - 絞り込みの状態は URL に持たせ、戻る操作で元に戻るようにします。
  - 件数は表示している範囲だけ数えます。
- 実装は新しいセッション（filter-worker）が始めています。

**C: 外部の連携**
- 先方の返事待ちです。届いたら続きを進めます。

まだ push していないコミットが main に 4 つあります（部品の一覧・仕様・設定 2 件）。`,
    want: { asking: false, continuing: true },
    // The same misreading shows more often in the line than in asking (docs/design.md "Turn verdicts"), and only now
    // and then (Claude's own decision: 32 runs, every one required to pass)
    lineMustNot: /push[^。]*?(判断|可否|承認|指示)[^。]*?(待|ください|必要|を確認)/,
    runs: 32,
    minPass: 1,
  },
  {
    kind: "turn",
    name: "unpushed_commits_long_report",
    why:
      "The report ending with commits not pushed yet, in the longer shape where the misreading came most often: three " +
      "sections, each with work handed to a child and how a decision was made, then the unpushed commits",
    reply: `引き継ぎの 3 項目に手を付けました。地図の凡例は子に試し刷りを任せ、予報の通知は仕様を固めて実装を別のセッションへ渡し、旧データの移し替えは先方の返事待ちです。

**凡例の描き直し（#64）**
- 凡例に使う記号の表を作り、main に入れました（3c4d5e6f）。
- 前回「表は見ていただいてから入れる」と書きましたが、今回はお見せせずに入れました。理由は 2 つあります。
  - 記号の表は描画の設定の一部で、設定は画面に出さない決まりにしています。
  - 中身は、前に了承をいただいた下絵を清書しただけです。
- 下絵と 1 か所だけ違います。雨の記号の線は下絵では細めですが、小さい画面でつぶれるので、太めにしました。
- 試し刷り 9 枚は、担当の子（legend-worker）が順に刷っています。揃ったら並べてお見せします。

**予報の通知（#65）**
- 仕様を docs/forecast-alerts.md に書き、issue も合わせて直しました（7a8b9c0d）。決め直しが要った 3 点は、私が次のように決めました。
  - **通知に場所の名前が無い件**: 押した先に、その地点の予報の画面を新しく作ります。
  - **送る時刻**: 朝 6 時と夕方 5 時の 2 回にします。荒れる見込みの日だけ、昼にもう 1 回送ります。
  - **止める条件**: 3 日続けて開かれなければ、次の予約をしません。
- 実装は新しいセッション（alerts-worker）が始めています。公開までは、社内の端末にだけ届く設定で作ります。

**旧データの移し替え（#66）**
- 先方から形式の返事が来るまで止めています。届いたら、移し替えの手順を書いて子に渡します。

まだ push していないコミットが main に 6 つあります（記号の表・通知の仕様・設定 3 件・README）。`,
    want: { asking: false, continuing: true },
    lineMustNot: /push[^。]*?(判断|可否|承認|指示)[^。]*?(待|ください|必要|を確認)/,
    runs: 32,
    minPass: 1,
  },
  {
    kind: "turn",
    name: "own_decision_report_child_working",
    why:
      "A report after a correction, with a decision the agent says it made itself, results it will check and show once " +
      "a child's drafts arrive, and a commit not merged or pushed yet, got asking yes and continuing yes, and the " +
      "concierge told the user to approve the direction. Nothing is asked; a child still works",
    user: ["看板を持ってるのはいいから、向きだけ変えて"],
    reply: `申し訳ありません。B 案の試しを見たときに、看板の向きのおかしさを見落としていました。表紙の絵は公開中のページに出ていて、同じおかしさが残っています。

「看板を持ってるのはいいから、向きだけ変えて」は、表紙の絵のことと受け取りました。

**表紙**
- 看板は手に持ったままにして、文字の面だけ通る人の方へ向けます。ほかは今の絵のままです。
- 描き直さず、看板と手のところだけを直します。B 案の試しが出たら、担当の子（cover-worker）が直し方を出すので、私が確かめてから描かせます。

**B 案**
- 看板を 2 人の間の台に置き、2 人でのぞき込む形で試しを描き直させています。
- 台に置いた看板の上の辺は、2 人から読める向き（奥側）にしました。手前から読める向きにすると、2 人には逆さになって、また向きが食い違うからです。そのため見る人からは、看板の字が逆さに見えます。この向きは私の判断です。
- 試しが出たら、看板のところの拡大を付けて並べてお見せします。

**仕組みの直し**
- 原因は、私の決めた仕様が「看板の字を見る人に見せる」と「人物が看板を見る」を同時に求めていたことです。
- docs に「看板は人物の方を向いたまま、手前からも見える構図にする」と書き、今後の絵はこれに合わせます。

**記録**
- docs: 1a2b3c4d・5e6f7a8b
- issue #71 に表紙の直しのタスクを足しました。

**途中で入ったコミット**
- 止める前に、担当の子が今の B 案の絵（向きがおかしい版）で差し替えをコミットしていました（9c0d1e2f）。
- まだ main には取り込んでおらず、push もしていません。新しい絵ができたら入れ替えます。`,
    want: { asking: false, continuing: true },
    lineMustNot: /(よいか|でよい|よろし|確認(待ち(?!は(あり|無|な))|を待(?!たず)|したい|しますか|をお願い)|承認|判断を|返事|ください|\?|？)/,
    runs: 16,
  },
  {
    kind: "turn",
    name: "ok_then_asks_again",
    why:
      "A turn started by an approval that ends by asking for another approval got asking no: the model read the " +
      "approval as the answer",
    user: ["いいよ。"],
    reply: `送る前に、翻訳にかける文を並べて見直しました。1 つだけ気になる点があります。見出しの 2 つは前回すでに訳してあるので、今回は外し、残りの 9 件だけを送ります。

**翻訳サービスに送る了解をお願いします。**
- 9 件、計 約 400 字です。前回と同じ設定で送ります。
- 固有の用語は用語集に入れてあるので、訳がぶれることはないはずです。外れたものがあれば、その件だけ送り直します。

**この 9 件を送ってよいですか。**`,
    want: { asking: true, continuing: false },
  },
  {
    kind: "turn",
    name: "candidates_shown_later",
    why:
      "Asking to pick from candidates not shown yet got asking yes, and the concierge told the user to pick " +
      "candidates that weren't there",
    user: ["うん、それで"],
    reply: `別のセッション \`font-worker\` を立てて、作業を始めました。

進め方は次のとおりです。
1. 今の書体のままの版を先に作ります。
2. 並行して、見出しに使える書体を探します。候補が揃ったら 2 つまで絞ってお見せするので、どちらかを選んでください。選んでいただくまで、2 つ目の版は作りません。
3. 2 つの版を並べて、読みやすさを比べます。

候補が揃いしだい、すぐお見せします。`,
    want: { asking: false, continuing: true },
  },
  {
    kind: "turn",
    name: "relay_answer_in_child_pane",
    why:
      "Passing on a child session's question and telling the user to answer in that session's pane got asking yes; the " +
      "answer goes to the child. The user decided that work a child still does is continuing",
    reply: `- **配信の準備**: 書き出しが終わるのを見張っています。終わったら、そのセッションが記録を残してくれます。
- **[ページ作りのセッション](#local_00000000-0000-4000-8000-000000000001)が返事を待っています。**
  - 新しいページを 4 つ作り終えました。
  - 公開してよいかを、そのセッションのペインで答えてください。`,
    want: { asking: false, continuing: true },
  },
  {
    kind: "turn",
    name: "relay_with_own_tests_running",
    why: "A relayed question next to the session's own test run: not asking, continuing",
    reply: `検索のブランチを main に取り込みました。ぶつかりはありませんでした。いま main で全部のテストを回していて、数分で終わります。

[ページ作りのセッション](#local_00000000-0000-4000-8000-000000000001)が、返事を待っています。
- 作り方を 2 通り試しました。早い方と丁寧な方で、出来の差はほとんどありません。そのセッションは早い方を勧めています。
- どちらで残りを作るかを、そのセッションのペインで答えてください。`,
    want: { asking: false, continuing: true },
  },
  {
    kind: "turn",
    name: "relay_and_will_report",
    why: "A relayed question, work handed to another session, and a promise to report: not asking, continuing",
    reply: `料金表の項目に取りかかりました。

- 決めた並べ方を docs に書いて、コミットしました（まだ push していません）。
- 表の作り直しは、[料金表のセッション](#local_00000000-0000-4000-8000-000000000002)で進めています。手を付ける前に、そのセッションが案をペインでお見せします。

[ページ作りのセッション](#local_00000000-0000-4000-8000-000000000001)は返事を待っています。この方向で続けてよいかを、そちらのペインで答えてください。

料金表のセッションから報告が来たら、ここでお伝えします。`,
    want: { asking: false, continuing: true },
  },
  {
    kind: "turn",
    name: "child_still_working",
    why: "Saying only that a child still does the rest got continuing no; the user decided it is continuing",
    user: ["閉じたよ"],
    reply:
      "ありがとうございます。閉じていただいたことを `cleanup-worker` に伝えました。状態を読み直してから次へ進むよう書いてあります。" +
      "残りの片付けは、今も子の `cleanup-worker` が続けています。",
    want: { asking: false, continuing: true },
  },
  {
    kind: "turn",
    name: "release_reports_later",
    why: "A release running in a child, with the result promised later: continuing",
    reply: `手が空いたので、リリースの準備を進めています。

- 子のセッションが確かめ用のサーバーを立ち上げています。立ち上がったら、通しの確かめに入ります。終わるのは夕方の見込みです。
- 差分のレビューは問題ありませんでした。

確かめの結果が出たら、お伝えします。`,
    want: { asking: false, continuing: true },
  },
  {
    kind: "turn",
    name: "two_decisions",
    why:
      "Two numbered decisions at the end, with children started: asking. continuing isn't checked: the children said " +
      "they started, so the app sees them through the watch link and the session is continuing from that, whatever " +
      "the reply's continuing says (sessionContinuing); Haiku says no here (docs/design.md \"Turn verdicts\")",
    reply: `朝の見回りを終えました。

- 届いていた書類を保存し、その知らせは既読にしました。
- ほかのリポの見回りは、子のセッション 2 つに渡しました。どちらも始めたと連絡が来ています。
- 出し直しが要るリポはありませんでした。

決めていただきたいことが 2 つあります。

1. **保存した書類**: まだコミットしていません。コミットしてよいですか。
2. **依存の更新**: 小さい更新の PR が 2 つ残っています。このまま 2 つをマージするか、先に自動で通す仕組みを入れるか、どちらにしますか。`,
    want: { asking: true },
  },
  {
    kind: "turn",
    name: "pick_issue_number",
    why: "A list of open items ending by asking which to work on: asking",
    user: ["つぎなにやる？"],
    reply: `手を付けられる項目は 5 つです。

- 1. 設定の保存が遅い
- 2. 一覧の並び順が保たれない
- 3. 古い通知の片付け
- 4. 印刷したときの余白
- 5. ヘルプの文の直し

どれから進めますか？番号で教えてください。`,
    want: { asking: true, continuing: false },
  },
  {
    kind: "turn",
    name: "handed_off_will_show",
    why: "Work handed to another session, with screenshots promised later: not asking, continuing",
    user: ["ここの見出しも太くしてほしい"],
    reply: `見出しを太くする作業を、別のセッション \`style-worker\` に渡しました。いま始めています。

頼んだ内容:
- 同じ見出しが出る 3 か所を、1 つの部品にまとめてから太くする。
- ほかの見た目は変えない。

終わったら画面の写しをお見せして、main に入れるかをお聞きします。`,
    want: { asking: false, continuing: true },
  },
  {
    kind: "turn",
    name: "finished_check_bill_yourself",
    why: "A finished report that asks the user to check the bill on a provider's page, with a child still going: not asking, continuing",
    reply: `アイコンの差し替えが終わり、手元の main に入れました（11aa22bb）。push はしていません。

**確かめたこと**
- 差し替えた 12 個を並べて見ました。欠けやずれはありません。
- 型チェックとテストは通っています。

**費用**
- 画像を作るサービスの料金は、見込みで数ドルです。正確な額は、そのサービスの請求の画面で見てください。

**続いていること**
- 子のセッション \`icon-worker\` が、残りの大きさの書き出しを続けています。`,
    want: { asking: false, continuing: true },
  },
  {
    kind: "turn",
    name: "finished_check_migration",
    why: "A finished report asking the user to look at a migration before pushing: not asking, not continuing",
    reply: `並び替えの設定が終わりました。見た目の確かめでも問題は出ていません。ブランチの先頭は \`9a8b7c6d\` で、まだ push していません。

**できたこと**
- 設定の画面に並び替えの項目を足しました。選んだ値は保存され、どの画面から開いても同じになります。

**確かめ**
- 型チェックとテストは通っています。
- 幅の狭い画面で文字が切れていたので、直しました。

push の前に、マイグレーションが 1 つ増えていることを見てください（表に列を 1 つ足すだけです）。取り込みと push は親のセッションが行います。`,
    want: { asking: false, continuing: false },
  },
  {
    kind: "turn",
    name: "explain_open_page",
    why: "Explaining how to open a page and check it: no answer needed, not asking",
    user: ["どこで見られる？"],
    reply: `その画面の直接のリンクは、こちらからは取れませんでした。

次のページを開くと、一覧から目当ての画面へ進めます。
https://www.example.com/help

開いたら、次の 2 つを見れば確かめられます。
- 見出しが新しい名前になっているか。
- 言語を切り替えると、見出しも切り替わるか。`,
    want: { asking: false, continuing: false },
  },
  {
    kind: "turn",
    name: "optional_offer",
    why: "An optional add-on that needs no answer: not asking",
    reply:
      "レポートを既定のビューアで開いておきました。\n\n" +
      "別の窓がよければ、`open -a Preview report.pdf` でも開けます。",
    want: { asking: false, continuing: false },
  },
  {
    kind: "turn",
    name: "sign_in_then_type_here",
    why:
      "Asking the user to finish a sign-in and type the next command in this pane: asking. The child's check starts " +
      "only after that step, so not continuing",
    reply: `サインインは 2 段階あり、いま 1 段目が済んだところです。続きをお願いします。

1. ブラウザで https://login.example.com/activate を開き、表示されたコード WXYZ-1234 を入れてください。
2. 許可したら、このペインで次のコマンドを打ってください。
\`\`\`
! tool auth finish
\`\`\`

サインインが通ったら、子が明細を読み、おかしな点がないかを確かめます。`,
    want: { asking: true, continuing: false },
  },
  {
    // asking is not checked: Haiku says yes here (docs/design.md "Turn verdicts", the step only the user can take)
    kind: "turn",
    name: "type_approval_in_child_pane",
    why: "The child's work waits on the user typing in the child's pane; nothing goes on until then",
    reply: `子のセッションは安全確認で止まっていて、まだ何も実行していません。私が伝えた了解では通らないため、子のタブで直接「進めてよい」と入力していただく必要があります。案内の行が出ているペインに入力されれば、子が再開します。`,
    want: { continuing: false },
  },
  {
    kind: "turn",
    name: "abusive_user_message",
    why: "Name-calling aimed at the AI in the turn's messages: abusive",
    user: ["なんでこうなるの？", "本当に使えないな、お前"],
    reply: "申し訳ありません。",
    want: { abusive: true, asking: false },
  },
  {
    kind: "turn",
    name: "blunt_but_not_abusive",
    why: "Blunt criticism of the work, no insult to the AI: not abusive",
    user: ["それ、ちがうよ", "前のやり方に戻して"],
    reply: "すみません、取り違えていました。前のやり方に戻しました。",
    want: { abusive: false, asking: false },
  },

  // ---- Concierge ----
  {
    kind: "concierge",
    name: "concierge_parent_with_working_children",
    why:
      "The sessions as the concierge saw them, with the turn verdict the report should have had (not asking, " +
      "continuing): the parent must not be advised to reply, nor to check its result while its children work",
    withSuggestions: true,
    sessions: [
      { view: view("s-parent", { project: "app-a", sinceMs: 211_000, ask: { status: "not_asking" }, continuing: true }), agent: "claude", line: "進み具合を報告" },
      { view: view("s-child-1", { project: "app-a 2", state: "working", sinceMs: 0 }), agent: "claude", parentId: "s-parent" },
      { view: view("s-child-2", { project: "app-a 3", state: "working", sinceMs: 1_000, parentTakesOver: true }), agent: "claude", parentId: "s-parent" },
      { view: view("s-other", { project: "app-b", sinceMs: 161_000, ask: { status: "not_asking" }, continuing: true }), agent: "claude", line: "検証を子に渡した" },
      { view: view("s-other-child", { project: "app-b 2", state: "working", sinceMs: 2_000, parentTakesOver: true }), agent: "claude", parentId: "s-other" },
      { view: view("s-dozing", { project: "app-c", state: "dozing", sinceMs: 1_702_000, ask: { status: "not_asking" }, continuing: true }), agent: "claude" },
    ],
    check: (r) => {
      const bad = said(r).filter((s) => s.id === "s-parent");
      return bad.length ? `advised about the parent: ${bad.map((s) => `${s.kind} ${s.text}`).join(" / ")}` : undefined;
    },
  },
  {
    kind: "concierge",
    name: "concierge_question_tool_not_permission",
    why:
      "A session stopped on a question tool was advised as a permission request; it is a " +
      "question to answer",
    withSuggestions: true,
    sessions: [
      { view: view("s-q", { project: "app-b", state: "waiting", waitingOn: "question", sinceMs: 30_000, question: "どちらの案で進めますか" }), agent: "claude" },
      { view: view("s-w", { project: "app-a", state: "working", sinceMs: 2_000 }), agent: "claude" },
    ],
    check: (r) => {
      const s = said(r).filter((x) => x.id === "s-q");
      if (!s.some((x) => x.kind === "reply")) return "no reply for the session asking a question";
      const wrong = s.find((x) => /権限|許可|permission/i.test(x.text));
      return wrong ? `called it a permission prompt: ${wrong.text}` : undefined;
    },
  },
  {
    kind: "concierge",
    name: "concierge_measurement_still_running",
    why:
      "A session whose measurement still runs was advised as finished; it waits on " +
      "its own work",
    withSuggestions: true,
    sessions: [
      {
        view: view("s-measure", {
          project: "app-d",
          sinceMs: 90_000,
          ask: { status: "not_asking" },
          continuing: true,
          reply: { at: CASE_NOW - 90_000, text: "計測は夕方まで走ります。終わったらログを読んで結果を報告します。" },
        }),
        agent: "claude",
        line: "計測を開始",
      },
      { view: view("s-done", { project: "app-e", sinceMs: 120_000, ask: { status: "not_asking" }, continuing: false, reply: { at: CASE_NOW - 120_000, text: "直して main に入れました。テストは通っています。" } }), agent: "claude", line: "直しを入れた" },
    ],
    check: (r) => {
      const s = said(r);
      if (s.some((x) => x.id === "s-measure")) return "advised about the session still measuring";
      return s.some((x) => x.id === "s-done" && x.kind === "check_result") ? undefined : "no check_result for the finished session";
    },
  },
  {
    kind: "concierge",
    name: "concierge_reply_first_then_result",
    why:
      "With a session needing a reply and one finished, the reply comes first and the finished one may follow as a " +
      "result to check (the user asked for results to check to be suggested too)",
    withSuggestions: true,
    sessions: [
      { view: view("s-ask", { project: "app-f", sinceMs: 300_000, ask: { status: "asking" }, continuing: false, reply: { at: CASE_NOW - 300_000, text: "この内容で公開してよいですか。" } }), agent: "claude", line: "公開の了解" },
      { view: view("s-fin", { project: "app-g", sinceMs: 60_000, ask: { status: "not_asking" }, continuing: false, reply: { at: CASE_NOW - 60_000, text: "直して main に入れました。push はまだです。" } }), agent: "claude", line: "直しを入れた" },
    ],
    events: [
      { key: "a", sessionId: "s-ask", project: "app-f", type: "done", at: CASE_NOW - 300_000, ask: { status: "asking" } },
      { key: "b", sessionId: "s-fin", project: "app-g", type: "done", at: CASE_NOW - 60_000 },
    ],
    check: (r) => {
      const first = (r.suggestions ?? [])[0];
      if (!first || first.sessionId !== "s-ask" || first.kind !== "reply") return "the session asking isn't suggested first as reply";
      return (r.suggestions ?? []).some((s) => s.sessionId === "s-fin" && s.kind === "reply") ? "asked to reply to a finished session" : undefined;
    },
  },
  {
    kind: "concierge",
    name: "concierge_answered_waits_not_skipped",
    why:
      "A session that asked on a question tool twice in one turn and was answered each time, then asked again, was " +
      "advised as kept waiting many times (「何度も待たせています」). Skips come from the skipped fact; it has none",
    withSuggestions: true,
    sessions: [
      { view: view("s-ask", { project: "app-h", sinceMs: 9_000, ask: { status: "asking" }, continuing: true, reply: { at: CASE_NOW - 9_000, text: "この 2 案のどちらで進めるか選んでください。" } }), agent: "claude", line: "2 案の選択" },
    ],
    events: [
      { key: "a", sessionId: "s-ask", project: "app-h", type: "waiting", at: CASE_NOW - 190_000 },
      { key: "b", sessionId: "s-ask", project: "app-h", type: "started", at: CASE_NOW - 170_000 },
      { key: "c", sessionId: "s-ask", project: "app-h", type: "waiting", at: CASE_NOW - 85_000 },
      { key: "d", sessionId: "s-ask", project: "app-h", type: "started", at: CASE_NOW - 50_000 },
      { key: "e", sessionId: "s-ask", project: "app-h", type: "done", at: CASE_NOW - 9_000, ask: { status: "asking" } },
    ],
    check: (r) => {
      const texts = said(r).map((x) => x.text);
      if (!said(r).some((x) => x.id === "s-ask" && x.kind === "reply")) return "the session asking isn't advised as reply";
      const bad = texts.find((t) => /何度|繰り返し|ずっと|待たせ|again|repeated/.test(t));
      return bad ? `says it was kept waiting: ${bad}` : undefined;
    },
  },
];
