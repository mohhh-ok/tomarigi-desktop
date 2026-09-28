import type { NativeDirectoryHandle, NativeFile, NativeFileHandle } from "./native-fs";
import { loadEventLog, saveEventLog, type RootEntry } from "./fsa";
import { isPeerActive, watchingCount } from "./watching";
import { readCodexTail, type CodexTailInfo } from "./codex-transcript";
import { basename, projectLabels, readTail, type TailInfo } from "./transcript";
import type { AskJudgement } from "./jev";
import { invoke } from "@tauri-apps/api/core";

// transcript の遷移イベントを時刻付きで再構成したもの(実験機能)。
// key は同一イベントの重複排除用(毎ポーリングで同じ末尾 64KB を再パースするため)
export interface SessionEvent {
  key: string;
  sessionId: string;
  project: string;
  // プロンプトのスニペット。started はそのイベント自身のユーザー発言、他は直近の発言
  // (pickSnippet)。project 文字列に直接埋め込まず別フィールドにするのは、SessionView.snippet
  // と同じ表示スタイル(小さめ・淡色)を EventFeed 側でも独立して適用できるようにするため
  snippet?: string;
  type: "started" | "done" | "waiting" | "closed";
  at: number;
  // ひな(サブエージェント)待ちで抑止していた done が抑止明けにキャンセルされたとき true。
  // ログ・フィードには残すが、鳴き声・読み上げは出さない(deriveDoneEvent 参照)
  muted?: boolean;
  // 抑止明けの done が timeout 発火したときの実発火時刻(epoch ms)。at は key の基準
  // (t=親のターン終了時刻)のまま不変に保つため、鮮度ガード判定にはこちらを使う
  // (App.tsx: event.firedAt ?? event.at)
  firedAt?: number;
  // done 読み上げ要約(lib/summarize.ts)用のアシスタント最終応答テキスト(最大2000文字、
  // lib/transcript.ts の assistant_text.text 由来)。発話専用の一時フィールドで、
  // done 以外のイベントには付かない。数KBになりうる生テキストを IndexedDB の永続イベント
  // ログに残したくないため、appendToEventLog が保存直前に取り除く(in-memory の
  // sessionEventCache/events には残るので、App.tsx が新規 done を検知した瞬間の読み上げには使える)
  assistantText?: string;
  // done のターンを Jev が判断待ちと判定したか(recordAskJudgement)。デバッグダイアログに出す
  ask?: AskJudgement;
  // 最近の動きの行に添える、そのターンの吹き出しと同じ文。App が表示のときだけ付け、永続ログには入れない
  line?: string;
}

// 機械判定(transcript だけから毎ポーリング再計算する)。waiting は AskUserQuestion /
// ExitPlanMode / request_user_input でユーザーの応答を待っているとき
export type BirdState = "working" | "waiting" | "done" | "dozing";

export interface SessionView {
  id: string; // <rootId>/<slug>/<ファイル名>
  project: string; // 表示名
  // データソース内のプロジェクト識別子。Claude Code は projects/ 配下の slug、Codex は
  // `codex:<cwd>`。アイコンセット個別割り当て(issue #14)のキー。rootId を含まない
  // ため、同じプロジェクトパスを複数 root から見ていても割り当てが共有される
  slug: string;
  state: BirdState;
  sinceMs: number; // 最終書き込みからの経過
  toolName?: string; // tool_use 静止中のツール名
  chicks?: ChickView[]; // サブエージェント(親の子としてのみ存在)
  // 直近のユーザー発言スニペット(pickSnippet)。「何をやらせてるセッションか」を常に示す
  snippet?: string;
  // 止まっている(done / dozing)ターンの最後の応答。Jev 判定の入力とターンの識別
  // (sessionId + at)に使う。at は同じターンの done イベントの at と同じ値
  reply?: { at: number; text: string };
  // reply のターンに対する Jev 判定。App が付ける(mock は直接書く)
  ask?: AskJudgement;
  // 質問ツール(AskUserQuestion / request_user_input)で止まっているときの質問文。ツールの入力から
  // そのまま取る(AI を使わない)。吹き出しに出す(perch/bubble.tsx)
  question?: string;
  // reply のターンを BYOK で要約したセリフ。App が付ける(mock は直接書く)
  summary?: string;
  // Jev が返事待ちと判定したが要約用のキーが無いとき、reply の最後の 1 文(lib/last-sentence.ts。AI を使わない)。
  // App が付ける。吹き出しは summary が無ければこちらを出す
  replyTail?: string;
  // セッション間メッセージでつながっている相手(docs/design.md の見守り中)。Claude Code だけ
  peers?: PeerLink[];
  // 見守り中: 自分の機械判定が done / dozing で、今動いている相手の数。相手が止まってから猶予(lib/watching.ts の
  // WATCH_GRACE_MS)の間は 0 で見守り中のまま(巣箱にしまわない)。見守り中でなければ無い
  watching?: number;
  // 作業フォルダと起動時刻。止まり木の見守り中の字下げ(親は先に起動した方、ラベルは親からの相対パス)に使う
  cwd?: string;
  startedAt?: number;
}

/** 見守り中のつながりの相手。viewId は相手が画面にいる(同じスキャンの SessionView)ときだけ */
export interface PeerLink {
  sessionId: string;
  viewId?: string;
  name: string;
  cwd?: string;
  // 起動時刻(epoch ms)。止まり木で字下げの親(先に起動した方)を決める
  startedAt?: number;
  // 動いている(lib/watching.ts の isPeerActive。sessions/<pid>.json の status が idle 以外、または画面の機械判定が
  // working / waiting)
  active: boolean;
  // 最後に動いていた時刻(epoch ms)。このアプリが動いているのを見た最後の時刻と、相手の transcript の最後の書き込みの
  // 新しい方。見守り中の猶予に使う
  lastActiveAt?: number;
}

export interface ChickView {
  id: string; // <親の id>/<ファイル名>
  name: string; // meta.json の name→description→ファイル名の順で解決(resolveChickMeta)
  state: BirdState;
  sinceMs: number;
  toolName?: string;
}

export interface ScanResult {
  views: SessionView[];
  brokenIds: string[]; // 走査に失敗したルートの id
  events: SessionEvent[]; // 新しい順、最大30件(実験機能)
}

// scanChicks の内部走査結果。ChickView は表示専用の公開型なので汚さず、走査内部専用の
// フィールドを足せるよう型を分けている(現状は view のみだが、liveIds の間引きや
// sinceMs でのソート等、走査側だけで使う処理の置き場として残す)。
// 旧: tail(TailInfo)も保持していたが、ひな向け deriveStaleEvent 呼び出し(常に isChick=true で
// working 固定のため null しか返らない死コード)の削除に伴い、tail の利用箇所が無くなったため外した
interface ChickScan {
  view: ChickView;
}

const ACTIVE_WINDOW_MS = 30 * 60_000; // これより古いセッションは止まり木に出さない
const WRITING_MS = 6_000; // 直近書き込みあり=作業中
const CHICK_ABANDONED_MS = 10 * 60_000; // これ以上書き込みが無い working 固着のひなは放置ひなとみなし done 抑止に使わない(放置ひな判定のしきい値)
// ひな待ちで抑止していた done が抑止明けした後、親の再起動(キャンセル)を待つ猶予。
// バックグラウンドひな完了時のハーネス自動再起動は実測で完了の約3秒後なので、
// 30秒あれば通常ケースは十分カバーできる。既知のハーネス側通知遅延バグで再起動が
// 30秒を超えて遅れた場合は timeout 側が先に発火し、その後の再起動ターンでの
// done と二重に鳴り得るが、無音のまま鳴かない(実害の再発)よりましな劣化として許容する
const DONE_GRACE_MS = 30_000;
// 完了通知が来ないまま、これ以上経ったバックグラウンドタスクは done 抑止に使わない。
// 3秒ポーリングの合間に 64KB 超が書かれる・非表示タブでタイマーが間引かれる等で通知行を
// 見逃すと、抑止が解けなくなるための逃げ道。解けた後の done は at=T が古いため App.tsx の
// 鮮度ガードで鳴らない(=この値は誤発火の方向には効かない)
const BACKGROUND_TASK_STALE_MS = 30 * 60_000;
const DOZE_MS = 5 * 60_000; // 完了からこれ以上経ったら居眠り
// ひなの assistant_text tail を、親台帳(chickSignals)に信号が無いときのフォールバックとして
// done とみなすまでの静止時間。実データで観測された「作業中に一瞬テキストだけ書いた」無害な
// 休止は36秒、長い thinking を挟むケースでも60秒超あり得たため、それより十分長い2分を採用する
// (信号がある場合はこの値を経由せず即座に done 化できる。deriveState 参照)。
// これでも false のまま(通知が来ない・ひなの無言死)なら、最終的には既存の
// CHICK_ABANDONED_MS(10分、deriveDoneEvent の抑止解除)が別途効いて放置ひな扱いになる
const CHICK_TEXT_DONE_MS = 2 * 60_000;
// ひなの完了信号(chickSignals)と、ひなの最終会話時刻(tail.lastEventAt ?? file.lastModified)を
// 突き合わせる際の許容誤差。正常系では「ひなの最終書き込み→数秒後に親へ通知が書かれる」の
// 順になるため 最終会話時刻 <= signal は常に成立する。resume されたひなは signal より明確に
// 後の時刻まで最終会話時刻が進むため、数秒のマージンを超えて最終会話時刻が signal を
// 上回れば resume とみなし信号を無効化する(scanChicks 参照)
const CHICK_SIGNAL_EPSILON_MS = 5_000;

// BirdState の緊急度順(小さいほど緊急)。views のソート(scanSessions 末尾)と
// escalateWithChicks(親のエスカレーション判定)の両方が同じ順序を使うため、
// ここに一度だけ定義してモジュール内で共有する
const STATE_URGENCY: Record<BirdState, number> = { waiting: 0, working: 1, done: 2, dozing: 3 };

/**
 * 親の表示状態を、親自身の状態とひなの状態のうち最も緊急度の高いものにエスカレーション
 * する。ひなが走行中の親は寝かせない(=にわで巣箱に入ってしまうのを防ぐ)し、ひなが
 * 仕事を終えた直後の親は done まで起こす(実害: ひな done・10秒の横で親がうたた寝表示)。
 * dozing のひなだけは対象外 — ひな自身も放置で done → dozing に落ちるので、
 * 「完了直後だけ親が起きて、放置すればまた寝る」という自然な減衰になる。
 */
function escalateWithChicks(state: BirdState, chicks: ChickView[]): BirdState {
  let escalated = state;
  for (const chick of chicks) {
    if (chick.state === "dozing") continue;
    if (STATE_URGENCY[chick.state] < STATE_URGENCY[escalated]) escalated = chick.state;
  }
  return escalated;
}

interface CacheEntry {
  size: number;
  lastModified: number;
  tail: TailInfo;
}

