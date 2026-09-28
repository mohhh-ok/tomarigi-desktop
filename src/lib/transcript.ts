import type { NativeFile } from "./native-fs";
// Claude Code transcript (~/.claude/projects/<slug>/<sessionId>.jsonl) の読み取り。
// 形式は Claude Code の内部仕様で予告なく変わりうるため、パースはこのファイルに
// 閉じ込める。Codex は lib/codex-transcript.ts の別アダプタで同じ TailInfo に変換する。

export type TailKind =
  | "user"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "closed"
  | "unknown";

export interface TailInfo {
  kind: TailKind;
  toolName?: string;
  events: TailEvent[];
  cwd?: string; // tail ウィンドウ内で最後に見つかった cwd(表示名の主方式。無ければ projectLabels にフォールバック)
  // tail 窓内で timestamp が parse できた行(classify() の分類結果とは無関係、last-prompt や
  // queue-operation 等 state 判定に使わない行種別も含む)の最大 epoch ms。1行も無ければ
  // undefined。timestamp を持たない行(last-prompt 等)や、ファイルの mtime だけが更新される
  // 事後追記(ハーネスが死んだ transcript へ数時間後に touch する既知挙動)ではこの値は動かない。
  // 状態判定(sinceMs)の時間基準は常にこちらを使う(mtime は使わない) — mtime を基準にすると
  // 事後追記のたびに終了済みセッションが「働く鳥」として再出現する実害があったための対策
  lastEventAt?: number;
  // SDK(Claude Agent SDK)経由で起動されたセッションかどうかの判定材料。tail 窓内の
  // user/assistant/attachment/system 行に付く internal フィールドから拾い、最後に見つかった値で
  // 更新する(cwd と同じ方式)。以前は user 行だけから拾っていたが、`claude -p` は user 行が
  // 先頭の1本だけで、150KB 前後の transcript では 64KB の tail 窓に入らず取れなかった
  // (2026-09-25。1ファイル内で値が混ざる例は直近300ファイルに無し)。
  // 実データで確認した値: 対話(cli)起動は "cli"、Claude Agent SDK 経由(Python)起動は
  // "sdk-py"、`claude -p` は "sdk-cli"。TS 版 SDK は "sdk-ts" 等になると推定される
  // ため、呼び出し側(lib/sessions.ts)は完全一致ではなく /^sdk/ で判定する("sdk-cli" だけは
  // 表示対象から除外する)。
  // entrypoint フィールドは internal 仕様でバージョン依存(docs/last-prompt-ghost.md 参照、
  // last-prompt レコードで前提が崩れた前例あり)。tail 窓に entrypoint 付きの行が1本も無ければ undefined
  // のまま = 呼び出し側は cli(大人)扱いに倒す(安全側フォールバック)
  entrypoint?: string;
  // 親 transcript 内で見つかった、ひな(サブエージェント)が「停止した」ことを示す確定信号。
  // key はひなの識別子(task-notification の task-id、または起動 tool_use の id=meta.json の
  // toolUseId)、value はその信号が観測された最新のタイムスタンプ(epoch ms)。
  // 同じ task-id のひなは親が resume でき、その場合は同じ jsonl に書き込みが再開されつつ
  // 同じ task-id で複数回この信号が現れうるため、常に最新の値で上書きする(lib/sessions.ts の
  // scanChicks 側で「信号後にひなの最終会話時刻(lastEventAt)が進んでいないか」を見て resume を
  // 検知し、進んでいれば信号を無効化する)。
  // ひな自身の transcript を読むとき(includeSidechain:true)にも同じロジックで計算されるが、
  // 実際に参照するのは親 tail に対してだけ(lib/sessions.ts の deriveState/scanChicks 参照)。
  chickSignals: Map<string, number>;
  // 親が run_in_background で起動したバックグラウンドタスク(Bash 等。中身が `claude -p` でも
  // 親から見れば同じ)の起動記録。key は task-id(toolUseResult.backgroundTaskId)、value は
  // 起動確認の tool_result の時刻。完了は同じ task-id の <task-notification> として
  // chickSignals に入る。起動行は数十秒で tail 窓から外れるため、台帳はスキャンをまたいで
  // lib/sessions.ts(backgroundTaskCache)が持つ
  backgroundTaskStarts: Map<string, number>;
  // セッション間メッセージ(Claude Code の cross-session messaging)でやり取りした相手の名前。
  // 送った側は SendMessage のツール呼び出しの宛先(input.to)、受けた側は isMeta の user 行の
  // origin.name(無ければ本文の <cross-session-message from-name="…">)。値はその跡の最新時刻。
  // tail 窓から外れても消えないよう、lib/sessions.ts(peerNameCache)がスキャンをまたいで持つ。
  // 見守り中(docs/design.md)のつながりの判定に使う
  peerNames: Map<string, number>;
}

