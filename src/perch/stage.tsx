import { Fragment, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { IconType } from "react-icons/lib";
// Material filled 系を使う。lucide 等の細線アウトラインは 12px・暗背景では沈むため、
// ステータス表示用に設計された塗りつぶし形状(check_circle / warning 等)で目立たせる
import {
  MdCheckCircle,
  MdHelp,
  MdPlayArrow,
  MdStopCircle,
  MdVolumeOff,
} from "react-icons/md";
import { t } from "@/lib/i18n";
import { hasQuestion, needsAnswer } from "@/lib/jev";
import { bubbleText, SpeechBubble } from "./bubble";
import type { BirdState, SessionEvent, SessionView } from "@/lib/sessions";
import type { IconSetAssignments, IconSetId } from "@/lib/icon-set-store";
import { DEFAULT_ICON_SET, ICON_SETS, resolveIconSet } from "./icon-sets";

// glyph は AX テキスト読み上げの代替・将来の画像読み込み失敗時フォールバック用に残す。
// 実表示は img(gpt-image-2 生成の WebP スプライト)を使う。img は ICON_SETS.birds を
// source にする(アイコンセット導入により画像の正本は icon-sets.ts 側に一本化した。
// birds はデフォルトセットなのでここでの参照は今までどおり成立する)
export const BIRD: Record<BirdState, { glyph: string; label: string; img: string }> = {
  working: {
    glyph: "🐦",
    label: t("birdWorkingLabel"),
    img: ICON_SETS.birds.working,
  },
  waiting: {
    glyph: "🕊️",
    label: t("birdWaitingLabel"),
    img: ICON_SETS.birds.waiting,
  },
  done: {
    glyph: "🕊️",
    // ターンを終えた状態の呼び名は、鳥の状態・イベント・音の設定のボタンで同じ語にそろえる(docs/design.md)
    label: t("eventDoneLabel"),
    img: ICON_SETS.birds.done,
  },
  dozing: {
    glyph: "💤",
    label: t("birdDozingLabel"),
    img: ICON_SETS.birds.dozing,
  },
};

/**
 * 状態ラベル。自分が返事待ち(asking)なら完了・うたた寝でも返事待ちの語(バッジと語を揃える)。
 * 見守り中(相手が動いている)なら見守り中の語。相手が聞いていても、見守り中の鳥は見守り中のまま
 */
export function birdLabel(state: BirdState, asking: boolean, watching = false): string {
  if (asking) return BIRD.waiting.label;
  if (watching) return t("birdWatchingLabel");
  return BIRD[state].label;
}

/** BirdState を絵文字ではなく WebP スプライトで表示する共通コンポーネント。
 * alt は空 — 呼び出し側で必ず隣に状態ラベルのテキストが並ぶため装飾扱いにできる。
 * flip はにわ用の左右反転(全員同じ向きだと剥製っぽいので、id 由来で半々に散らす)。
 * set はプロジェクトに割り当てられたアイコンセット(未指定は DEFAULT_ICON_SET = birds)。
 * asking はユーザーの返事待ち(lib/jev.ts の needsAnswer)。全アイコンセット共通の「?」バッジを
 * 右上に重ねる。にわ・止まり木・巣箱の一覧すべてこの部品で出す */
export function BirdGlyph({
  state,
  size,
  flip = false,
  set = DEFAULT_ICON_SET,
  asking = false,
}: {
  state: BirdState;
  size: number;
  flip?: boolean;
  set?: IconSetId;
  asking?: boolean;
}) {
  // working だけ「気を溜めているオーラ」演出クラスを付ける(perch.css の .bird-working-fx)。
  // flip は以前 style.transform: scaleX(-1) で直接反転していたが、working 時は同じ
  // transform プロパティを CSS アニメ(揺らぎ/ペック)側が握るため、カスタムプロパティ
  // (--glyph-flip)経由に変える。perch.css の .bird-glyph-img(静止時)と working の
  // 各 keyframes(アニメ中)が両方とも var(--glyph-flip, 1) を掛け合わせるので、
  // working/非 working どちらでも反転が保たれる
  // 値は文字列で渡す。React はカスタムプロパティ(--*)には px 付与をせず値をそのまま
  // 文字列化して通すため数値でも動くが、これは長さではなく scaleX の因子なので、
  // 単位付与の議論自体が当てはまらない値であることを文字列表記で明示しておく
  const style = flip ? ({ "--glyph-flip": "-1" } as CSSProperties) : undefined;
  return (
    <span className="bird-glyph" style={{ "--glyph-size": `${size}px` } as CSSProperties}>
      <img
        className={state === "working" ? "bird-glyph-img bird-working-fx" : "bird-glyph-img"}
        src={ICON_SETS[set][state]}
        width={size}
        height={size}
        alt=""
        draggable={false}
        style={style}
      />
      {asking && (
        <span className="bird-ask-badge" title={t("askingBadgeTitle")} aria-label={t("askingBadgeTitle")}>
          ?
        </span>
      )}
    </span>
  );
}

// イベント種別の色分類。個別の色を種別ごとにバラバラに割り当てず、意味の系統に束ねる
export type EventTone = "done" | "turn" | "alert" | "log";

// transcript から再構成した遷移イベント(実験機能)の見た目。アイコン(形状)+色(tone)+
// ラベルの三重で意味を運ぶ。チェックマーク等の記号として設計されたアイコンは
// 小サイズでも判読できるため、色ドット単独よりアイコンを採用する
export const EVENT: Record<SessionEvent["type"], { label: string; tone: EventTone; icon: IconType }> = {
  started: { label: t("eventStartedLabel"), tone: "log", icon: MdPlayArrow },
  done: { label: t("eventDoneLabel"), tone: "done", icon: MdCheckCircle },
  // 返事を待っている状態の呼び名は、鳥の状態・イベント・音の設定のボタンで同じ語にそろえる(docs/design.md)
  waiting: { label: t("birdWaitingLabel"), tone: "turn", icon: MdHelp },
  closed: { label: t("eventClosedLabel"), tone: "log", icon: MdStopCircle },
};

/** クリックで Ghostty のペインへ移れる要素に付ける属性(止まり木の行・イベントカード・にわの鳥)。
 * 対応が取れないもの(Codex・mock)は何も付けない = 押しても何も起きず、見た目も変えない */
export function focusProps(id: string, onFocus?: (id: string) => void, canFocus?: (id: string) => boolean) {
  if (!onFocus || !canFocus?.(id)) return {};
  return {
    className: "focusable",
    onClick: () => onFocus(id),
  };
}

/** working 中だけ表示する脈動ドット。「動いている行」を一目で分かるようにする。
 * garden.tsx からも同じ見た目を使うため export する */
export function LiveDots() {
  return (
    <span className="live-dots">
      <i />
      <i />
      <i />
    </span>
  );
}

/**
 * 止まり木の並び。見守り中でつながっている鳥のうち、先に起動した方(startedAt が小さい方。無ければ
 * 並びの先)を親にし、それ以外を親の直後に並べる。親は 1 段だけ(相手の相手は同じ親の下に並べる)
 */
function orderByWatchLinks(sessions: SessionView[]): {
  ordered: SessionView[];
  parentOf: Map<string, SessionView>;
} {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rank = new Map(sessions.map((s, i) => [s.id, i]));
  const earlier = (a: SessionView, b: SessionView) =>
    (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
  // つながりの成分ごとに、いちばん先に起動した鳥を親にする
  const rootOf = new Map<string, SessionView>();
  for (const start of sessions) {
    if (rootOf.has(start.id) || !start.peers?.some((p) => p.viewId && byId.has(p.viewId))) continue;
    const component: SessionView[] = [];
    const queue = [start];
    const seen = new Set([start.id]);
    while (queue.length > 0) {
      const current = queue.shift() as SessionView;
      component.push(current);
      for (const peer of current.peers ?? []) {
        const next = peer.viewId ? byId.get(peer.viewId) : undefined;
        if (next && !seen.has(next.id)) {
          seen.add(next.id);
          queue.push(next);
        }
      }
    }
    const root = [...component].sort(earlier)[0];
    for (const member of component) rootOf.set(member.id, root);
  }
  const parentOf = new Map<string, SessionView>();
  for (const [id, root] of rootOf) if (root.id !== id) parentOf.set(id, root);
  const ordered: SessionView[] = [];
  for (const s of sessions) {
    if (parentOf.has(s.id)) continue;
    ordered.push(s);
    for (const child of sessions) if (parentOf.get(child.id)?.id === s.id) ordered.push(child);
  }
  return { ordered, parentOf };
}

/**
 * 見守り中の親の下に並べる相手の名前。親と同じフォルダなら出さない(undefined。
 * にわのブロックでも同じ)。親の配下なら親の作業フォルダからの相対パス、配下でなければフォルダ名(表示名)
 */
export function relativeLabel(parent: SessionView, child: SessionView): string | undefined {
  const base = parent.cwd?.replace(/\/+$/, "");
  const own = child.cwd?.replace(/\/+$/, "");
  if (base && own === base) return undefined;
  if (base && own?.startsWith(`${base}/`)) return own.slice(base.length + 1);
  return child.project;
}

/**
 * 鳥の状態の行(状態の語 · 経過時間 · ツール名)。止まり木の行とにわの鳥の両方で使う。
 * 並べる先(止まり木の .bird-row-main、にわの .garden-status)は flex で、状態の語と経過時間は縮めず、
 * ツール名は全部が収まらなければ丸ごと隠す(perch.css の .bird-row-tool)。ツール名は最後に置き、
 * 隠れたときの空きが語と時間の間に出ないようにする。返事待ちは「返事待ち · 経過時間」だけ
 * (何を聞かれているかは吹き出しに出す)
 */
export function StatusParts({
  session,
  asking,
  liveDots = false,
}: {
  session: SessionView;
  asking: boolean;
  liveDots?: boolean;
}) {
  return (
    <>
      <span className="status bird-row-label">
        {/* 猶予の間(相手が止まって 5 分以内。watching が 0)も「見守り中」と出す。巣箱にしまわずにわに残している理由と
            同じ判定にそろえる(lib/watching.ts) */}
        {birdLabel(session.state, asking, session.watching !== undefined)}
      </span>
      <span className="status bird-row-since">
        &nbsp;· {formatSince(session.sinceMs)}
        {liveDots && session.state === "working" && <LiveDots />}
      </span>
      {session.toolName && !asking && (
        <span className="status bird-row-tool">
          <span>&nbsp;· {session.toolName}</span>
        </span>
      )}
    </>
  );
}

// 止まり木の行の依頼の抜き出しは、これより狭くなったら丸ごと隠す(「「.」のような切れ端を出さない)
const SNIPPET_MIN_VISIBLE_EM = 2.5;

/** 止まり木の行の依頼の抜き出し。幅は perch.css の .bird-row-snippet が決め、ここでは狭すぎるときに隠すだけ
 * (visibility なので幅は変わらず、測り直しでちらつかない) */
function RowSnippet({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const em = parseFloat(getComputedStyle(el).fontSize) || 11;
      el.dataset.tight = String(el.clientWidth < em * SNIPPET_MIN_VISIBLE_EM);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <span ref={ref} className="snippet bird-row-snippet">
      「{text}」
    </span>
  );
}

export function Perch({
  sessions,
  hasGranted,
  iconSetAssignments = {},
  onFocus,
  canFocus,
}: {
  sessions: SessionView[];
  hasGranted: boolean;
  onFocus?: (id: string) => void;
  canFocus?: (id: string) => boolean;
  // slug → 割り当ての辞書。未指定/割り当ての無い slug は resolveIconSet が
  // DEFAULT_ICON_SET へフォールバックする
  iconSetAssignments?: IconSetAssignments;
}) {
  if (sessions.length === 0) {
    return (
      <div className="empty">
        {t(hasGranted ? "emptyNoSessions" : "emptyNeedsReauth")}
      </div>
    );
  }
  // 見守り中のつながりは、先に起動した方を親にして相手の行をその下に字下げして並べる(docs/design.md)
  const { ordered, parentOf } = orderByWatchLinks(sessions);
  // 見守り中の組: 親の id(親自身は自分の id)。組の中の区切り線は破線、組の外との境目は実線にする
  const groupOf = (s: SessionView): string | undefined =>
    parentOf.get(s.id)?.id ?? (ordered.some((o) => parentOf.get(o.id)?.id === s.id) ? s.id : undefined);
  const continuesGroup = (s: SessionView, i: number): boolean => {
    const next = ordered[i + 1];
    const group = groupOf(s);
    return group !== undefined && next !== undefined && groupOf(next) === group;
  };
  return (
    <ul className="perch">
      {ordered.map((s, i) => {
        const parent = parentOf.get(s.id);
        const set = resolveIconSet(iconSetAssignments, s.slug);
        const focus = focusProps(s.id, onFocus, canFocus);
        const asking = needsAnswer(s.state, s.ask);
        const bubble = bubbleText(s);
        return (
          <Fragment key={s.id}>
            <li
              {...focus}
              className={`bird ${s.state}${parent ? " linked-child" : ""}${continuesGroup(s, i) ? " linked-continues" : ""} ${focus.className ?? ""}`}
            >
              {/* 1 段目(鳥・名前・状態)。吹き出しは 2 段目に別に置き、1 段目は折り返さない */}
              <div className="bird-row-main">
              <BirdGlyph state={s.state} size={18} set={set} asking={hasQuestion(s)} />
              {/* 幅が足りないときに縮める順は、依頼の抜き出し → 名前 → 状態(perch.css の .bird-row-*)。
                  状態の語と経過時間は常に残し、ツール名は収まらなければ丸ごと隠す */}
              {/* 字下げした相手の行は、親の作業フォルダからの相対パスで呼ぶ(配下でなければフォルダ名) */}
              {/* 親と同じフォルダの相手の行は名前を出さない(relativeLabel が undefined) */}
              {(() => {
                const name = parent ? relativeLabel(parent, s) : s.project;
                return name !== undefined && <span className="name bird-row-name">{name}</span>;
              })()}
              {/* 直近のユーザー発言(lib/sessions.ts が常時付与。窓内に発言が無いセッションのみ無し) */}
              {s.snippet && <RowSnippet text={s.snippet} />}
              <StatusParts session={s} asking={asking} liveDots />
              </div>
              {bubble && <SpeechBubble text={bubble} placement="row" />}
            </li>
            {/* ひなは親と同じプロジェクト所属なので、親と同じセットのひな画像(chick)を使う */}
            {s.chicks?.map((c) => (
              // ひなは親のペインへ移る(lib/ghostty.ts の focusTargetOf)
              <li
                key={c.id}
                {...focus}
                className={`chick ${c.state} ${focus.className ?? ""}`}
              >
                <img
                  className={
                    c.state === "working" ? "bird-glyph-img bird-working-fx" : "bird-glyph-img"
                  }
                  src={ICON_SETS[set].chick}
                  width={14}
                  height={14}
                  alt=""
                  draggable={false}
                />
                <span className="name">{c.name}</span>
                <span className="status">
                  {BIRD[c.state].label}
                  {c.toolName ? ` · ${c.toolName}` : ""} · {formatSince(c.sinceMs)}
                  {c.state === "working" && <LiveDots />}
                </span>
              </li>
            ))}
          </Fragment>
        );
      })}
    </ul>
  );
}

// 実験機能なので件数は控えめに絞る。
// カード = 1セッション。同一セッションの過去イベントは出さず、最新1件だけ表示する
const EVENT_FEED_CARD_LIMIT = 6;

// events は新しい順で来る(lib/sessions.ts)。sessionId ごとに最初に見た e が最新なので、
// Map の挿入順がそのまま「最新イベントを持つセッション順」= カード表示順になる
function pickLatestPerSession(events: SessionEvent[]): SessionEvent[] {
  const map = new Map<string, SessionEvent>();
  for (const e of events) {
    if (!map.has(e.sessionId)) map.set(e.sessionId, e);
  }
  return [...map.values()];
}

/** 表示上のイベント種別。Jev が返事待ちと判定したターンの done は、にわ・止まり木の「?」と
 * 揃えて応答待ちとして見せる(docs/design.md「判断待ちの鳥に「?」を付ける」) */
export function eventKind(e: SessionEvent): SessionEvent["type"] {
  return e.type === "done" && e.ask?.status === "asking" ? "waiting" : e.type;
}

export function EventFeed({
  events,
  showHeading = true,
  onFocus,
  canFocus,
}: {
  events: SessionEvent[];
  onFocus?: (id: string) => void;
  canFocus?: (id: string) => boolean;
  // タブビューでは上のタブラベルが見出しを兼ねるため h2 を出さない(App.tsx は常に false を渡す)
  showHeading?: boolean;
}) {
  const latest = pickLatestPerSession(events).slice(0, EVENT_FEED_CARD_LIMIT);
  return (
    <div className="event-feed">
      {showHeading && (
        <h2 className="event-feed-heading">{t("eventFeedHeading")}</h2>
      )}
      {events.length === 0 && (
        <p className="empty event-feed-empty">{t("emptyNoEvents")}</p>
      )}
      <motion.ul className="event-feed-list" layout>
        <AnimatePresence initial={false}>
          {latest.map((e) => {
            const kind = eventKind(e);
            const Icon = EVENT[kind].icon;
            const focus = focusProps(e.sessionId, onFocus, canFocus);
            return (
              <motion.li
                key={e.sessionId}
                onClick={focus.onClick}
                layout
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                // muted: ひな待ちで抑止されていた done が親の再起動でキャンセルされ、鳴らなかった
                // もの(lib/sessions.ts の deriveDoneEvent 参照)。カード全体を淡色化して、
                // 鳴った done と見分けが付くようにする(派手なバッジは付けない)
                className={`event-card event-${kind}${e.muted ? " event-muted" : ""} ${focus.className ?? ""}`}
              >
                <Icon className={`event-icon tone-${EVENT[kind].tone}`} size={16} />
                <div className="event-card-body">
                  <div className="event-card-head">
                    <span className="event-card-project">{e.project}</span>
                    {e.snippet && <span className="event-snippet">「{e.snippet}」</span>}
                  </div>
                  <div className="event-card-meta">
                    <span className="event-label">{EVENT[kind].label}</span>
                    {e.muted && (
                      <MdVolumeOff
                        className="event-mute-icon"
                        size={12}
                        role="img"
                        title={t("eventMutedTitle")}
                      />
                    )}
                    <span className="event-time">{formatEventTime(e.at)}</span>
                  </div>
                  {/* そのターンの吹き出しと同じ文(App.tsx の displayEvents が付ける) */}
                  {e.line && <SpeechBubble text={e.line} placement="row" />}
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </motion.ul>
    </div>
  );
}

export function formatSince(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return t("sinceSeconds", String(sec));
  const min = Math.floor(sec / 60);
  if (min < 60) return t("sinceMinutes", String(min));
  return t("sinceHoursMinutes", [
    String(Math.floor(min / 60)),
    String(min % 60),
  ]);
}

// 絶対時刻(HH:MM)ではなく相対時間で出す。止まり木行の formatSince と同じ表記に
// 揃えることで、追加の i18n キーなしに43ロケール対応を維持する。
// 再描画はポーリング(3秒)ごとの setEvents で起きるため、表示も自然に追従する
export function formatEventTime(at: number): string {
  return formatSince(Math.max(0, Date.now() - at));
}