const tailCache = new Map<string, CacheEntry>();

/**
 * サイズ・mtime が前回と同じならキャッシュを再利用する tail 読み取り。scanSessions(親)・
 * scanChicks(ひな)の両方から使う共有ロジック(元は2箇所に同じパターンが重複していたのを
 * 統合した)。親側は scanChicks より先にこれを呼ぶ必要がある — ひなの完了判定
 * (deriveState の isChick 分岐)が親 tail の chickSignals を必要とするため
 * (詳細は scanSessions 内のコメント参照)。
 */
async function readTailCached(
  id: string,
  file: NativeFile,
  opts?: { includeSidechain?: boolean },
): Promise<TailInfo> {
  const cached = tailCache.get(id);
  if (cached && cached.size === file.size && cached.lastModified === file.lastModified) {
    return cached.tail;
  }
  const tail = await readTail(file, opts);
  tailCache.set(id, { size: file.size, lastModified: file.lastModified, tail });
  return tail;
}

async function readCodexTailCached(id: string, file: NativeFile): Promise<CodexTailInfo> {
  const cached = tailCache.get(id);
  if (cached && cached.size === file.size && cached.lastModified === file.lastModified) {
    return cached.tail as CodexTailInfo;
  }
  const tail = await readCodexTail(file);
  tailCache.set(id, { size: file.size, lastModified: file.lastModified, tail });
  return tail;
}

// key: chickId。表示対象から外れたら間引く(再登場時は meta.json を読み直す)
const chickMetaCache = new Map<string, ChickMeta>();
// key: セッション id。tool 出力が巨大なセッションでは末尾 64KB 窓がツール結果だけで埋まり、
// 窓内にユーザー発言が1つも残らないことがある(実害: 本セッションで発生)。
// 最後に見えたスニペットを覚えておき、窓から流れた後も表示を維持する
const snippetCache = new Map<string, string>();
// key: 親セッション id。バックグラウンドタスク(run_in_background)の台帳(key: task-id)。
// 起動行(TailInfo.backgroundTaskStarts)は数十秒で tail 窓から流れる(実測: 起動から50秒後の
// ターン終了時点で既に窓外)ため、見えたうちに覚えておく。完了は親 tail の chickSignals
// (<task-notification> の task-id → 時刻)から埋める。deriveDoneEvent の抑止判定に使う
type BackgroundTask = { startedAt: number; endedAt?: number };
const backgroundTaskCache = new Map<string, Map<string, BackgroundTask>>();

// 見守り中(docs/design.md): セッション(view id)ごとの、セッション間メッセージでやり取りした相手の名前と
// その最新時刻。tail 窓から外れた跡も残すため、スキャンをまたいで持つ
const peerNameCache = new Map<string, Map<string, number>>();
// transcript のどこまで、やり取りの跡を読んだか(Rust の scan_peer_names の end)。tail 窓の外の跡も
// 拾うため、初回はファイル全体、以後は増えた分だけを読む
const peerScanOffset = new Map<string, number>();
// 前のスキャンでの各セッション(sessionId)の機械判定と最終書き込み時刻。相手が動いているかの判定と、
// 見守り中の done 抑止(相手をひなと同じ扱いで渡す)に使う
const lastPeerStates = new Map<string, { state: BirdState; lastWriteAt: number }>();
// 相手が最後に動いていた時刻(sessionId → epoch ms)。見守り中の猶予(lib/watching.ts)に使う
const peerLastActiveAt = new Map<string, number>();
// つながりの名前引きの結果が変わったときだけログに出す
let lastWatchSignature = "";

interface LiveSession {
  pid: number;
  sessionId: string;
  name?: string;
  cwd?: string;
  status?: string;
  startedAt?: number;
}

/** Claude Code の監視フォルダ(<config>/projects)の <config> */
function configDirOf(root: RootEntry): string {
  const path = root.path.replace(/\/+$/, "");
  return path.slice(0, path.lastIndexOf("/"));
}

/**
 * 監視フォルダ(<config>/projects)ごとに <config>/sessions/*.json を読む(Rust の live_sessions)。
 * sessions は動いているプロセスのもの。presentConfigDirs は <config>/sessions がある <config>
 */
async function loadLiveSessions(roots: RootEntry[]): Promise<{
  sessions: LiveSession[];
  presentConfigDirs: Set<string>;
  unreliableConfigDirs: Set<string>;
  unreadable: number;
}> {
  const configDirs = new Set(roots.filter((r) => r.kind === "claude").map(configDirOf));
  const scans = await Promise.all(
    [...configDirs].map(async (configDir) => {
      const scan = await invoke<{ present: boolean; sessions: LiveSession[]; reliable: boolean; unreadable: number }>(
        "live_sessions",
        { configDir },
      ).catch(() => ({ present: false, sessions: [] as LiveSession[], reliable: false, unreadable: 0 }));
      return { configDir, ...scan };
    }),
  );
  return {
    sessions: scans.flatMap((s) => s.sessions),
    presentConfigDirs: new Set(scans.filter((s) => s.present).map((s) => s.configDir)),
    // ps が動かなかった・sessions/*.json に読めないファイルがあった回。この回の結果では鳥を消さない
    unreliableConfigDirs: new Set(scans.filter((s) => !s.reliable).map((s) => s.configDir)),
    unreadable: scans.reduce((n, s) => n + s.unreadable, 0),
  };
}

// プロセスが終わったセッションの鳥はすぐ消す(docs/design.md)。判定は端末の種類に依存しない。
// Claude Code は起動するとすぐ <config>/sessions/<pid>.json を書き、終わると消す(実測: 残っているファイルは
// 全部 pid が生きていた)。transcript は最初の発言まで作られないので、「transcript はあるのに生きている
// sessions のファイルが無い」は、ふつうプロセスが終わったことを表す。
// - このアプリが動いている間に一度でも生きているのを見たセッションは、見えなくなった次の読み込みで消す(数秒以内)
// - 一度も見ていないもの(アプリを起動する前に終わったセッションなど)は、transcript に NEVER_SEEN_GRACE_MS
//   書き込みが無ければ消す。起動直後にファイルの書き込みが transcript より遅れた場合に消さないための猶予
// - <config>/sessions が無い監視フォルダ(古い版)・Codex・SDK 起動のセッションは対象外(今どおり 30 分)
// - ps が動かなかった回・sessions/*.json に読めないファイルがあった回は何も消さない(Claude Code は状態が変わるたびに
//   このファイルを書き直すので、書きかけを読むことがある)。消すのは続けて MISSES_TO_END 回の読み込みで見えなかったとき
const NEVER_SEEN_GRACE_MS = 15_000;
const MISSES_TO_END = 2;
// 続けて見えなかった回数(view の id)。見えたら消す
const missCounts = new Map<string, number>();
// 読み込みごとの記録(fix18 の調査用。環境変数 TOMARIGI_SCAN_LOG があるときだけ app-log に出す)
let scanLogEnabled: boolean | undefined;
// 生きているのを見たセッション(view の id)。消した後も持ち続け(外すと猶予の間だけ鳥が戻る)、
// 30 分の窓から外れたら間引く
const seenAliveIds = new Set<string>();

function sessionIdOfViewId(id: string): string {
  const file = id.split("/")[2] ?? "";
  return file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) : file;
}
const sessionEventCache = new Map<string, SessionEvent>(); // key: SessionEvent.key。同一イベントの重複排除
const MAX_EVENTS = 30;

// デバッグ用の永続イベントログ(デバッグダイアログ)。sessionEventCache と違い30分 TTL では
// 消さず、末尾 MAX_EVENT_LOG 件だけ保持する。knownLogKeys は「これまでに一度でもログへ
// 書いたか」の全期間マーカーで、sessionEventCache が30分 TTL で間引かれた後に同じイベントが
// tail から再導出されても(cacheEvent 視点では「新規挿入」に見えてしまう)、ログ側では
// 二重追記しない防波堤になる。
const MAX_EVENT_LOG = 500;
let eventLog: SessionEvent[] = []; // 追記順(末尾が最新)。永続化される実体
const knownLogKeys = new Set<string>();
let eventLogDirty = false; // このスキャンで永続ログに新規追記があったか。scanSessions 末尾でまとめて1回だけ保存する
// 起動直後は永続ログの復元(非同期)が終わっていない。復元前に「新規挿入」が来ても、
// 復元済みの key と区別が付かず二重追記してしまうため、復元完了までは一旦 pending に貯めて
// おき、完了後にまとめてマージする。
// "failed" は「復元に失敗しても空のまま進めてよい」状態には倒さない —
// このログは再導出できない唯一の実体なので、復元前の状態のまま saveEventLog を呼んで
// 空(または今スキャン分だけ)で上書きしてしまうと既存の履歴が消える。
// 失敗時は "failed" のまま固定し、scanSessions 末尾の保存ゲート(=== "done")を素通りさせない。
let eventLogHydration: "none" | "loading" | "done" | "failed" = "none";
const pendingLogEvents: SessionEvent[] = [];

// 現行の SessionEvent["type"] 値の集合。廃止された種別(旧 "harsh": LLM 判定機能の削除に
// 伴い撤去。lib/harassment.ts が生成していた)が永続ログに残っていても、読み出し側
// (このセットで照合する箇所)で安全に無視する。IndexedDB 上の既存レコードはマイグレーション
// せずそのまま残すが、以後の表示・再保存の対象からは外れる
const KNOWN_EVENT_TYPES = new Set<SessionEvent["type"]>([
  "started",
  "done",
  "waiting",
  "closed",
]);

function isKnownEventType(type: string): type is SessionEvent["type"] {
  return KNOWN_EVENT_TYPES.has(type as SessionEvent["type"]);
}

function hydrateEventLog(): void {
  if (eventLogHydration !== "none") return;
  eventLogHydration = "loading";
  void (async () => {
    try {
      const saved = await loadEventLog<SessionEvent>();
      if (saved) {
        // 廃止済み種別(旧 "harsh" 等)は以後の再保存・表示対象から除く(上記 KNOWN_EVENT_TYPES 参照)
        eventLog = saved.filter((e) => isKnownEventType(e.type));
        for (const e of eventLog) knownLogKeys.add(e.key);
      }
      eventLogHydration = "done";
      // 復元完了前に取りこぼした分をここでマージする。既知 key は appendToEventLog が弾く
      for (const event of pendingLogEvents) appendToEventLog(event);
      pendingLogEvents.length = 0;
    } catch (e) {
      // 既存履歴を上書きするリスクを避けるため "done" にはしない(保存は永久に止まる)。
      // pending も永続化されない前提になったので破棄する(このセッション中はメモリ上にも
      // 保持しない。cacheEvent 側も "failed" では以後 pending に積まない)
      console.warn("[tomarigi] イベントログの復元に失敗", e);
      eventLogHydration = "failed";
      pendingLogEvents.length = 0;
    }
  })();
}