// 分類できた行を時刻付きで並べたもの。遷移イベント再構成(実験機能)専用
export interface TailEvent {
  at: number; // epoch ms
  kind: TailKind;
  toolName?: string;
  // text の中身は kind によって用途が異なる:
  // - kind === "user": ユーザー発話テキスト(先頭500文字、TEXT_FIELD_LIMIT)。イベントフィードの
  //   スニペット(lib/sessions.ts の pickSnippet/formatSnippet)の入力
  // - kind === "tool_use": tool_use の input 概要(JSON.stringify、先頭500文字)。現在は
  //   直接の消費者なし(旧: 許可待ち判定の入力だったが、LLM 判定機能の削除に伴い撤去。
  //   表示・将来のデバッグ用途のために引き続き取得しておく)
  // - kind === "assistant_text": アシスタントの text ブロックを連結したもの(末尾2000文字、
  //   ASSISTANT_TEXT_LIMIT)。done 読み上げ要約(lib/summarize.ts)と最後の1文フォールバック
  //   読み上げ(lib/voice.ts)の入力なので、結論が書かれる末尾側を残す
  text?: string;
}

interface TranscriptEntry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  interruptedByShutdown?: boolean;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
  cwd?: unknown;
  entrypoint?: unknown; // user/assistant/attachment/system 行に付く internal フィールド。TailInfo.entrypoint のコメント参照
  content?: unknown; // queue-operation 行の本文(task-notification の生テキスト、文字列)。他の type では未使用
  // tool_result 系エントリに付く実行メタ情報。ひな完了信号の判定(collectChickSignals)に
  // だけ使う。isAsync:true は「Agent tool の非同期起動確認」を示し、これは起動直後に
  // 起動 tool_use と同じ tool_use_id で返ってくる(実データで確認済み)。完了ではないため
  // 除外する必要がある(除外しないとバックグラウンドひなが起動数秒後に「完了」と誤判定される)
  // backgroundTaskId は run_in_background で起動したコマンドの起動確認に付く task-id
  // (TailInfo.backgroundTaskStarts 参照)
  toolUseResult?: { isAsync?: boolean; backgroundTaskId?: string };
  // セッション間メッセージを受けた isMeta の user 行に付く送り主(kind: "peer" と name)
  origin?: { kind?: unknown; name?: unknown };
  // 作業中に届いたセッション間メッセージは attachment(queued_command)に同じ origin で記録される
  attachment?: { origin?: { kind?: unknown; name?: unknown } };
}

interface Block {
  type?: string;
  name?: string;
  text?: string;
  input?: unknown; // tool_use ブロックの入力(summarizeToolInput の入力概要生成に使う)
  tool_use_id?: string; // tool_result ブロックが対応する tool_use の id。ひな完了信号の照合に使う
}

// /clear・Ctrl+C・シャットダウンでセッションが閉じたときに残る user メッセージ。
// これを見落とすと「入力に無応答 = 立ち往生」と誤判定する
const INTERRUPTED_PREFIX = "[Request interrupted by user";

// ローカルで完結するスラッシュコマンド(/clear, /effort, /model 等)実行時、transcript に
// isMeta なしの user エントリとしてコマンドエコーが書かれる。assistant の応答は永遠に来ないため、
// 通常の user 発話として扱うと started のまま「応答待ち」に見え続ける(実測17分「応答なし」表示)。
// 実データで確認した構造(lib/transcript.ts の変更履歴参照):
// - コマンド実行結果(stdout)を持つコマンドは、その stdout が isMeta なしの user エントリの
//   テキストに `<local-command-stdout>` タグとして書かれる(例: /effort, /model)。これは
//   classify() 側で LOCAL_COMMAND_STDOUT_TAG を含むかで汎用的に検知して closed にする
// - /clear は例外: stdout が空のため、stdout は user エントリではなく type:"system" の
//   別エントリ(subtype: "local_command")に書かれ、classify() の user 分岐では届かない。
//   このケースだけは従来どおり command-name(コマンドエコー自体)を個別リストで判定する
// スキル/カスタムコマンド起動(例 /event-log)のエコーは本物のプロンプト(started の発火元)で、
// 後続の user エントリはスキル本文であり `<local-command-stdout>` を含まないため、上記どちらの
// 判定にも引っかからず通常の user 発話のまま扱われる(実データで確認済み)
const CLOSING_SLASH_COMMANDS = ["/clear"];