/**
 * 永続ログへの実追記。knownLogKeys で全期間の重複を防ぎ、末尾 MAX_EVENT_LOG 件だけ残す。
 * assistantText(読み上げ要約用の一時フィールド、最大2000文字)は書かない — 発話にしか
 * 使わないフィールドを数KB単位で IndexedDB に溜める理由が無いため、永続化直前に剥がす
 * (in-memory の sessionEventCache 側はそのまま保持する。cacheEvent 参照)。
 */
function appendToEventLog(event: SessionEvent): void {
  if (knownLogKeys.has(event.key)) return;
  knownLogKeys.add(event.key);
  const { assistantText: _assistantText, ...persisted } = event;
  eventLog.push(persisted);
  if (eventLog.length > MAX_EVENT_LOG) {
    const removed = eventLog.shift();
    if (removed) knownLogKeys.delete(removed.key);
  }
  eventLogDirty = true;
}

/**
 * sessionEventCache への挿入は first-write-wins にする(同じ key を後から来た値で上書きしない)。
 * イベント種は at が transcript 由来で不変なので、first-write-wins にしても挙動は変わらない。
 * 「実際に Map へ新規挿入されたイベント」だけを永続ログにも回す(cacheEvent が毎スキャン
 * 呼ばれても、同じイベントで二重にログへ積まないため)。
 */
function cacheEvent(event: SessionEvent): void {
  if (sessionEventCache.has(event.key)) return;
  sessionEventCache.set(event.key, event);
  hydrateEventLog(); // 初回呼び出しで復元を開始する(以降は no-op)
  if (eventLogHydration === "done") {
    appendToEventLog(event);
  } else if (eventLogHydration !== "failed") {
    // "failed" では復元自体を諦めているため、以後は pending に積み続けない
    // (無期限に貯まり続けるのを防ぐ。このセッション中の永続ログ追記は諦める)
    pendingLogEvents.push(event);
  }
}

const SNIPPET_MAX_WIDTH = 24; // 表示幅の上限(半角換算)。超過分は「…」

// 全角(CJK・かな等)は半角の約2倍幅なので、コードポイント数で数えると日本語と英語で
// 表示幅がずれる。半角換算幅(全角=2, 半角=1)で数える。判定は「ASCII と半角カナ以外は
// 全角」の近似で足りる(スニペットは厳密なレイアウト計算を要しない)
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code <= 0xff) return 1; // ASCII・Latin-1
  if (code >= 0xff61 && code <= 0xffdc) return 1; // 半角カナ
  return 2;
}

/**
 * セッションの「いま何をやらせているか」を示すスニペットを選ぶ。tail.events の user イベント
 * (text 付き)を新しい順に走査し、最初に「使える」テキストを採用する。短い指示(「push」等)
 * もプロンプトとしては情報なので弾かない。見つからなければ undefined(機械的テキストしか
 * 無いセッション等)
 */
function pickSnippet(tail: TailInfo): string | undefined {
  for (let i = tail.events.length - 1; i >= 0; i--) {
    const event = tail.events[i];
    if (event.kind !== "user" || !event.text) continue;
    const snippet = formatSnippet(event.text);
    if (snippet) return snippet;
  }
  return undefined;
}

// スニペットとして使えないテキストを弾いて整形する: 機械的テキスト(スラッシュコマンドの
// <command- タグ、[SYSTEM 通知、[Request interrupted 等)は undefined。
// 「[Image #N]」は画像添付の印で本文が続くので、剥がして本文を使う。
// 改行・連続空白はスペース1つに正規化し、表示幅(全角=2, 半角=1)の上限で切る
function formatSnippet(rawText: string): string | undefined {
  let normalized = rawText.trim().replace(/\s+/g, " ");
  normalized = normalized.replace(/^(\[Image #\d+\]\s*)+/, "");
  if (!normalized) return undefined;
  if (normalized.startsWith("<")) return undefined;
  if (normalized.startsWith("[SYSTEM") || normalized.startsWith("[Request interrupted")) {
    return undefined;
  }
  let width = 0;
  let cut = normalized.length; // 上限に達した位置(文字列 index)。達しなければ末尾
  for (let i = 0; i < normalized.length; ) {
    const ch = String.fromCodePoint(normalized.codePointAt(i) ?? 0);
    width += charWidth(ch);
    i += ch.length;
    if (width > SNIPPET_MAX_WIDTH) {
      cut = i - ch.length;
      break;
    }
  }
  if (cut >= normalized.length) return normalized;
  return `${normalized.slice(0, cut)}…`;
}

// scanSessions 内部の走査結果1件分。found・withTail・SDK ひな分配のいずれでも同じ形を使う
interface FoundEntry {
  agent: "claude" | "codex";
  rootId: string;
  rootLabel: string;
  slug: string; // プロジェクトディレクトリ名(~/.claude*/projects/ 配下)。SDK ひなの親候補を
  // 「同じプロジェクトディレクトリ」で絞り込む際のグルーピングキーの一部にも使う
  file: NativeFile;
  id: string;
  tail: TailInfo;
  chicks: ChickScan[]; // scanChicks で見つけたサブエージェントひな(SDK ひなはここに含まない)
}

interface CodexRollout {
  file: NativeFile;
  path: string;
}

/**
 * Codex stores rollouts below YYYY/MM/DD. Only today and yesterday can contain a
 * session inside ACTIVE_WINDOW_MS, so avoid walking the user's entire history on
 * every three-second poll. Both ~/.codex/sessions and ~/.codex are accepted.
 */
async function findRecentCodexRollouts(
  selectedRoot: NativeDirectoryHandle,
  now: number,
): Promise<CodexRollout[]> {
  let sessionsDir = selectedRoot;
  if (selectedRoot.name !== "sessions") {
    try {
      sessionsDir = await selectedRoot.getDirectoryHandle("sessions");
    } catch {
      return [];
    }
  }

  const dates = [new Date(now), new Date(now - 24 * 60 * 60_000)];
  const seen = new Set<string>();
  const rollouts: CodexRollout[] = [];
  for (const date of dates) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const datePath = `${year}/${month}/${day}`;
    if (seen.has(datePath)) continue;
    seen.add(datePath);

    try {
      const yearDir = await sessionsDir.getDirectoryHandle(year);
      const monthDir = await yearDir.getDirectoryHandle(month);
      const dayDir = await monthDir.getDirectoryHandle(day);
      for await (const entry of dayDir.values()) {
        if (entry.kind !== "file" || !entry.name.endsWith(".jsonl")) continue;
        const file = await (entry as NativeFileHandle).getFile();
        rollouts.push({ file, path: `${datePath}/${entry.name}` });
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
    }
  }
  return rollouts;
}

export async function scanSessions(roots: RootEntry[]): Promise<ScanResult> {
  const now = Date.now();
  const found: FoundEntry[] = [];
  const brokenIds: string[] = [];
  // tail を読んだが表示対象外として除外したセッション(sdk-cli・Codex の内部 rollout)の id。
  // found に入らないが、tailCache から間引くと3秒ごとに読み直しになるため残す
  const skippedIds = new Set<string>();

  for (const root of roots) {
    try {
      if (root.kind === "claude") {
        for await (const entry of root.handle.values()) {
          if (entry.kind !== "directory") continue;
          const projectDir = entry as NativeDirectoryHandle;
          for await (const child of projectDir.values()) {
            if (child.kind !== "file" || !child.name.endsWith(".jsonl")) continue;
            const file = await (child as NativeFileHandle).getFile();
            // ここは tail を読む前の粗い足切り(高速化目的)なので mtime のままでよい: mtime は
            // 実際の最終会話時刻(tail.lastEventAt)以上に進むことはあっても遅れることは無いため、
            // この判定を通ったセッションが本当は ACTIVE_WINDOW_MS を過ぎているケースは起きない
            // (安全側の粗いフィルタ。厳密な時間基準は下の sinceMs 計算で tail.lastEventAt を使う)
            if (now - file.lastModified > ACTIVE_WINDOW_MS) continue;
            const id = `${root.id}/${projectDir.name}/${child.name}`;
            // ひな(サブエージェント)の完了判定は親台帳(親 tail の chickSignals)を正とするため、
            // scanChicks より先に親の tail を読んでおく(deriveState の isChick コメント参照)。
            // ここで読んだ tail は下の withTail 構築でも再利用する(cwd/base 名の計算用)ため、
            // 二重に読み直さない
            const tail = await readTailCached(id, file);
            // `claude -p`(entrypoint "sdk-cli")は tomarigi の対象外(鳥もイベントも出さない)。
            // 多くは Claude Code がコマンドとして裏で起動したもので、子にも親にも互いの id が
            // 残らず親に確定的に結べない(cwd も起動先ディレクトリになり同ディレクトリの親も
            // いない)。起動元の親の done はバックグラウンドタスクの抑止(deriveDoneEvent)で扱う。
            // 手で打った `claude -p` も結果はそのターミナルに出るため見張る必要が薄い
            if (tail.entrypoint === "sdk-cli") {
              skippedIds.add(id);
              continue;
            }
            const chicks = await scanChicks(projectDir, child.name, id, now, tail.chickSignals);
            found.push({
              agent: "claude",
              rootId: root.id,
              rootLabel: root.label,
              slug: projectDir.name,
              file,
              id,
              tail,
              chicks,
            });
          }
        }
      }

      if (root.kind === "codex") {
        for (const { file, path } of await findRecentCodexRollouts(root.handle, now)) {
          if (now - file.lastModified > ACTIVE_WINDOW_MS) continue;
          const id = `${root.id}/codex/${path}`;
          const tail = await readCodexTailCached(id, file);
          // Internal rollouts (subagents, guardian reviews, and future non-user sources) can
          // complete repeatedly while the parent is still working. Treating them as independent
          // sessions duplicates birds and emits false done events. Older rollouts may not have
          // thread_source, so keep those for backward compatibility and reject only explicit
          // non-user sources.
          if (tail.threadSource !== undefined && tail.threadSource !== "user") {
            skippedIds.add(id);
            continue;
          }
          const cwd = tail.cwd;
          const slug = cwd ? `codex:${cwd}` : `codex:${file.name}`;
          found.push({
            agent: "codex",
            rootId: root.id,
            rootLabel: root.label,
            slug,
            file,
            id,
            tail,
            chicks: [],
          });
        }
      }
    } catch (e) {
      console.warn("[tomarigi] ルート走査に失敗", root.id, e);
      brokenIds.push(root.id);
    }
  }

  // プロセスが終わったセッション(ひなごと)を表示対象から外す(NEVER_SEEN_GRACE_MS のコメント)。
  // tail は読み済みなので skippedIds に入れて tailCache に残す
  const { sessions: liveSessions, presentConfigDirs, unreliableConfigDirs, unreadable } = await loadLiveSessions(roots);
  const liveSessionIds = new Set(liveSessions.map((l) => l.sessionId));
  const configDirByRoot = new Map(roots.filter((r) => r.kind === "claude").map((r) => [r.id, configDirOf(r)]));
  const endedIds = new Set<string>();
  const foundIds = new Set(found.map((f) => f.id));
  for (const id of seenAliveIds) if (!foundIds.has(id)) seenAliveIds.delete(id);
  for (const id of missCounts.keys()) if (!foundIds.has(id)) missCounts.delete(id);
  for (const f of found) {
    if (f.agent !== "claude" || /^sdk/.test(f.tail.entrypoint ?? "")) continue;
    const configDir = configDirByRoot.get(f.rootId);
    if (configDir === undefined || !presentConfigDirs.has(configDir)) continue;
    if (liveSessionIds.has(sessionIdOfViewId(f.id))) {
      seenAliveIds.add(f.id);
      missCounts.delete(f.id);
      continue;
    }
    // この回の結果が当てにならなければ、消さず数えもしない
    if (unreliableConfigDirs.has(configDir)) continue;
    const seen = seenAliveIds.has(f.id);
    if (!seen && now - f.file.lastModified <= NEVER_SEEN_GRACE_MS) continue;
    const misses = (missCounts.get(f.id) ?? 0) + 1;
    missCounts.set(f.id, misses);
    if (misses < MISSES_TO_END) continue;
    endedIds.add(f.id);
    // 消した回のたびに出す(点いたり消えたりしたら追えるように)。消えたままの間は毎回の読み込みで出さない
    if (misses === MISSES_TO_END) {
      const line = `[live] ended ${f.id} seenAlive=${seen} misses=${misses} idleMs=${now - f.file.lastModified}`;
      void invoke("log", { line }).catch(() => {});
    }
  }
  if (endedIds.size > 0) {
    for (const f of found) if (endedIds.has(f.id)) skippedIds.add(f.id);
    found.splice(0, found.length, ...found.filter((f) => !endedIds.has(f.id)));
    // 最近の動き(セッションごとの最新のカード)からも消す
    for (const [key, event] of sessionEventCache) if (endedIds.has(event.sessionId)) sessionEventCache.delete(key);
  }

  // SDK(Claude Agent SDK)経由で起動されたセッションのひな化。entrypoint フィールドは
  // internal 仕様で、cli/sdk-py を実データで確認した(2026-08-08。TailInfo.entrypoint の
  // コメント参照)。tail 窓に entrypoint 付きの行が無く取れないセッションは undefined のまま
  // = SDK 起動と断定する根拠が無いので、安全側に倒して cli(大人)扱いのまま進める。
  const SDK_ENTRYPOINT_RE = /^sdk/;
  const isSdkSession = (f: FoundEntry) =>
    f.agent === "claude" && SDK_ENTRYPOINT_RE.test(f.tail.entrypoint ?? "");
  // 状態判定と同じ時間基準(tail.lastEventAt、無ければ file.lastModified。TailInfo.lastEventAt
  // のコメント参照)を親候補選定にも使う
  const effectiveLastEventAt = (f: FoundEntry) => f.tail.lastEventAt ?? f.file.lastModified;

  const sdkEntries = found.filter(isSdkSession);
  const nonSdkEntries = found.filter((f) => !isSdkSession(f));

  // 親候補: 「同じプロジェクトディレクトリ」= 同じ root かつ同じ slug 内で、最終会話時刻が
  // 最も新しい非 SDK セッション。found はまだ ACTIVE_WINDOW_MS で足切り済みの全件であり、
  // 非 SDK セッションはこの後 withTail 経由で必ず表示対象になるため「表示対象のもの」の
  // 条件も自動的に満たす
  const parentCandidateByGroup = new Map<string, FoundEntry>(); // key: `${rootId}/${slug}`
  for (const f of nonSdkEntries) {
    const key = `${f.rootId}/${f.slug}`;
    const current = parentCandidateByGroup.get(key);
    if (!current || effectiveLastEventAt(f) > effectiveLastEventAt(current)) {
      parentCandidateByGroup.set(key, f);
    }
  }

  // SDK セッションはひな(ChickScan)として親候補の id をキーに集める。親候補が無い
  // (=同じプロジェクトディレクトリに他の非 SDK セッションが無い)孤児は、消してしまわず
  // 従来どおり大人の鳥として表示するフォールバックに回す(orphanSdkEntries)。
  // 親候補はスキャンのたびに再計算するだけ(永続化しない)なので、より新しい非 SDK
  // セッションが現れれば SDK ひなは自然に付け替わる(前回の親には二度と紐付かない)
  const sdkChicksByParentId = new Map<string, ChickScan[]>();
  const orphanSdkEntries: FoundEntry[] = [];
  for (const f of sdkEntries) {
    const parent = parentCandidateByGroup.get(`${f.rootId}/${f.slug}`);
    if (!parent) {
      orphanSdkEntries.push(f);
      continue;
    }
    const sinceMs = now - effectiveLastEventAt(f);
    // ひなの id はファイル名ベースで固定する(親が付け替わっても安定させる。ファイル名は
    // プロジェクトディレクトリ内で一意なので slug と組み合わせれば root を跨いでも衝突しない)。
    // 既存のサブエージェントひな id(`${親id}/${ファイル名}`)や SessionEvent.key
    // (`${sessionId}:${at}:${type}`、常に親 id 由来)とは名前空間が "sdk:" で分離されており、
    // chickMetaCache・イベント重複排除のいずれとも衝突しない
    const chickId = `sdk:${f.slug}/${f.file.name}`;
    const view: ChickView = {
      id: chickId,
      name: "SDK", // meta.json が存在しない(SDK 起動には無い)ため resolveChickMeta は使わず固定名
      // 親台帳(chickSignals)には SDK ひなの完了信号が無い(親 transcript 側の仕組みなので
      // SDK セッション自身の tail には現れない)。deriveState ではなく専用の
      // deriveSdkChickState を使う(理由はその定義のコメント参照)
      state: deriveSdkChickState(f.tail, sinceMs),
      sinceMs,
      toolName: f.tail.kind === "tool_use" ? f.tail.toolName : undefined,
    };
    const list = sdkChicksByParentId.get(parent.id) ?? [];
    list.push({ view });
    sdkChicksByParentId.set(parent.id, list);
  }

  // 表示対象(SessionView になりうるもの)= 非 SDK セッション + 親候補の無い SDK 孤児
  const displayEntries = [...nonSdkEntries, ...orphanSdkEntries];

  // ルートごとに表示名テーブルを計算(cwd が取れないセッションのフォールバック用。
  // スラッグの共通接頭辞剥がしはルート内でしか意味を持たない)。found(SDK 含む全件)から
  // 計算しても displayEntries と結果は変わらない(SDK セッションの slug は必ずどこかの
  // 表示対象セッションと共有される)が、素直に走査済みの全件を使う
  const labelsByRoot = new Map<string, Map<string, string>>();
  for (const root of roots) {
    const slugs = [...new Set(found.filter((f) => f.rootId === root.id).map((f) => f.slug))];
    labelsByRoot.set(root.id, projectLabels(slugs));
  }

  // base 名は cwd があればそれを優先する(ルートを跨いでも一致するので、下の重複検出が
  // 同一プロジェクトを検出できる)。tail は上のループで読み済み。
  // isSdk は状態判定の分岐(下記ループの deriveState/deriveSdkChickState 切り替え)に使う。
  // orphanSdkEntries(親候補が無い SDK セッションの大人表示フォールバック)にも
  // deriveSdkChickState の「構造化出力ツール終端で working 固着」修正を効かせる必要があるため、
  // isSdkSession の判定結果をここで持ち回る(pushレビュー指摘2)
  const withTail: (FoundEntry & { base: string; isSdk: boolean })[] = [];
  for (const f of displayEntries) {
    const base = f.tail.cwd
      ? basename(f.tail.cwd)
      : (labelsByRoot.get(f.rootId)?.get(f.slug) ?? f.slug);
    withTail.push({ ...f, base, isSdk: isSdkSession(f) });
  }

  // 表示名(ルートラベル抜き)がどのルートに出現したかを集計し、
  // 異なるルート間で重複したものだけルートラベルを後置して区別する
  const baseNameRoots = new Map<string, Set<string>>();
  for (const f of withTail) {
    if (!baseNameRoots.has(f.base)) baseNameRoots.set(f.base, new Set());
    baseNameRoots.get(f.base)?.add(f.rootId);
  }


  // 見守り中のつながり(docs/design.md)。やり取りした相手の名前を、動いているセッションの名前と
  // 突き合わせて sessionId にし、両向きにつなぐ(どちらか一方の跡があればつながっているとみなす)
  const liveByName = new Map<string, LiveSession>();
  const liveBySessionId = new Map<string, LiveSession>();
  for (const live of liveSessions) {
    if (live.name) liveByName.set(live.name, live);
    liveBySessionId.set(live.sessionId, live);
  }
  const viewIdBySessionId = new Map<string, string>();
  const links = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    if (!links.has(a)) links.set(a, new Set());
    links.get(a)?.add(b);
  };
  const claudeEntries = withTail.filter((f) => f.agent === "claude");
  await Promise.all(
    claudeEntries.map(async (f) => {
      try {
        const scan = await invoke<{ names: [string, string][]; end: number }>("scan_peer_names", {
          path: f.file.path,
          start: peerScanOffset.get(f.id) ?? 0,
        });
        peerScanOffset.set(f.id, scan.end);
        let names = peerNameCache.get(f.id);
        if (!names) {
          names = new Map();
          peerNameCache.set(f.id, names);
        }
        for (const [name, timestamp] of scan.names) {
          const at = Date.parse(timestamp);
          if (Number.isFinite(at)) names.set(name, Math.max(names.get(name) ?? 0, at));
        }
      } catch {
        // 読めなければ tail 窓の中の跡(tail.peerNames)だけで判定する
      }
    }),
  );
  for (const f of claudeEntries) {
    const ownSessionId = sessionIdOfViewId(f.id);
    viewIdBySessionId.set(ownSessionId, f.id);
    let names = peerNameCache.get(f.id);
    if (!names) {
      names = new Map();
      peerNameCache.set(f.id, names);
    }
    for (const [name, at] of f.tail.peerNames) names.set(name, Math.max(names.get(name) ?? 0, at));
    for (const name of names.keys()) {
      const peer = liveByName.get(name);
      if (!peer) continue;
      link(ownSessionId, peer.sessionId);
      link(peer.sessionId, ownSessionId);
    }
  }
  const peerLinksOf = (ownSessionId: string): PeerLink[] =>
    [...(links.get(ownSessionId) ?? [])].map((sessionId) => {
      const live = liveBySessionId.get(sessionId);
      const last = lastPeerStates.get(sessionId);
      return {
        sessionId,
        viewId: viewIdBySessionId.get(sessionId),
        name: live?.name ?? sessionId.slice(0, 8),
        cwd: live?.cwd,
        startedAt: live?.startedAt,
        active: isPeerActive(live?.status, last?.state),
        lastActiveAt: peerLastActiveAt.get(sessionId),
      };
    });
  const watchSignature = [...links.entries()]
    .map(([a, bs]) => `${liveBySessionId.get(a)?.name ?? a.slice(0, 8)} <-> ${[...bs].map((b) => liveBySessionId.get(b)?.name ?? b.slice(0, 8)).sort().join(", ")}`)
    .sort()
    .join("\n");
  if (watchSignature !== lastWatchSignature) {
    lastWatchSignature = watchSignature;
    // 名前の対応だけを出す(メッセージの本文は読まない・出さない)
    void invoke("log", { line: `[watch] links\n${watchSignature || "(none)"}` }).catch(() => {});
  }

  const views: SessionView[] = [];

  for (const { rootLabel, file, id, chicks, tail, base, slug, isSdk } of withTail) {
    const ambiguous = (baseNameRoots.get(base)?.size ?? 0) > 1;
    // 状態判定の時間基準は tail.lastEventAt(timestamp 付き行の最終時刻)。timestamp を持たない
    // 事後追記(last-prompt 等、死んだ transcript への数時間後の touch)では file.lastModified
    // だけが進むため、mtime を基準にすると終了済みセッションが再出現する(TailInfo.lastEventAt
    // のコメント参照)。tail 窓内に timestamp 付き行が1つも無いレアケースだけ mtime にフォールバック
    const sinceMs = now - (tail.lastEventAt ?? file.lastModified);
    const project = ambiguous ? `${base} (${rootLabel})` : base;
    // サブエージェントひな(scanChicks 由来)と SDK ひな(このセッションが親候補に選ばれた分)は
    // 別々のリストのまま持ち回り、渡し先で使い分ける(pushレビュー指摘1)。
    // - subagentChickViews(SDK を含まない): deriveSessionEvents(done 抑止判定)にだけ渡す。
    //   SDK ひなは親が起動した子ではなく無関係な並走プロセスなので、SDK ひなが走行中なだけで
    //   親の done 抑止(deriveDoneEvent のコメント参照。抑止の前提「親が起動した子」が
    //   SDK ひなには成り立たない)を発動させてはいけない。
    // - chickViews(SDK 込みでマージ): escalateWithChicks(表示エスカレーション)と
    //   SessionView.chicks(表示)には従来どおり SDK ひなを含めたまま渡す。エスカレーションから
    //   外すと、親が dozing になった瞬間に走行中の SDK ひなごと巣箱に消えて見えなくなり、
    //   ひな化前(大人の鳥として見えていた)より視認性が退行するため、表示側にはあえて残す。
    const subagentChickViews = chicks.map((c) => c.view);
    const sdkChickViews = (sdkChicksByParentId.get(id) ?? []).map((c) => c.view);
    const chickViews = [...subagentChickViews, ...sdkChickViews].sort(
      (a, b) => a.sinceMs - b.sinceMs,
    );
    // deriveState が「見た目(鳥)」の唯一の判定源。ただし SDK 孤児(親候補が無く大人表示に
    // フォールバックした SDK セッション、isSdk===true)には deriveSdkChickState を使う —
    // 構造化出力ツール終端(tool_result)で working に固着する問題は deriveState では
    // 未修正のまま(deriveSdkChickState のコメント参照。pushレビュー指摘2)
    const state = isSdk ? deriveSdkChickState(tail, sinceMs) : deriveState(tail, sinceMs, false);
    // 表示用の状態は、ひなが走行中(done/dozing 以外)ならその緊急度にエスカレーションする
    const displayState = escalateWithChicks(state, chickViews);
    // 直近のユーザー発言スニペットを常に付ける(「何をやらせてるセッションか」が主情報)。
    // 窓内に発言が無ければ記憶している最後のスニペットで代用する
    const snippet = pickSnippet(tail) ?? snippetCache.get(id);
    if (snippet) snippetCache.set(id, snippet);
    const peers = peerLinksOf(sessionIdOfViewId(id));
    const watching = watchingCount(displayState, peers, now);
    const last = tail.events[tail.events.length - 1];
    const reply =
      (displayState === "done" || displayState === "dozing") &&
      last?.kind === "assistant_text" &&
      last.text
        ? { at: last.at, text: last.text }
        : undefined;
    const question =
      displayState === "waiting" && last?.kind === "tool_use" ? extractQuestion(last.text) : undefined;
    views.push({
      id,
      project,
      slug,
      state: displayState,
      sinceMs,
      toolName: tail.kind === "tool_use" ? tail.toolName : undefined,
      chicks: chickViews.length > 0 ? chickViews : undefined,
      snippet,
      reply,
      question,
      peers: peers.length > 0 ? peers : undefined,
      watching,
      cwd: tail.cwd,
      startedAt: liveBySessionId.get(sessionIdOfViewId(id))?.startedAt,
    });
    // done だけはひな(サブエージェント)の状況も見る。ひなが走行中のうちは
    // 「戻ってきて」信号としてまだ早いため。SDK ひなはここに含めない(上記コメント参照)
    const backgroundTasks = updateBackgroundTasks(id, tail);
    // 見守り中の done は、つながっている相手が全部止まるまで出さない。相手をひなと同じ扱いで
    // deriveDoneEvent の抑止に渡す(動いている相手は走行中のひな、止まった相手は最終書き込み時刻つき)
    const peerChicks: ChickView[] = peers.flatMap((p) => {
      const lastState = lastPeerStates.get(p.sessionId);
      if (p.active) return [{ id: `peer:${p.sessionId}`, name: p.name, state: "working" as const, sinceMs: 0 }];
      if (!lastState) return [];
      return [{ id: `peer:${p.sessionId}`, name: p.name, state: lastState.state, sinceMs: now - lastState.lastWriteAt }];
    });
    for (const event of deriveSessionEvents(
      tail,
      id,
      project,
      [...subagentChickViews, ...peerChicks],
      backgroundTasks,
      snippet,
      now,
    )) {
      cacheEvent(event);
    }
  }

  for (const view of views) {
    lastPeerStates.set(sessionIdOfViewId(view.id), { state: view.state, lastWriteAt: now - view.sinceMs });
  }
  // 見守り中の猶予に使う、相手が最後に動いていた時刻。今動いていれば今、そうでなければ transcript の最後の書き込み
  // (アプリを起動し直した直後でも、相手が少し前まで動いていたことが分かる)
  for (const [sessionId, last] of lastPeerStates) {
    const active = isPeerActive(liveBySessionId.get(sessionId)?.status, last.state);
    const seen = active ? now : last.lastWriteAt;
    peerLastActiveAt.set(sessionId, Math.max(peerLastActiveAt.get(sessionId) ?? 0, seen));
  }
  for (const sessionId of peerLastActiveAt.keys()) if (!lastPeerStates.has(sessionId)) peerLastActiveAt.delete(sessionId);
  for (const key of lastPeerStates.keys()) {
    if (!viewIdBySessionId.has(key) && !liveBySessionId.has(key)) lastPeerStates.delete(key);
  }

  views.sort((a, b) => STATE_URGENCY[a.state] - STATE_URGENCY[b.state] || a.sinceMs - b.sinceMs);

  if (scanLogEnabled === undefined) {
    scanLogEnabled = await invoke<boolean>("scan_log_enabled").catch(() => false);
  }
  if (scanLogEnabled) logScan(views, liveSessions, unreliableConfigDirs, unreadable, endedIds);

  // 30分ウィンドウから外れた分のキャッシュを間引く。開きっぱなし運用(PiP 常駐)で
  // セッションが日々増えても、キャッシュは表示対象分しか持たない
  const liveIds = new Set<string>();
  for (const f of found) {
    liveIds.add(f.id);
    for (const c of f.chicks) liveIds.add(c.view.id);
  }
  for (const key of tailCache.keys()) {
    if (!liveIds.has(key) && !skippedIds.has(key)) tailCache.delete(key);
  }
  for (const key of chickMetaCache.keys()) if (!liveIds.has(key)) chickMetaCache.delete(key);
  for (const key of snippetCache.keys()) if (!liveIds.has(key)) snippetCache.delete(key);
  for (const key of backgroundTaskCache.keys()) if (!liveIds.has(key)) backgroundTaskCache.delete(key);
  for (const key of peerNameCache.keys()) if (!liveIds.has(key)) peerNameCache.delete(key);
  for (const key of peerScanOffset.keys()) if (!liveIds.has(key)) peerScanOffset.delete(key);

  // ACTIVE_WINDOW_MS より古いイベントは捨てる(毎ポーリングで末尾を再パースするため、
  // 重複排除された上で溜まっていく分をここで頭打ちにする)
  for (const [key, event] of sessionEventCache) {
    if (now - event.at > ACTIVE_WINDOW_MS) sessionEventCache.delete(key);
  }
  const events = [...sessionEventCache.values()].sort((a, b) => b.at - a.at).slice(0, MAX_EVENTS);

  // 永続イベントログは毎 cacheEvent ごとではなく、この1回のスキャンの終わりにまとめて1回だけ
  // 書く(新規イベントが無いスキャンでは書き込まない)。dirty フラグは cacheEvent 経由の
  // appendToEventLog だけでなく、hydrateEventLog の pending マージでも立ちうる
  if (eventLogDirty && eventLogHydration === "done") {
    eventLogDirty = false;
    void saveEventLog(eventLog).catch((e) => {
      console.warn("[tomarigi] イベントログの保存に失敗", e);
    });
  }

  return { views, brokenIds, events };
}

// 前の読み込みで views にいた id(読み込みごとの記録で、消えた・戻った鳥を出す)
let lastScanViewIds = new Set<string>();

/**
 * 読み込みごとの記録(fix18 の調査用)。1 回の読み込みで 1 行。見守りのつながりがある鳥と、前の回から
 * 消えた・戻った鳥を出す。巣箱に入るか(にわから消えるか)は garden.tsx の isNested と同じ条件の目安
 * (dozing で見守り中でない。「?」の有無はここでは見ない)
 */
function logScan(
  views: SessionView[],
  live: LiveSession[],
  unreliableConfigDirs: Set<string>,
  unreadable: number,
  endedIds: Set<string>,
): void {
  const liveById = new Map(live.map((l) => [l.sessionId, l]));
  const ids = new Set(views.map((v) => v.id));
  const short = (id: string) => sessionIdOfViewId(id).slice(0, 8);
  const gone = [...lastScanViewIds].filter((id) => !ids.has(id)).map(short);
  const back = [...ids].filter((id) => !lastScanViewIds.has(id)).map(short);
  lastScanViewIds = ids;
  const linked = views
    .filter((v) => v.peers && v.peers.length > 0)
    .map((v) => {
      const own = liveById.get(sessionIdOfViewId(v.id));
      const peers = (v.peers ?? [])
        .map((p) => `${p.sessionId.slice(0, 8)}(${liveById.get(p.sessionId)?.status ?? "not-live"}/${lastPeerStates.get(p.sessionId)?.state ?? "-"}/${p.active ? "active" : "inactive"}/${p.viewId ? "view" : "noview"}/lastActive=${p.lastActiveAt ? Math.round((Date.now() - p.lastActiveAt) / 1000) + "s" : "-"})`)
        .join(",");
      const nest = v.state === "dozing" && v.watching === undefined;
      return `${v.project}#${short(v.id)} ${own?.name ?? "?"} live=${own ? own.status : "no"} state=${v.state} since=${Math.round(v.sinceMs / 1000)}s watching=${v.watching ?? "-"} nest=${nest} peers=[${peers}]`;
    });
  const line =
    `[scan] live=${live.length} unreliable=[${[...unreliableConfigDirs].join(",")}] unreadable=${unreadable} ` +
    `ended=[${[...endedIds].map(short).join(",")}] gone=[${gone.join(",")}] back=[${back.join(",")}]\n  ` +
    (linked.length > 0 ? linked.join("\n  ") : "(no linked)");
  void invoke("log", { line }).catch(() => {});
}

/**
 * Jev の判定結果を、同じターンの done イベント(key = sessionId:at:done)の永続ログに書く。
 * デバッグダイアログで確率を見るため。done が抑止などでまだログに無いときは書かない
 */
export function recordAskJudgement(sessionId: string, at: number, ask: AskJudgement): void {
  const key = `${sessionId}:${at}:done`;
  const logged = eventLog.find((e) => e.key === key);
  if (!logged) return;
  logged.ask = ask;
  eventLogDirty = true;
}

/** デバッグダイアログ の DebugApp から永続イベントログを読むための入口。
 * 値の型はここ(lib/sessions.ts)が所有するため、fsa 側の loadEventLog<T> をラップして返す。
 * 廃止済み種別(旧 "harsh" 等)は KNOWN_EVENT_TYPES で無視する(hydrateEventLog と同じ方針) */
export async function loadPersistedEvents(): Promise<SessionEvent[]> {
  const saved = (await loadEventLog<SessionEvent>()) ?? [];
  return saved.filter((e) => isKnownEventType(e.type));
}

/**
 * tail のイベント列からセッションの遷移イベント(開始・応答待ち・完了・終了)を導出する。
 * done はターン途中の経過テキストを誤検知しないよう、次の分類イベントが
 * tool_use/tool_result でないものだけを完了とみなす。加えて、ひな(サブエージェント)が
 * まだ走行中なら「戻ってきて」信号としては早すぎるので抑止する(deriveDoneEvent)。
 * waiting は AskUserQuestion/ExitPlanMode の呼び出しを確定的なユーザー応答待ちとみなし、
 * 既に回答済みのものも履歴としてそのまま出す(タイムアウト推定はしない)。
 */
function deriveSessionEvents(
  tail: TailInfo,
  sessionId: string,
  project: string,
  chicks: ChickView[],
  backgroundTasks: Map<string, BackgroundTask>,
  snippet: string | undefined,
  now: number,
): SessionEvent[] {
  const result: SessionEvent[] = [];
  const events = tail.events;
  // イベント列を歩きながら「直前のユーザー発言」を追跡し、各イベントに自分のターンの
  // プロンプトを付ける。セッションの最新発言(snippet)を一律に付けると、first-write-wins
  // キャッシュ経由で過去イベントに無関係な発言が固定される(レビュー指摘)。
  // snippet は窓内に発言が無いときの代用にだけ使う
  let lastPrompt: string | undefined;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.kind === "user") {
      // 開始イベントは「そのプロンプト自体」を載せる。何を頼んだかがこのイベントの
      // 主情報なので、短い指示や単一セッションでも省略しない
      const prompt = event.text ? formatSnippet(event.text) : undefined;
      if (prompt) lastPrompt = prompt;
      result.push(mkSessionEvent(sessionId, project, "started", event.at, prompt ?? snippet));
    } else if (event.kind === "closed") {
      result.push(mkSessionEvent(sessionId, project, "closed", event.at, lastPrompt ?? snippet));
    } else if (event.kind === "assistant_text") {
      const next = events[i + 1];
      if (!next || (next.kind !== "tool_use" && next.kind !== "tool_result")) {
        // next が存在する(=T より後に何らかのイベントがある)ことは、親が既に再起動・
        // 続行していることの決定的な signal になる(deriveDoneEvent のキャンセル判定に使う)
        const parentAdvanced = next !== undefined;
        const done = deriveDoneEvent(
          sessionId,
          project,
          event.at,
          chicks,
          backgroundTasks,
          lastPrompt ?? snippet,
          now,
          parentAdvanced,
          event.text,
        );
        if (done) result.push(done);
      }
    } else if (event.kind === "tool_use" && isWaitingTool(event.toolName)) {
      result.push(mkSessionEvent(sessionId, project, "waiting", event.at, lastPrompt ?? snippet));
    }
  }
  return result;
}