const LOCAL_COMMAND_STDOUT_TAG = "<local-command-stdout>";

const TAIL_BYTES = 64 * 1024;

// 巨大な1行(base64 画像等)がファイル末尾付近にあると、TAIL_BYTES(64KB)の窓がその1行の
// 内部に落ち、窓内にパースできる行(timestamp 付き行)が0本になることがある。実データで
// 観測した最大行長は 453KB(サブエージェントの Playwright スクショが tool_result に base64
// で埋まるケース)。この場合 readWindow の lastEventAt が undefined のまま返り、呼び出し側
// (lib/sessions.ts)が「最終更新が遠い過去」と誤認して done/dozing に倒してしまう実害が
// あった。対策として、窓内に timestamp 付き行が1本も取れなかったときだけ窓を倍々
// (64KB→128KB→256KB→…)に広げて読み直す。上限 MAX_TAIL_BYTES は観測した最大行長
// 453KB の約4.5倍の余裕を見て 2MB とする(実運用で観測される行より確実に大きい窓を
// 確保しつつ、上限を無くして巨大ファイル全体を読みにいく事態は避ける)。
// 通常ケース(窓内に timestamp 行がある大多数のファイル)は従来どおり TAIL_BYTES 一発で
// 済むため、性能は変わらない。
const MAX_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * ファイル末尾だけ読んで「最後に起きたこと」を分類する。
 * includeSidechain: サブエージェント transcript(全行 isSidechain: true)を
 * 読むときに true にする。既定は false(本線 transcript の従来挙動)。
 * 窓内に timestamp 付き行が1本も無かった場合(MAX_TAIL_BYTES 定数のコメント参照)は
 * 窓を倍々に広げて読み直す。ファイルサイズが小さく窓が既にファイル全体をカバーしている
 * 場合はそれ以上広げようがないため1回で確定する。
 */
export async function readTail(
  file: NativeFile,
  opts?: { includeSidechain?: boolean },
): Promise<TailInfo> {
  const includeSidechain = opts?.includeSidechain ?? false;
  const cap = Math.min(MAX_TAIL_BYTES, file.size);
  let windowBytes = TAIL_BYTES;
  let result = await readWindow(file, windowBytes, includeSidechain);
  while (result.lastEventAt === undefined && windowBytes < cap) {
    windowBytes = Math.min(windowBytes * 2, cap);
    result = await readWindow(file, windowBytes, includeSidechain);
  }
  return result;
}

/**
 * readTail の1窓ぶんの読み取り・分類本体。windowBytes は呼び出し元(readTail)が
 * リトライのたびに広げる、ファイル末尾からの読み取りバイト数。
 */