/** 親 tail から見えた起動・完了を backgroundTaskCache に足し込み、そのセッションの台帳を返す */
function updateBackgroundTasks(sessionId: string, tail: TailInfo): Map<string, BackgroundTask> {
  let tasks = backgroundTaskCache.get(sessionId);
  if (!tasks) {
    tasks = new Map();
    backgroundTaskCache.set(sessionId, tasks);
  }
  for (const [taskId, startedAt] of tail.backgroundTaskStarts) {
    if (!tasks.has(taskId)) tasks.set(taskId, { startedAt });
  }
  for (const [taskId, task] of tasks) {
    const endedAt = tail.chickSignals.get(taskId);
    if (endedAt !== undefined && endedAt >= task.startedAt) task.endedAt = endedAt;
  }
  return tasks;
}

/**
 * 質問ツールの入力(JSON の先頭 500 字。lib/transcript.ts の summarizeToolInput、Codex は arguments)
 * から最初の質問文を取り出す。AskUserQuestion と request_user_input はどちらも questions[].question を持つ。
 * 500 字で切れて閉じの " が無いときは、切れたところまでを使う。ExitPlanMode は質問文を持たない(undefined)
 */
function extractQuestion(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const m = /"question"\s*:\s*"((?:[^"\\]|\\.)*)("?)/.exec(input);
  if (!m) return undefined;
  let text = m[1];
  if (m[2] === "") text = text.replace(/\\$/, ""); // 途中で切れた末尾のエスケープを落とす
  try {
    text = JSON.parse(`"${text}"`) as string;
  } catch {
    // エスケープが崩れていれば生のまま使う
  }
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

function isWaitingTool(toolName: string | undefined): boolean {
  return (
    toolName === "AskUserQuestion" ||
    toolName === "ExitPlanMode" ||
    toolName === "request_user_input"
  );
}

/**
 * メインが T で停止しても、T より後まで生きていたひな(サブエージェント)が1羽でもいれば、
 * その T の done はいったん抑止する(全員 done/dozing、または放置扱いになったスキャンで
 * 抑止明けになる)。ひなが本当に走行中か止まっているかは T との前後関係だけでは判定できない
 * (ひなは Bash 実行中など数十秒書き込みが空くのが普通で、T の瞬間にたまたま書き込みが
 * 無いだけの走行中のひなを「止まったひな」と誤判定してしまうため)。代わりに書き込みからの
 * 経過時間(sinceMs)そのものの鮮度で判定する: sinceMs が CHICK_ABANDONED_MS 未満なら
 * まだ生きている(working 固着でも抑止対象)、それ以上なら放置ひなとみなし無視する。
 * T は tail 上で不変な過去のイベントなので、抑止中は毎スキャンでこの関数が再評価され続け、
 * ひなが揃った時点で自然に抑止明けになる。
 *
 * 判定順序は「走行中ひなの抑止」を必ず先に行う。走行中のひなは今スキャン時点(now > T)で
 * 生きているのだから「T より後まで生きている」ことは書き込み時刻を見るまでもなく確定して
 * おり、まずここで抑止するかどうかを決める。この順序を守らないと、親ターン終了 T 直後の
 * 最初のスキャンでは走行中ひなでも最終書き込みがまだ T より前の瞬間があり、その瞬間だけ
 * wasAnyChickAliveAfterT が false になって即時発火の通常経路へ誤って抜けてしまう
 * (実害: T=16:58:17 に対し直前の書き込みが 16:58:1x で、done が抑止されず即時発火して鳴った)。
 * ループを抜けて走行中のひなが1羽もいないと確定してから初めて、T の時点でひなが全員
 * 終わっていた(chick なし、または全ひなの最終書き込みが T より前)かどうかを判定する。
 * 止まったひなの最終書き込み時刻はもう動かないため、この時点での比較は信頼できる。
 * 終わっていたケースはそもそも抑止が要らない即時発火の通常経路で、以下のキャンセル/猶予/
 * timeout の対象外(挙動は旧実装から変更なし)。「T より後まで生きていたひながいた」場合
 * だけが抑止 → 抑止明け → キャンセル/猶予/timeout の対象になる。
 *
 * 抑止明け後の発火は鮮度頼みではなく決定的な timeout+キャンセルにする(旧実装は at=T
 * 固定のまま App.tsx の鮮度ガード(EVENT_FRESHNESS_MS=30秒)頼みで、抑止明けが鮮度内に
 * 収まるかは実質運任せだった。実害: 親ターン終了17秒後にひなが完了 → 抑止明けの発火が
 * 鮮度30秒以内に収まって鳴り、その3秒後にハーネスが親を自動再起動して続行 → 最終ターンの
 * done がもう一度鳴り、二重鳴きになった)。
 * - **キャンセル**: 抑止明け時点で親の tail に T より後のイベント(kind 問わず)が既に
 *   存在する = 親は既に再起動・続行済み。この場合の done は当のイベントとして無意味なので、
 *   muted 付きで返す(ログ・EventFeed には残すが鳴らさない)。
 * - **猶予**: まだキャンセルもされておらず、ひなの最終書き込みから DONE_GRACE_MS も
 *   経っていなければ、親の再起動をもう少し待つ。null を返して次スキャンで再評価する。
 * - **timeout 発火**: DONE_GRACE_MS 経っても親が再起動していなければ、そのまま鳴らして良い
 *   done として発火する。at は key の基準である t のまま変えないため(理由は下記)、
 *   代わりに firedAt=now を付けて App.tsx の鮮度ガードがこれを見て判定できるようにする。
 *
 * at を t(=T、親自身のターン終了時刻)に固定したままにする理由:
 * - バックグラウンドエージェント完了時、ひな側の書き込み時刻 W で done を鳴らすと、
 *   直後にハーネスが親を自動再起動して完了報告を書き、そのターン終了(T2)でまた done が
 *   出て2回連続で鳴っていた(実害)。W 起点の1回目は常に冗長 — 親は必ず再起動され T2 の
 *   done を出すため。
 * - key(`sessionId:t:done`)が t 由来で不変になるため、抑止中・猶予中に何度再評価されても
 *   同じ key になり、sessionEventCache の first-write-wins(cacheEvent)・重複排除の両方と
 *   素直に整合する(at を可変にしていた旧実装のような「発火のたびに key が変わる」揺れが無い)。
 *
 * DONE_GRACE_MS(30秒)の根拠は定数定義のコメントを参照。
 *
 * バックグラウンドタスク(run_in_background の Bash 等。backgroundTaskCache)も、ひなと
 * 同じ理由で抑止する: 親が「裏で回しています」と書いて T で止まっても、タスク完了の
 * <task-notification> で親は必ず再開し、報告のターン終了 T2 で done を出す。T の done は
 * 冗長で、鳴らすと1回の依頼で2回しゃべる(実害: `claude -p` を裏で5本回す間の待機
 * 宣言が読み上げられた)。ひなと違い専用 transcript が無く生死は見えないため、判定は
 * 起動・完了通知の時刻だけで行う:
 * - T 以前に起動し、完了通知が未着のタスクがある → 抑止(null)
 * - T 以前に起動し、T より後に完了通知が来た → ひなの抑止明けと同じ扱い(親が再開済みなら
 *   muted、未再開なら DONE_GRACE_MS 猶予の後 timeout 発火)
 * 完了通知は completed/failed どちらでも来る(実データで確認)。通知行を見逃した場合の
 * 逃げ道は BACKGROUND_TASK_STALE_MS。
 * ひなと同じく、タスク走行中にユーザーと会話して終えたターンの done も抑止される。
 */
function deriveDoneEvent(
  sessionId: string,
  project: string,
  t: number,
  chicks: ChickView[],
  backgroundTasks: Map<string, BackgroundTask>,
  snippet: string | undefined,
  now: number,
  parentAdvanced: boolean,
  // このターンのアシスタント最終応答テキスト(assistant_text.text)。done 読み上げ要約
  // (lib/summarize.ts)の入力にするだけの一時値なので、生成した SessionEvent にそのまま
  // 載せて返す(永続化からの除外は appendToEventLog 側の責務)
  assistantText: string | undefined,
): SessionEvent | null {
  // バックグラウンドタスク: T 以前に起動したものだけが T の done に関係する
  let lastTaskEndAfterT: number | undefined;
  for (const task of backgroundTasks.values()) {
    if (task.startedAt > t) continue;
    if (task.endedAt === undefined) {
      if (now - task.startedAt < BACKGROUND_TASK_STALE_MS) return null; // 走行中 → 抑止
      continue; // 通知を見逃した可能性(BACKGROUND_TASK_STALE_MS 参照)
    }
    if (task.endedAt > t) lastTaskEndAfterT = Math.max(lastTaskEndAfterT ?? 0, task.endedAt);
  }

  // 走行中ひなの抑止を最初に判定する。走行中のひなは今スキャン時点(now > T)で生きている
  // のだから、「T より後まで生きている」ことは書き込み時刻を見るまでもなく確定している。
  // ここを wasAnyChickAliveAfterT の判定より後回しにすると、親ターン終了直後の最初の
  // スキャンでは走行中ひなでも最終書き込みがまだ T より前の瞬間があり、その瞬間だけ
  // wasAnyChickAliveAfterT が false と誤判定されて即時発火の通常経路へ抜けてしまう
  for (const chick of chicks) {
    if (chick.state === "done" || chick.state === "dozing") continue; // 終わったひなは無関係
    if (chick.sinceMs < CHICK_ABANDONED_MS) return null; // 走行中に見えるひなが1羽でもいれば抑止
    // sinceMs >= CHICK_ABANDONED_MS: 長時間書き込みが無い working 固着 = 放置ひなとみなし無視
  }

  // T より後にバックグラウンドタスクが終わった。ひなの抑止明けと同じく、親が再開済みなら
  // muted、再開待ちは DONE_GRACE_MS まで猶予、それでも再開しなければ timeout 発火
  if (lastTaskEndAfterT !== undefined) {
    if (parentAdvanced) {
      return { ...mkSessionEvent(sessionId, project, "done", t, snippet, assistantText), muted: true };
    }
    if (now - lastTaskEndAfterT < DONE_GRACE_MS) return null;
    return { ...mkSessionEvent(sessionId, project, "done", t, snippet, assistantText), firedAt: now };
  }

  // ここまで来たら走行中のひなはいない。止まったひなの最終書き込み時刻はもう動かないので、
  // この時点での比較(T より後まで生きていたひながいたか)は信頼できる
  const wasAnyChickAliveAfterT = chicks.some((chick) => now - chick.sinceMs > t);
  if (!wasAnyChickAliveAfterT) {
    // T の時点でひなは全員終わっていた(chick なしも含む) = 抑止不要、即時発火の通常経路
    return mkSessionEvent(sessionId, project, "done", t, snippet, assistantText);
  }

  // 抑止明け: 親が既に T より後のイベントを持っている(再起動・続行済み)なら、この done は
  // もう意味が無いのでミュートして返す(ログ・フィードには残す)
  if (parentAdvanced) {
    return { ...mkSessionEvent(sessionId, project, "done", t, snippet, assistantText), muted: true };
  }

  // 猶予中: ひなの最終書き込みから GRACE 未経過。親の再起動をもう少し待つ
  const lastChickWriteAt = Math.max(...chicks.map((chick) => now - chick.sinceMs));
  if (now - lastChickWriteAt < DONE_GRACE_MS) return null;

  // timeout 発火: GRACE 経っても親は再起動していない。鳴らして良い done として返す
  return { ...mkSessionEvent(sessionId, project, "done", t, snippet, assistantText), firedAt: now };
}

function mkSessionEvent(
  sessionId: string,
  project: string,
  type: SessionEvent["type"],
  at: number,
  snippet?: string,
  assistantText?: string,
): SessionEvent {
  return { key: `${sessionId}:${at}:${type}`, sessionId, project, snippet, type, at, assistantText };
}

/**
 * 表示対象になった親セッションについてだけ subagents/ を覗く
 * (<projectDir>/<sessionId>/subagents/agent-*.jsonl)。
 * ディレクトリが無い(NotFoundError)のはひな無しの正常系なので握りつぶす。
 *
 * parentChickSignals: 親 tail(readTailCached 済み)から取れた chickSignals。ひなの完了判定は
 * これを正とする(deriveState の isChick コメント参照)。呼び出し元(scanSessions)が
 * scanChicks より先に親 tail を読んでおく必要がある。
 */
async function scanChicks(
  projectDir: NativeDirectoryHandle,
  sessionFileName: string,
  parentId: string,
  now: number,
  parentChickSignals: Map<string, number>,
): Promise<ChickScan[]> {
  const sessionId = sessionFileName.replace(/\.jsonl$/, "");
  let subagentsDir: NativeDirectoryHandle;
  try {
    const sessionDir = await projectDir.getDirectoryHandle(sessionId);
    subagentsDir = await sessionDir.getDirectoryHandle("subagents");
  } catch (e) {
    // ディレクトリが無い(NotFoundError)のはひな無しの正常系。それ以外は異常なので痕跡を残す
    if (!(e instanceof DOMException && e.name === "NotFoundError")) {
      console.warn("[tomarigi] subagents 走査に失敗", parentId, e);
    }
    return [];
  }

  const chicks: ChickScan[] = [];
  for await (const entry of subagentsDir.values()) {
    if (entry.kind !== "file" || !entry.name.endsWith(".jsonl")) continue;
    const file = await (entry as NativeFileHandle).getFile();
    // 親スキャンの同種フィルタ(scanSessions 内コメント参照)と同じ理由で mtime のままでよい:
    // tail を読む前の粗い足切りであり、mtime は実際の最終会話時刻以上にしか進まない
    if (now - file.lastModified > ACTIVE_WINDOW_MS) continue;

    const chickId = `${parentId}/${entry.name}`;
    const tail = await readTailCached(chickId, file, { includeSidechain: true });
    // 親スキャンの sinceMs と同じ理由で tail.lastEventAt を基準にする(コメントは
    // scanSessions 内の同種箇所を参照)。sinceMs は表示用途なので mtime フォールバックを許容する
    const chickSinceBasis = tail.lastEventAt ?? file.lastModified;
    const sinceMs = now - chickSinceBasis;
    const meta = await resolveChickMeta(subagentsDir, entry.name, chickId);
    // ファイル名 agent-<task-id>.jsonl から task-id を復元する。task-notification の
    // <task-id> と一致する(実データで確認済み)。「agent-」接頭辞が無い命名でも
    // (将来的な変更があっても)そのままキーとして使うだけで、単に信号が引けず後続の
    // フォールバック判定に落ちるだけなので安全側に倒れる
    const taskId = entry.name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    // resume 判定(resolveChickDoneSignalAt)には mtime フォールバック前の tail.lastEventAt を
    // そのまま渡す。mtime を信用できないというのがこの関数の存在理由そのものであり、
    // sinceMs 用の chickSinceBasis で代用すると同じ問題(事後 touch を resume と誤認)を呼び戻す
    const chickDoneSignalAt = resolveChickDoneSignalAt(
      parentChickSignals,
      taskId,
      meta.toolUseId,
      tail.lastEventAt,
    );
    chicks.push({
      view: {
        id: chickId,
        name: meta.name,
        state: deriveState(tail, sinceMs, true, chickDoneSignalAt),
        sinceMs,
        toolName: tail.kind === "tool_use" ? tail.toolName : undefined,
      },
    });
  }
  chicks.sort((a, b) => a.view.sinceMs - b.view.sinceMs);
  return chicks;
}

/**
 * 親台帳(parentChickSignals)から、このひなの完了信号を解決する。ひなの識別子は2種類
 * ありうる(非同期起動=task-id、同期呼び出し=meta.json の toolUseId)ため両方引き、
 * 万一両方に信号が付いていれば新しい方を採用する(resume を繰り返すと両方が別々に
 * 更新されうるため)。
 *
 * 通常は片方しか値を持たない: task-id(task-notification)はエージェントが停止する
 * たびに毎回発火する仕様なので resume のたびに更新されうるが、toolUseId(tool_result)は
 * ブロッキング呼び出しの結果が一度返れば tool_use_id は API 上そこで解決済みになり
 * 再利用されない(以後の resume は SendMessage 等の別経路になり、新しい tool_use_id を
 * 持つ)ため1回しか値が付かない。両方に値が付くのは「同じひなが一度同期呼び出しで
 * 起動され、後で非同期扱いの通知系にも乗った」ような想定外のケースのみで、実データでは
 * 未確認。Math.max はその想定外ケースへの保険。
 *
 * 信号があっても、ひなの最終会話時刻(chickLastEventAt、tail.lastEventAt。mtime にはフォール
 * バックしない。理由は後述)がその信号より明確に後(CHICK_SIGNAL_EPSILON_MS を超えて後)なら、信号後にひなが resume されて
 * 書き込みを再開したとみなし無効化する(undefined を返す = 「信号なし」として扱わせる。同じ
 * task-id のひなは親が resume でき、同じ jsonl に書き込みが再開されるため、信号を過去のものと
 * して固定してしまうと resume 後もずっと done のままになってしまう)。
 * mtime ではなく最終会話時刻を使うのは、timestamp を持たない事後追記(mtime だけの touch)を
 * 誤って resume とみなさないため — mtime 基準だとゴースト touch のたびに有効な完了信号が
 * 無効化され、完了したはずのひなが働いているように見えてしまう。
 *
 * chickLastEventAt が undefined(tail 窓に timestamp 付き行が1つも無く最終会話時刻が不明)の
 * 場合は resume 判定自体をスキップし、信号をそのまま有効とみなす。mtime にはフォールバック
 * しない — 上記のとおり mtime を信用できないことがこの関数の存在理由そのものであり、代用すると
 * 同じ「事後 touch で完了済みひなが working に復活する」問題を呼び戻すため。
 */
function resolveChickDoneSignalAt(
  parentChickSignals: Map<string, number>,
  taskId: string,
  toolUseId: string | undefined,
  chickLastEventAt: number | undefined,
): number | undefined {
  const byTaskId = parentChickSignals.get(taskId);
  const byToolUseId = toolUseId ? parentChickSignals.get(toolUseId) : undefined;
  const signalAt =
    byTaskId === undefined ? byToolUseId : byToolUseId === undefined ? byTaskId : Math.max(byTaskId, byToolUseId);
  if (signalAt === undefined) return undefined;
  if (chickLastEventAt === undefined) return signalAt; // 最終会話時刻不明。resume と断定する根拠が無いので信号を有効のまま返す
  if (chickLastEventAt > signalAt + CHICK_SIGNAL_EPSILON_MS) return undefined; // resume 済み。信号は無効
  return signalAt;
}

interface ChickMeta {
  name: string; // meta.json の name→description→ファイル名の順で解決
  toolUseId?: string; // 起動時の tool_use id(Task/Agent 呼び出し)。同期完了信号の照合に使う
}

/**
 * agent-<id>.meta.json を読む。Claude Code の実データには name が存在せず description
 * のみが入っているため、name → description → ファイル名の順でフォールバックする。
 * toolUseId は同期ひな完了信号(resolveChickDoneSignalAt)の照合キー。
 */
async function resolveChickMeta(
  subagentsDir: NativeDirectoryHandle,
  fileName: string,
  chickId: string,
): Promise<ChickMeta> {
  const cached = chickMetaCache.get(chickId);
  if (cached) return cached;

  const base = fileName.replace(/\.jsonl$/, "");
  let meta: ChickMeta = { name: base };
  try {
    const metaHandle = await subagentsDir.getFileHandle(`${base}.meta.json`);
    const metaFile = await metaHandle.getFile();
    const raw = JSON.parse(await metaFile.text()) as {
      name?: string;
      description?: string;
      toolUseId?: string;
    };
    meta = {
      name: raw.name ?? raw.description ?? base,
      toolUseId: typeof raw.toolUseId === "string" ? raw.toolUseId : undefined,
    };
  } catch {
    // meta.json が無い/壊れている場合は名前をファイル名 fallback、toolUseId は無しのまま続行
    // (toolUseId が取れなくても task-id 経由の信号照合は生きるため致命的ではない)
  }
  chickMetaCache.set(chickId, meta);
  return meta;
}

/**
 * chickDoneSignalAt: ひなの done/dozing 判定は tail の見た目(kind)ではなく親台帳
 * (親 transcript の queue-operation/tool_result から取れる chickSignals、呼び出し元
 * scanChicks の resolveChickDoneSignalAt が解決)を正とする。これは実害への対策そのもの:
 * ひなが tool_use を挟まず一時的にテキストだけ書いた瞬間、tail.kind は
 * "assistant_text" に見えるが実際は作業継続中であることがあり、親の done 抑止解除の
 * 判定材料としてこの見た目をそのまま信用すると誤って抑止が解除されてしまう。親自身はこの曖昧さを
 * deriveSessionEvents の次イベント先読みで回避しているが、ひなの tail にはその仕組みが
 * 無いため、代わりに「親が観測した確定信号」を判定源にする。signal が無い(通知未着・
 * ハーネスの通知バグ・ひなの無言死)場合だけ、下記の CHICK_TEXT_DONE_MS によるフォール
 * バックで tail の見た目から done を推定する。
 */
function deriveState(
  tail: TailInfo,
  sinceMs: number,
  isChick: boolean,
  chickDoneSignalAt?: number,
): BirdState {
  // /clear・中断・シャットダウンで閉じたセッション。直後の書き込みで「作業中」に
  // 見せないよう、経過時間より先に判定する。ひな自身の transcript が閉じたという
  // ローカルな事実は、親台帳の(古いかもしれない)signal より強い情報なのでこちらを優先する
  if (tail.kind === "closed") return "dozing";
  // ユーザーへの質問ツールで止まっている。直近書き込みの有無に関わらず応答待ち
  if (!isChick && tail.kind === "tool_use" && isWaitingTool(tail.toolName)) return "waiting";
  // ひな専用の優先判定: 親台帳に確定信号があれば、tail の見た目(kind)に関わらず
  // done/dozing を返す(上記コメント参照)。sinceMs < WRITING_MS の早期 return より前に
  // 判定する — 信号がある以上「直近書き込みがあるから作業中」という推測は成り立たない
  if (isChick && chickDoneSignalAt !== undefined) {
    return sinceMs >= DOZE_MS ? "dozing" : "done";
  }
  if (sinceMs < WRITING_MS) return "working";
  switch (tail.kind) {
    case "tool_use":
      // ツール実行中は静止時間の長さに関わらず working(許可待ち疑いの推測は廃止済み)
      return "working";
    case "assistant_text":
      if (isChick) {
        // 親台帳に signal が無いときのフォールバック(上記コメント参照)。tail の見た目だけ
        // では「本当に完了したか、tool_use を挟まず一時的にテキストだけ書いただけか」を
        // 区別できないため、CHICK_TEXT_DONE_MS を超えて書き込みが無いときだけ done/dozing
        // とし、それまでは working のまま抑止を継続する(本バグの修正点そのもの)
        return sinceMs >= CHICK_TEXT_DONE_MS ? (sinceMs >= DOZE_MS ? "dozing" : "done") : "working";
      }
      return sinceMs >= DOZE_MS ? "dozing" : "done";
    case "user":
    case "tool_result":
      // assistant の次の出力待ち。応答待ちの長さで「立ち往生」を判定するのは誤検知しか
      // 出なかったため廃止済み(旧 stalled)。常に working とする
      return "working";
    default:
      // TailKind の内訳のうち closed は本関数冒頭で早期 return 済み、tool_use/
      // assistant_text/user/tool_result は上記ケースで処理済みのため、ここに来るのは
      // "unknown" だけ(readTail の窓が MAX_TAIL_BYTES まで広げても timestamp 付き行を
      // 1本も拾えなかったケース。lib/transcript.ts の MAX_TAIL_BYTES コメント参照)。
      // unknown は「完了した」根拠が無い(単に読めなかっただけ)ので done を経由させない —
      // done イベント・鳴き声の誤発火源になるため、書き込みが新しい間は working のまま倒し、
      // DOZE_MS を超えたら dozing だけを返す。
      // 注意: unknown のとき呼び出し元の sinceMs は mtime フォールバック由来(lastEventAt が
      // 無いため)。10f0aa5 で排除した mtime 依存がこの分岐にだけ残るが、到達条件が
      // 「2MB 窓でも timestamp 行ゼロ」という極端なケースに限られるため許容している。
      return sinceMs >= DOZE_MS ? "dozing" : "working";
  }
}

/**
 * SDK(Claude Agent SDK)経由で起動されたセッションを「ひな」として表示するときの専用状態
 * 判定。deriveState(isChick=true)をそのまま流用しない — 実データで確認した前提の違いによる:
 *
 * deriveState の isChick フォールバック(CHICK_TEXT_DONE_MS)は tail.kind === "assistant_text"
 * のときしか時間基準に倒さず、tail.kind が "user"/"tool_result" のときは常に working を返す。
 * これは「Task ツールで起動される本物のサブエージェントは、Task の戻り値が assistant の
 * text である以上、停止直前は必ず assistant_text で終わる」という前提に依っている。
 *
 * SDK セッションにはこの前提が成り立たない。Claude Agent SDK は構造化出力ツールで会話を
 * 終えるパターンがあり、その場合 transcript の最後の分類可能な行は tool_result のまま
 * 固着する(実データで確認済み・2026-08-08: SDK セッションの transcript の
 * tail 窓内で最後に分類される行が tool_result)。
 *
 * さらに SDK ひなには親台帳(chickSignals)由来の完了信号が構造的に存在しない
 * (chickDoneSignalAt は常に undefined。親 transcript 側の queue-operation/tool_result 経由の
 * 仕組みなので SDK セッション自身の tail には現れない)。信号による上書きが無いまま
 * deriveState をそのまま使うと、tool_result で終わる SDK ひなが ACTIVE_WINDOW_MS(30分)の
 * 間ずっと working に固着し、escalateWithChicks 経由で親も working に見え続け、
 * deriveDoneEvent の抑止判定(CHICK_ABANDONED_MS=10分)にも誤って乗ってしまう。
 *
 * そのため tool_use 実行中(kind==="tool_use")以外の全ての静止状態を CHICK_TEXT_DONE_MS の
 * フォールバック対象に広げる(assistant_text/user/tool_result を同列に扱う)。tool_use・
 * closed・unknown(default)の扱いは deriveState と同じにする。
 *
 * 孤児(orphanSdkEntries、親候補が無く大人表示にフォールバックした SDK セッション)の状態判定
 * にも使う(scanSessions の withTail ループ、isSdk 分岐)。孤児は表示上「大人の鳥」だが実体は
 * SDK セッションであり、tool_result 終端で working に固着する問題は deriveState のままだと
 * 解消されないため、大人表示でもこちらを使う。
 */
function deriveSdkChickState(tail: TailInfo, sinceMs: number): BirdState {
  if (tail.kind === "closed") return "dozing";
  if (sinceMs < WRITING_MS) return "working";
  switch (tail.kind) {
    case "tool_use":
      return "working";
    case "assistant_text":
    case "user":
    case "tool_result":
      return sinceMs >= CHICK_TEXT_DONE_MS ? (sinceMs >= DOZE_MS ? "dozing" : "done") : "working";
    default:
      // deriveState の default 分岐と同じ理由(unknown = tail 窓が読めなかっただけで
      // 「完了」の根拠が無い)で done を経由させない。lib/transcript.ts の
      // MAX_TAIL_BYTES コメント・deriveState の default 分岐コメント参照。
      return sinceMs >= DOZE_MS ? "dozing" : "working";
  }
}