async function readWindow(
  file: NativeFile,
  windowBytes: number,
  includeSidechain: boolean,
): Promise<TailInfo> {
  const truncated = file.size > windowBytes;
  const text = await file.slice(Math.max(0, file.size - windowBytes)).text();
  const lines = text.split("\n");
  if (truncated) lines.shift(); // 先頭行は途中から読んでいる可能性がある

  let kind: TailKind = "unknown";
  let toolName: string | undefined;
  let cwd: string | undefined;
  let entrypoint: string | undefined;
  let lastEventAt: number | undefined;
  const events: TailEvent[] = [];
  const chickSignals = new Map<string, number>();
  const backgroundTaskStarts = new Map<string, number>();
  const peerNames = new Map<string, number>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // summary 等 cwd を持たない行も混ざるため、分類の成否に関わらず最後に見つかった値で更新する
    if (typeof entry.cwd === "string" && entry.cwd.startsWith("/")) cwd = entry.cwd;
    // entrypoint は user 行だけでなく assistant/attachment/system 行にも付く(TailInfo.entrypoint
    // のコメント参照)。cwd と同じく最後に見つかった値で更新する
    if (typeof entry.entrypoint === "string") entrypoint = entry.entrypoint;
    const at = parseTimestamp(entry.timestamp);
    // classify() の分類結果(next が null かどうか)とは無関係に、timestamp が parse できた
    // 全行を対象に最大値を追う(TailInfo.lastEventAt のコメント参照)。state 判定に使わない
    // 行種別(last-prompt・queue-operation 等)であっても、timestamp を持っている以上は
    // 「実際に会話があった時刻」の情報源として有効なため取りこぼさない
    if (at !== null) lastEventAt = lastEventAt === undefined ? at : Math.max(lastEventAt, at);
    // ひな完了信号は classify() の分類(state 判定用の kind/events)とは独立に集める。
    // queue-operation は classify() が state 判定用には無視する行種別だが、ひな完了信号としては
    // 唯一の情報源なのでここで別枠に拾う(kind/events を汚さない)
    if (at !== null) collectChickSignals(entry, at, chickSignals);
    // run_in_background の起動確認(TailInfo.backgroundTaskStarts のコメント参照)。
    // サブエージェントの行は classify() と同じ基準で親の台帳に入れない
    const backgroundTaskId =
      entry.type === "user" && !(entry.isSidechain && !includeSidechain)
        ? entry.toolUseResult?.backgroundTaskId
        : undefined;
    if (at !== null && typeof backgroundTaskId === "string" && backgroundTaskId) {
      backgroundTaskStarts.set(backgroundTaskId, at);
    }
    // セッション間メッセージの跡は classify()(isMeta を読み飛ばす)とは別枠に拾う
    if (at !== null && !(entry.isSidechain && !includeSidechain)) {
      for (const name of collectPeerNames(entry)) {
        peerNames.set(name, Math.max(peerNames.get(name) ?? 0, at));
      }
    }
    const next = classify(entry, includeSidechain);
    if (!next) continue;
    kind = next.kind;
    toolName = next.toolName;
    if (at !== null) events.push({ at, kind: next.kind, toolName: next.toolName, text: next.text });
  }
  return {
    kind,
    toolName,
    events,
    cwd,
    chickSignals,
    backgroundTaskStarts,
    peerNames,
    lastEventAt,
    entrypoint,
  };
}

const CROSS_SESSION_FROM_NAME = /<cross-session-message\b[^>]*\bfrom-name="([^"]+)"/g;

/** SendMessage の宛先の名前から、表示用の " [ref]" を落とす(ListAgents の書式。docs の SendMessage) */
function peerNameOf(to: string): string | undefined {
  const name = to.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  // "main"(親の会話)とエージェント id(a...-...)はセッション間のつながりではない
  if (!name || name === "main") return undefined;
  return name;
}

/**
 * 1 行から、セッション間メッセージでやり取りした相手の名前を取る(TailInfo.peerNames)。
 * 送った: assistant の SendMessage の tool_use の input.to。受けた: isMeta の user 行の origin.name
 * (kind が "peer" のとき)、無ければ本文の <cross-session-message from-name="…">。作業中に届いた分は
 * attachment(queued_command)の origin.name。src-tauri の scan_peer_names と同じ規則
 */
function collectPeerNames(entry: TranscriptEntry): string[] {
  const names: string[] = [];
  if (entry.type === "assistant") {
    for (const block of asBlocks(entry.message?.content)) {
      if (block.type !== "tool_use" || block.name !== "SendMessage") continue;
      const to = (block.input as { to?: unknown } | undefined)?.to;
      const name = typeof to === "string" ? peerNameOf(to) : undefined;
      if (name) names.push(name);
    }
  } else if (entry.type === "attachment") {
    const origin = entry.attachment?.origin;
    if (origin?.kind === "peer" && typeof origin.name === "string" && origin.name) names.push(origin.name);
  } else if (entry.type === "user" && entry.isMeta) {
    if (entry.origin?.kind === "peer" && typeof entry.origin.name === "string" && entry.origin.name) {
      names.push(entry.origin.name);
    } else {
      const content = entry.message?.content;
      const text = typeof content === "string" ? content : asBlocks(content).map((b) => b.text ?? "").join("\n");
      for (const m of text.matchAll(CROSS_SESSION_FROM_NAME)) names.push(m[1]);
    }
  }
  return names;
}

const TASK_NOTIFICATION_TAG = "<task-notification>";
const TASK_ID_PATTERN = /<task-id>([^<]+)<\/task-id>/;

/**
 * queue-operation 行・user(tool_result) 行から、ひな(サブエージェント)が停止したことを
 * 示す確定信号を拾って out に積む(key=ひなの識別子、value=そのタイムスタンプ)。
 * 呼び出し元(readTail)が計算した at(=entry.timestamp)をそのまま使う。
 */
function collectChickSignals(entry: TranscriptEntry, at: number, out: Map<string, number>): void {
  if (entry.type === "queue-operation") {
    // バックグラウンドひな完了の signal。<task-notification> はエージェントが停止する
    // たびに発火する仕様(resume すれば同じ task-id で複数回発火しうる)なので、常に最新の
    // at で上書きする。status の値は見ない(completed 以外でも「そのひなが停止した」信号
    // として扱う。詳細は TailInfo.chickSignals のコメント参照)。
    // enqueue/remove/dequeue いずれの operation でも content が入りうる(dequeue は空のことが
    // 多いが、無ければ何もしないだけで害はない)。
    // なお Bash 等のバックグラウンドコマンド完了通知(task-notification 自体は Task/Agent 専用
    // ではない)もここを通る。scanChicks 側ではひなのファイルが無いので無視され、
    // バックグラウンドタスクの完了として lib/sessions.ts の backgroundTaskCache が使う
    const content = entry.content;
    if (typeof content === "string" && content.includes(TASK_NOTIFICATION_TAG)) {
      const taskId = content.match(TASK_ID_PATTERN)?.[1];
      if (taskId) out.set(taskId, at);
    }
    return;
  }
  if (entry.type === "user") {
    // 同期呼び出し(Task/Agent のブロッキング呼び出し)完了の signal。tool_use_id がひなの
    // meta.json の toolUseId と一致する tool_result が来た時刻がそのまま完了時刻になる。
    // ただし Agent tool の非同期起動確認(toolUseResult.isAsync===true)は同じ tool_use_id で
    // 起動直後に返るが完了ではないため除外する(TranscriptEntry.toolUseResult のコメント参照)
    if (entry.toolUseResult?.isAsync) return;
    const blocks = asBlocks(entry.message?.content);
    for (const b of blocks) {
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") out.set(b.tool_use_id, at);
    }
  }
}

function parseTimestamp(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const at = Date.parse(timestamp);
  return Number.isNaN(at) ? null : at;
}

interface Classified {
  kind: TailKind;
  toolName?: string;
  text?: string;
}

function classify(entry: TranscriptEntry, includeSidechain: boolean): Classified | null {
  if (entry.isSidechain && !includeSidechain) return null; // サブエージェントの行は本線の状態に使わない
  if (entry.type === "assistant") {
    const blocks = asBlocks(entry.message?.content);
    const toolUse = blocks.findLast((b) => b.type === "tool_use");
    if (toolUse) {
      // input をそのまま送ると大きくなりうるので先頭500文字に絞る(ユーザー発話用の
      // text フィールドを流用しているだけで、中身は別物)
      return { kind: "tool_use", toolName: toolUse.name, text: summarizeToolInput(toolUse.input) };
    }
    if (blocks.some((b) => b.type === "text")) {
      return { kind: "assistant_text", text: extractAssistantText(blocks) };
    }
    return null; // thinking のみ等は状態を動かさない
  }
  if (entry.type === "user") {
    if (entry.interruptedByShutdown || isInterruptedMessage(entry.message?.content)) {
      return { kind: "closed" };
    }
    const blocks = asBlocks(entry.message?.content);
    if (blocks.some((b) => b.type === "tool_result")) return { kind: "tool_result" };
    if (entry.isMeta) return null;
    if (blocks.some((b) => b.type === "text" && b.text?.includes(LOCAL_COMMAND_STDOUT_TAG))) {
      return { kind: "closed" };
    }
    const commandName = extractCommandName(blocks);
    if (commandName && CLOSING_SLASH_COMMANDS.includes(commandName)) return { kind: "closed" };
    // スニペット表示に十分な範囲として先頭500文字に絞る(メモリ上限を兼ねる)
    return { kind: "user", text: extractUserText(blocks) };
  }
  return null; // summary / file-history-snapshot 等は無視
}

// TailEvent.text 全体で共有する上限(ユーザー発話・tool_use 入力概要の両方に使う)
const TEXT_FIELD_LIMIT = 500;

function extractUserText(blocks: Block[]): string | undefined {
  const parts = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text as string);
  if (parts.length === 0) return undefined;
  return parts.join("\n").slice(0, TEXT_FIELD_LIMIT);
}

// done 読み上げ要約(lib/summarize.ts)の材料として、ユーザー発話より緩めの上限で確保する。
// ユーザー発話用の500文字は「発言の主旨」には十分だが、要約に足るアシスタント応答の
// 分量としては短すぎるため別枠にする
const ASSISTANT_TEXT_LIMIT = 2000;

// extractUserText と構造は同じだが、打ち切りは先頭ではなく末尾N文字。用途が「何が完了したか」
// (要約入力・最後の1文のフォールバック読み上げ)なので、長い応答では結論が書かれる末尾側を
// 残さないと意味がない(先頭切りだと 2000 文字超の応答で締めの文が丸ごと落ちる)
function extractAssistantText(blocks: Block[]): string | undefined {
  const parts = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text as string);
  if (parts.length === 0) return undefined;
  return parts.join("\n").slice(-ASSISTANT_TEXT_LIMIT);
}

// スラッシュコマンド実行時のエコーから `<command-name>` の中身を取り出す。
// `<command-name>` と `<command-message>` の出現順はコマンドにより異なる(/clear は command-name が
// 先、/event-log は command-message が先)ため、先頭一致ではなく全文検索で拾う
const COMMAND_NAME_PATTERN = /<command-name>([^<]*)<\/command-name>/;

function extractCommandName(blocks: Block[]): string | undefined {
  for (const b of blocks) {
    if (b.type !== "text" || !b.text) continue;
    const match = b.text.match(COMMAND_NAME_PATTERN);
    if (match) return match[1].trim();
  }
  return undefined;
}

// tool_use の input を概要文字列化する。JSON.stringify が失敗しうる入力
// (循環参照等、実データでは想定しないが)は握りつぶす
function summarizeToolInput(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  try {
    return JSON.stringify(input).slice(0, TEXT_FIELD_LIMIT);
  } catch {
    return undefined;
  }
}

function isInterruptedMessage(content: unknown): boolean {
  if (typeof content === "string") return content.startsWith(INTERRUPTED_PREFIX);
  if (!Array.isArray(content)) return false;
  return (content as Block[]).some(
    (b) => b.type === "text" && (b.text ?? "").startsWith(INTERRUPTED_PREFIX),
  );
}

function asBlocks(content: unknown): Block[] {
  // 文字列そのまま来るケース(単純なユーザー発言)は text も詰める。以前は type だけ
  // 詰めて text を捨てていたため、ユーザー発話の入力(extractUserText)が
  // このケースで常に空になってしまっていた
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) return content as Block[];
  return [];
}

/**
 * スラッグ(パスの `/`→`-` 変換)から表示名を得る。tail から cwd が取れた
 * セッションでは使わない(主方式は basename(cwd))。cwd が取れない場合の
 * フォールバックとして、全スラッグ共通の接頭辞を剥がす方式で表示名を作る
 * (例: -Users-x-Dev-gyokan と -Users-x-Dev-ai-tools → gyokan / ai-tools)。
 * 区切りと語中のハイフンが区別できない点・ルート内にアクティブなスラッグが
 * 1つだけだと剥がされない点は既知の限界。
 */
export function projectLabels(slugs: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (slugs.length === 0) return map;
  let prefix = slugs.length === 1 ? "" : commonPrefix(slugs);
  prefix = prefix.slice(0, prefix.lastIndexOf("-") + 1); // セグメント境界まで戻す
  for (const slug of slugs) {
    const label = slug.slice(prefix.length).replace(/^-+/, "");
    map.set(slug, label || slug);
  }
  return map;
}

/**
 * パスの最終セグメントを返す(`/` 区切り、末尾スラッシュは無視)。
 * セグメントが空になる入力(例: "/")はそのまま返す。
 */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const result = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  return result || path;
}

function commonPrefix(items: string[]): string {
  let prefix = items[0];
  for (const item of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < item.length && prefix[i] === item[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}
