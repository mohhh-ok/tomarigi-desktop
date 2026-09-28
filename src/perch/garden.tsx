import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { t } from "@/lib/i18n";
import {
  autoGardenPosition,
  clampGardenPosition,
  gardenCellOf,
  gardenGrid,
  hashId,
  loadGardenPositions,
  saveGardenPositions,
  type GardenPosition,
} from "@/lib/garden-layout";
import nestImg from "@/assets/birds/nest.webp";
import type { SessionEvent, SessionView } from "@/lib/sessions";
import type { IconSetAssignments, IconSetId } from "@/lib/icon-set-store";
import { resolveIconSet } from "./icon-sets";
import { hasQuestion, needsAnswer } from "@/lib/jev";
import { createPortal } from "react-dom";
import { MdLink } from "react-icons/md";
import { bubbleText, SpeechBubble } from "./bubble";
import {
  BIRD,
  BirdGlyph,
  EVENT,
  eventKind,
  StatusParts,
  focusProps,
  formatEventTime,
  formatSince,
  relativeLabel,
} from "./stage";

// にわのノードの幅(perch.css の .garden-node)と、枠からの最小の空き
const NODE_WIDTH_PX = 120;
const NODE_EDGE_PX = 4;

/**
 * ノードのうち実際に見えている幅(鳥・名前・状態の行のいちばん広いもの)。ノードの箱(120px)で
 * 寄せると、狭いにわで鳥が中央の細い帯に押し込まれて重なるため、見えている中身で測る
 */
function visibleWidth(node: HTMLElement | null): number {
  if (!node) return 0;
  let width = 0;
  for (const selector of [".garden-glyph", ".garden-name", ".garden-status"]) {
    const el = node.querySelector<HTMLElement>(selector);
    if (el) width = Math.max(width, el.offsetWidth);
  }
  // 「?」は鳥の右へはみ出すので、そのぶんを足す
  const badge = node.querySelector<HTMLElement>(".bird-ask-badge");
  return badge ? width + badge.offsetWidth : width;
}

/** min..max に収める。にわが鳥より小さいときは min(左・上に寄せる) */
function clampInside(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(Math.max(value, min), max);
}

// 吹き出しの高さ + 鳥との間。吹き出しのある鳥は、アイコンと名前の間をこれだけ空けて吹き出しを置く
// (perch.css の .garden-bubble-room の height と同じ値)
const BUBBLE_ROOM_PX = 26;
// にわのノードのうち、グリフ以外(名前・状態の行)の高さの見積もり
const NODE_TEXT_PX = 32;
// 自動配置で鳥どうしの間に空ける幅(px)
const AUTO_GAP_PX = 12;
// 吹き出しの最大幅の見積もり(perch.css の .speech-bubble-below の max-width 15em × 11px + 左右の padding)
const BUBBLE_MAX_PX = 180;
// にわの右下の巣箱(perch.css の .garden-nest)の高さ。この下端の帯には自動配置で鳥を置かない
const NEST_ROOM_PX = 28;
// perch.css の .garden の min-height(style で上書きするので、それより小さくはしない)
const GARDEN_MIN_HEIGHT_PX = 220;
// 吹き出しをにわの枠からこれだけ内側に置く
const BUBBLE_EDGE_PX = 4;

/** 鳥の横位置(px)と、吹き出しを収める範囲 lo..hi(px。にわの枠か見守り中のブロックの内側)から、吹き出しを枠の内側に収める位置。真下に収まるなら undefined(中央ぞろえ) */
function bubbleShift(x: number, lo: number, hi: number): CSSProperties | undefined {
  if (hi <= lo) return undefined;
  const half = BUBBLE_MAX_PX / 2;
  if (x - half < lo) {
    const tail = x - lo;
    return {
      left: `calc(50% - ${tail}px)`,
      transform: "none",
      "--tail-left": `${tail}px`,
    } as CSSProperties;
  }
  if (x + half > hi) {
    const tail = hi - x;
    return {
      left: "auto",
      right: `calc(50% - ${tail}px)`,
      transform: "none",
      "--tail-left": "auto",
      "--tail-right": `${tail}px`,
    } as CSSProperties;
  }
  return undefined;
}

// ドラッグ中のノードの重なり順。吹き出しの順(1〜羽数)より上
const BUBBLE_Z_DRAGGING = 1000;

// 見守り中のまとまり(docs/design.md): つながっている鳥を小さな格子に寄せて並べ、角丸のブロックで囲む。
// 1 マスの幅・ブロックの内側の余白・ブロックと枠の空き
const WATCH_CELL_W = 96;
const WATCH_PAD = 8;
const WATCH_EDGE = 4;
// 見守り中の鳥の足元の、動いている相手の数の行の高さ(perch.css の .garden-watch-count。字の高さ + 上の空き)
const WATCH_COUNT_PX = 18;
// にわの鳥の名前の行の高さ(perch.css の .garden-name。字の高さ + 下の空き)。ブロックの中で名前を出さない段はこのぶん詰める
const GARDEN_NAME_PX = 16;
// ブロックの上辺に出す親の名前の行の高さ(perch.css の .garden-watch-block-name)
const WATCH_TITLE_PX = 16;
// 状態の行の 2 段目(ツール名。ブロックの中では経過時間とツール名)の高さ(perch.css の .garden-status-sub)
const STATUS_SUB_PX = 15;

/** まとまりの中での鳥の位置。CSS の left(鳥の中心)/top(鳥の上辺。段の上端に名前をそろえる)(にわの大きさが変わっても
    追従する式)と、今の大きさでの px */
interface WatchPlace {
  left: string;
  top: string;
  // 段に吹き出しの出る鳥がいれば、吹き出しの無い鳥にも吹き出しの空きを取り、段の中で状態の行の高さをそろえる。
  // 隣の鳥の吹き出し(1 マスより広い)が、自分の状態の行に掛からないようにする
  bubbleRoom?: boolean;
  x: number;
  y: number;
  // 吹き出しを収める横の範囲(px)。ブロックの内側(余白の内側)。ブロックに入っていない鳥には無い。
  // これがある鳥だけ top が鳥の上辺(ブロックの外へ出した鳥の top は中心)
  bubbleRange?: { lo: number; hi: number };
  // ブロックの中の鳥の名前(docs/design.md「ブロックで囲んだときは名前を 1 つにする」)。親と同じフォルダの鳥・親は undefined。
  // nameRoom は段に名前のある鳥がいるか。いれば名前の無い鳥も名前の行の高さを空け、段の中でアイコンの高さをそろえる
  label?: string;
  nameRoom?: boolean;
}

/** まとまりの鳥がドラッグで動かすもの。rootId はまとまりの最初に起動した鳥、anchor はブロックの今の基準位置(%) */
interface WatchGroupRef {
  rootId: string;
  anchor: GardenPosition;
}

interface WatchBlock {
  key: string;
  // ブロックの上辺に出す親(見守り中の鳥)の名前
  title: string;
  left: string;
  top: string;
  width: number;
  height: number;
}

/**
 * 見守り中でつながっている鳥(にわにいるものどうし)をまとまりにし、最初に起動した鳥の位置を中心に
 * 格子状に寄せる。まとまりの幅はにわの幅に収まる列数にし、ブロックも枠の内側に収める。
 * 吹き出しが出る鳥がいれば、行ごとに吹き出しの高さぶんを空け、吹き出しがブロックの枠に掛からないようにする
 */
function layoutWatchGroups(
  awake: SessionView[],
  positionOf: (id: string) => GardenPosition,
  containerW: number,
  containerH: number,
  glyphSize: number,
  // ドラッグ中のまとまり(最初に起動した鳥の id)。ほかのブロックに押し戻さず、指に付いてこさせる
  draggingRootId?: string,
  // 鳥の見えている大きさ(px)。前回の描画の実寸。まだ描いていなければ undefined(見積もりを使う)
  sizeOf: (id: string) => { w: number; h: number } | undefined = () => undefined,
): { blocks: WatchBlock[]; places: Map<string, WatchPlace>; groupOf: Map<string, WatchGroupRef> } {
  const byId = new Map(awake.map((s) => [s.id, s]));
  const rank = new Map(awake.map((s, i) => [s.id, i]));
  const earlier = (a: SessionView, b: SessionView) =>
    (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
  const seen = new Set<string>();
  const blocks: WatchBlock[] = [];
  const places = new Map<string, WatchPlace>();
  const groupOf = new Map<string, WatchGroupRef>();
  const groups: {
    members: SessionView[];
    labels: (string | undefined)[];
    cols: number;
    rowTops: number[];
    bubbleRoom: number;
    width: number;
    height: number;
    anchor: GardenPosition;
  }[] = [];
  for (const start of awake) {
    if (seen.has(start.id)) continue;
    const component: SessionView[] = [];
    const queue = [start];
    seen.add(start.id);
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
    if (component.length < 2) continue;
    const members = component.sort(earlier);
    const n = members.length;
    const fitCols = containerW > 0 ? Math.floor((containerW - 2 * (WATCH_EDGE + WATCH_PAD)) / WATCH_CELL_W) : 3;
    const cols = Math.max(1, Math.min(n, fitCols));
    const rows = Math.ceil(n / cols);
    const bubbleRoom = members.some((m) => bubbleText(m) !== undefined) ? BUBBLE_ROOM_PX : 0;
    // 1 段の高さ: 名前 + 鳥 + 吹き出しの高さ + 状態の行 + イベントの印の行 + (見守り中の鳥がいれば)足元の数の行。
    // 吹き出しが下の段の名前・鳥に掛からないよう、吹き出しの高さを段に含める
    const countRoom = members.some((m) => m.watching !== undefined) ? WATCH_COUNT_PX : 0;
    // 名前は親(先に起動した鳥。止まり木の字下げの親と同じ)の名前をブロックの上辺に 1 つだけ出す。中の鳥は、親と同じフォルダ
    // なら出さず、別のフォルダなら親からの相対パス(配下でなければフォルダ名)。名前の無い段は名前の行を詰める
    const parent = members[0];
    const labels = members.map((m, i) => (i === 0 ? undefined : relativeLabel(parent, m)));
    const rowTops: number[] = [];
    let y = WATCH_PAD + WATCH_TITLE_PX;
    for (let r = 0; r < rows; r++) {
      rowTops.push(y);
      const named = labels.slice(r * cols, (r + 1) * cols).some((l) => l !== undefined);
      // 吹き出しの空きは、吹き出しの出る鳥がいる段だけに取る(隣の鳥の吹き出しが掛かるのは同じ段だけ。
      // 吹き出しの無い段まで空けると、アイコンと状態の行の間が間延びする)
      const rowBubble = members.slice(r * cols, (r + 1) * cols).some((m) => bubbleText(m) !== undefined);
      y +=
        glyphSize +
        NODE_TEXT_PX -
        (named ? 0 : GARDEN_NAME_PX) +
        14 +
        STATUS_SUB_PX +
        countRoom +
        (rowBubble ? BUBBLE_ROOM_PX : 0);
    }
    rowTops.push(y);
    // 吹き出しの出る鳥がいれば、吹き出しがブロックの内側に収まる幅を下限にする
    const width = Math.max(cols * WATCH_CELL_W, bubbleRoom > 0 ? BUBBLE_MAX_PX : 0) + 2 * WATCH_PAD;
    const height = y + WATCH_PAD;
    groups.push({ members, labels, cols, rowTops, bubbleRoom, width, height, anchor: positionOf(members[0].id) });
  }
  // ドラッグ中のまとまりを最初に置き(押し戻さない)、ほかは上から順に置く
  groups.sort(
    (a, b) =>
      Number(b.members[0].id === draggingRootId) - Number(a.members[0].id === draggingRootId) ||
      a.anchor.y - b.anchor.y,
  );
  // 1) ブロックを置く(px)。ブロックどうしが重なったら後のものを下(入らなければ上)へずらす
  const layoutReady = containerW > 0 && containerH > 0;
  const placedGroups: { group: (typeof groups)[number]; cx: number; cy: number }[] = [];
  const rectOf = (g: (typeof groups)[number], cx: number, cy: number) => ({
    top: cy - g.height / 2,
    bottom: cy + g.height / 2,
    left: cx - g.width / 2,
    right: cx + g.width / 2,
  });
  for (const group of groups) {
    const { width, height, anchor: wanted } = group;
    const halfW = width / 2 + WATCH_EDGE;
    const halfH = height / 2 + WATCH_EDGE;
    const cx = clampInside((wanted.x / 100) * containerW, halfW, containerW - halfW);
    let cy = clampInside((wanted.y / 100) * containerH, halfH, containerH - halfH);
    if (layoutReady) {
      const overlaps = (y: number) =>
        placedGroups
          .map((pg) => rectOf(pg.group, pg.cx, pg.cy))
          .filter(
            (r) =>
              cx - width / 2 < r.right && cx + width / 2 > r.left && y - height / 2 < r.bottom && y + height / 2 > r.top,
          );
      let hits = overlaps(cy);
      // 下へずらす。入らなければ上の空きを探す
      while (hits.length > 0 && cy + halfH <= containerH) {
        cy = Math.max(...hits.map((r) => r.bottom)) + WATCH_EDGE + height / 2;
        hits = overlaps(cy);
      }
      if (hits.length > 0 || cy + halfH > containerH) {
        cy = halfH;
        hits = overlaps(cy);
        while (hits.length > 0 && cy + halfH <= containerH) {
          cy = Math.max(...hits.map((r) => r.bottom)) + WATCH_EDGE + height / 2;
          hits = overlaps(cy);
        }
        cy = clampInside(cy, halfH, containerH - halfH);
      }
    }
    placedGroups.push({ group, cx, cy });
  }

  // 2) まとまりに入らない鳥がブロックに掛かっていたら、まとまりの一員に見えないようブロックの外へ出す。
  // 保存位置(IndexedDB)から始まったときも同じ。ブロックの上下左右に鳥 1 羽ぶんの空きがどこにも無ければ、
  // そのブロックを鳥と反対側のにわの端(上か下)へ寄せて空きを作り、もう一度探す
  const outside = new Map<string, { x: number; y: number }>();
  if (layoutReady && placedGroups.length > 0) {
    const members = new Set(placedGroups.flatMap((pg) => pg.group.members.map((m) => m.id)));
    const rects = () => placedGroups.map((pg) => rectOf(pg.group, pg.cx, pg.cy));
    for (const s of awake) {
      if (members.has(s.id)) continue;
      // 鳥ごとに、実際に見えている大きさ(前回の描画の実寸。まだ無ければ見積もり)で空きを探す。
      // ノードの箱(120px)で見積もると、狭いにわでブロックの横の空きに入らないと判定される
      const size = sizeOf(s.id);
      const halfW = (size?.w ?? NODE_WIDTH_PX) / 2;
      const halfH = (size?.h ?? glyphSize + NODE_TEXT_PX) / 2;
      const hitRect = (xx: number, yy: number) =>
        rects().findIndex(
          (r) => xx - halfW < r.right && xx + halfW > r.left && yy - halfH < r.bottom && yy + halfH > r.top,
        );
      const freeSpot = (x: number, y: number) => {
        const rs = rects();
        const xs = [x, ...rs.flatMap((r) => [r.left - WATCH_EDGE - halfW, r.right + WATCH_EDGE + halfW])];
        const ys = [y, ...rs.flatMap((r) => [r.top - WATCH_EDGE - halfH, r.bottom + WATCH_EDGE + halfH])];
        let best: { x: number; y: number; d: number } | undefined;
        for (const cx of xs) {
          for (const cy of ys) {
            if (cx < halfW || cx > containerW - halfW || cy < halfH || cy > containerH - halfH) continue;
            if (hitRect(cx, cy) >= 0) continue;
            const d = Math.hypot(cx - x, cy - y);
            if (!best || d < best.d) best = { x: cx, y: cy, d };
          }
        }
        return best;
      };
      const pos = positionOf(s.id);
      const x = clampInside((pos.x / 100) * containerW, halfW, containerW - halfW);
      const y = clampInside((pos.y / 100) * containerH, halfH, containerH - halfH);
      const hit = hitRect(x, y);
      if (hit < 0) continue;
      let best = freeSpot(x, y);
      if (!best) {
        // ドラッグ中のブロックは動かさない(指に付いてくる位置を優先する)
        const pg = placedGroups[hit];
        if (pg.group.members[0].id !== draggingRootId) {
          const halfBlockH = pg.group.height / 2 + WATCH_EDGE;
          pg.cy = y < pg.cy ? containerH - halfBlockH : halfBlockH;
          best = freeSpot(x, y);
        }
      }
      if (best) outside.set(s.id, { x: best.x, y: best.y });
    }
  }

  // 3) ブロックと鳥の位置を書き出す。位置は割合に戻して CSS の式にする(にわの大きさが変わっても追従する)
  for (const { group, cx, cy } of placedGroups) {
    const { members, labels, cols, rowTops, width, height, anchor: wanted } = group;
    const rows = rowTops.length - 1;
    const n = members.length;
    const halfW = width / 2 + WATCH_EDGE;
    const halfH = height / 2 + WATCH_EDGE;
    const anchor = layoutReady ? { x: wanted.x, y: (cy / containerH) * 100 } : wanted;
    const blockLeft = `clamp(${halfW}px, ${anchor.x}%, calc(100% - ${halfW}px))`;
    const blockTop = `clamp(${halfH}px, ${anchor.y}%, calc(100% - ${halfH}px))`;
    blocks.push({ key: members[0].id, title: members[0].project, left: blockLeft, top: blockTop, width, height });
    for (const m of members) groupOf.set(m.id, { rootId: members[0].id, anchor });
    members.forEach((m, i) => {
      const row = Math.floor(i / cols);
      const inRow = row === rows - 1 ? n - row * cols : cols;
      const col = i % cols;
      // ブロックを吹き出しの幅まで広げたときは、格子をブロックの中央に置く
      const spare = (width - 2 * WATCH_PAD - cols * WATCH_CELL_W) / 2;
      const dx = -width / 2 + WATCH_PAD + spare + ((cols - inRow) / 2 + col + 0.5) * WATCH_CELL_W;
      // 鳥の上辺(名前)を段の上端にそろえる。鳥ごとに下の行(足元の数・印)の有無で背が違っても、名前とアイコンの高さがそろう
      const dy = -height / 2 + rowTops[row];
      places.set(m.id, {
        left: `calc(${blockLeft} + ${dx}px)`,
        top: `calc(${blockTop} + ${dy}px)`,
        x: cx + dx,
        y: cy + dy + (rowTops[row + 1] - rowTops[row]) / 2,
        bubbleRoom: members.slice(row * cols, (row + 1) * cols).some((m) => bubbleText(m) !== undefined),
        label: labels[i],
        nameRoom: labels.slice(row * cols, (row + 1) * cols).some((l) => l !== undefined),
        bubbleRange: { lo: cx - width / 2 + WATCH_PAD, hi: cx + width / 2 - WATCH_PAD },
      });
    });
  }
  for (const [id, { x, y }] of outside) {
    places.set(id, { left: `${(x / containerW) * 100}%`, top: `${(y / containerH) * 100}%`, x, y });
  }
  return { blocks, places, groupOf };
}

/** 巣箱にしまう鳥。dozing でも「?」が付いている間はにわに残す(docs/design.md「判断待ちの鳥に「?」を付ける」) */
function isNested(s: SessionView): boolean {
  // 見守り中(相手が動いている)も、にわに残す
  // 見守り中(相手が止まってから猶予の間の 0 を含む。lib/watching.ts)は、にわに残す
  return s.state === "dozing" && !hasQuestion(s) && s.watching === undefined;
}

// これ未満しか動かさずに離したらドラッグではなくクリック(Ghostty のペインへ移る)とみなす
const CLICK_SLOP_PX = 4;

// ノードの足元に並べる直近イベントアイコンの件数(にわが混み合わないよう最新1件のみ)
const HISTORY_LIMIT = 1;

// 退場中(巣箱へ寝に行く/フェードで消える)ノードのスナップショット。leaving に入っている
// 間だけ描画される。session/position は「まだ awake だった最後のレンダー」の値を凍結する
type LeavingEntry = {
  session: SessionView;
  position: GardenPosition;
  target: "nest" | "fade";
};

// 巣箱との行き来アニメーション用に、ノード位置(position%)から巣箱(コンテナ右下
// 概算位置)までの px オフセットを計算する。rect が取れない/幅0(タブ非表示)の
// ときは固定のフォールバック値を使う
function nestOffset(
  containerRef: RefObject<HTMLDivElement | null>,
  position: GardenPosition,
): { dx: number; dy: number } {
  const rect = containerRef.current?.getBoundingClientRect();
  if (!rect || rect.width === 0) return { dx: 120, dy: 140 };
  const nodeX = (position.x / 100) * rect.width;
  const nodeY = (position.y / 100) * rect.height;
  const nestX = rect.width - 30;
  const nestY = rect.height - 20;
  return { dx: nestX - nodeX, dy: nestY - nodeY };
}

export function Garden({
  sessions,
  events,
  hasGranted,
  iconSetAssignments = {},
  onFocus,
  canFocus,
}: {
  sessions: SessionView[];
  events: SessionEvent[];
  hasGranted: boolean;
  // slug → 割り当ての辞書(stage.tsx の Perch と同じ意味。App.tsx から渡される)
  iconSetAssignments?: IconSetAssignments;
  onFocus?: (id: string) => void;
  canFocus?: (id: string) => boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 保存済みの位置のみを持つ(index 由来の自動配置はここに含めない)。
  // 自動配置はドラッグされるまで永続化しない = 未ドラッグのまま消えたセッションが
  // ストレージに残らない
  const [positions, setPositions] = useState<Record<string, GardenPosition>>({});
  // 自動配置の sticky 割り当て(id → 位置)。render 中に読み書きするが、割り当ては
  // 決定的かつ一度きりなので冪等。永続化はしない(ドラッグされたら positions 側に移る)
  const autoPosRef = useRef<Map<string, GardenPosition>>(new Map());
  // autoPosRef を決めたときの格子(列x行)
  const autoGridRef = useRef("");

  useEffect(() => {
    let alive = true;
    void loadGardenPositions().then((loaded) => {
      if (alive) setPositions(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);

  // コンテナ(.garden)実寸。羽数に応じたグリフサイズ計算に使う。ResizeObserver で
  // 窓のリサイズにも追従する
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // にわの枠(.garden)は鳥が 1 羽もいないと描かれない(下の早期 return)。最初の描画で枠が無いと見張りが
  // 付かないまま残り、窓の大きさを変えても並びが古い大きさのままになっていたため、枠が現れたときに付け直す。
  // 窓のリサイズでも取り直す(ResizeObserver が別 document への移動で切れた場合の保険)
  const hasGardenFrame = sessions.length > 0;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setContainerSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const win = el.ownerDocument.defaultView ?? window;
    win.addEventListener("resize", measure);
    measure();
    return () => {
      ro.disconnect();
      win.removeEventListener("resize", measure);
    };
  }, [hasGardenFrame]);

  // 保険: 自分を含む portalHost が PiP 窓へ document.body.append で移動されるため
  // (App.tsx 参照)、別 document への移動中に ResizeObserver が切れる可能性がある。
  // 毎レンダー後に getBoundingClientRect でも実寸を取り直しておけば、3秒ポーリングによる
  // 再レンダーで最大3秒以内に追従する。値が同じなら setState しない(無限ループ防止)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setContainerSize((prev) =>
      prev.w === rect.width && prev.h === rect.height ? prev : { w: rect.width, h: rect.height },
    );
  });

  // タブ初期表示時に既に居る鳥は飛来アニメーションを飛ばさず static に並べたい。
  // 初回 render の時点では false のまま(=このレンダーで作られる全ノードは
  // entryOrigin="none" を受け取る)、コミット後の effect で true にする。以後の
  // ポーリングで新規マウントされるノードだけ animateEntry=true になる
  const initializedRef = useRef(false);
  const animateEntry = initializedRef.current;
  useEffect(() => {
    initializedRef.current = true;
  }, []);

  // 「起きた鳥は巣箱から飛び出す」演出のため、直前のスキャンで dozing だった id を
  // 覚えておく。sessions を直接フィルタするので早期 return(sessions.length===0)の
  // 影響を受けず、hooks の呼び出し順が毎レンダー一定に保たれる
  const prevDozingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    prevDozingRef.current = new Set(
      sessions.filter(isNested).map((s) => s.id),
    );
  });

  // 退場(巣箱へ寝に行く/フェードで消える)アニメーション中のノード。AnimatePresence の
  // 代替: awake から消えた id をここへ移し、GardenNode 側の WAAPI 退場アニメーションが
  // 終わったら onExited 経由で削除する
  const [leaving, setLeaving] = useState<Map<string, LeavingEntry>>(new Map());
  // 直前レンダーで awake だった id → {session, position} のスナップショット。leaving へ
  // 追加する際、消えた瞬間の見た目(まだ awake だった頃の state)を凍結するために使う
  const awakeSnapshotRef = useRef<Map<string, { session: SessionView; position: GardenPosition }>>(
    new Map(),
  );

  const handleExited = useCallback((id: string) => {
    setLeaving((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // glyphSize の直前値(幅0で計算をスキップする間も直前サイズを保つため)
  const glyphSizeRef = useRef(30);

  const handleDragEnd = useCallback((id: string, next: GardenPosition, liveIds: string[]) => {
    setPositions((prev) => {
      // 消えたセッションの位置は保存時にプルーニングする(現存 id だけ残す)
      const currentIds = new Set(liveIds);
      const pruned: Record<string, GardenPosition> = {};
      for (const [pid, ppos] of Object.entries(prev)) {
        if (currentIds.has(pid)) pruned[pid] = ppos;
      }
      pruned[id] = next;
      void saveGardenPositions(pruned);
      return pruned;
    });
  }, []);

  // dozing (長時間 idle) は個別ノードとして庭に出さず、巣箱 1 個に集約する
  // (issue #12d: 「dozing のセッションが庭に居座ってうざい」フィードバック)。
  // liveIds には dozing の id も含めたままにする — 寝てる間に保存位置が
  // プルーニングされると、起きたときに位置がリセットされてしまうため。
  // 下の useLayoutEffect が毎レンダー呼ばれる必要がある(Hooks のルール)ため、
  // sessions.length===0 の早期 return より前に計算する
  const liveIds = sessions.map((s) => s.id);
  const awake = sessions.filter((s) => !isNested(s));
  const dozing = sessions.filter(isNested);
  const [bubbleLayer, setBubbleLayer] = useState<HTMLDivElement | null>(null);
  // 見守り中のまとまりのドラッグ(docs/design.md: ドラッグ移動はブロックごと)。まとまりの最初に起動した鳥の
  // id と、ブロックの基準位置(%)の今の値
  const [groupDrag, setGroupDrag] = useState<WatchGroupRef | null>(null);
  // 吹き出しどうしが重なったら、ターンの終わりが新しい(sinceMs が小さい)鳥ほど上に重ねる
  const bubbleOrder = new Map(
    awake
      .filter((s) => bubbleText(s) !== undefined)
      .sort((a, b) => b.sinceMs - a.sinceMs)
      .map((s, i) => [s.id, i + 1] as const),
  );

  // 羽数とコンテナ実寸に応じてグリフサイズを決める。幅0(タブ非表示)のときは
  // 計算をスキップして直前の値を維持する(ref に保持)
  if (containerSize.w > 0 && containerSize.h > 0) {
    const count = Math.max(awake.length, 1);
    const raw = Math.sqrt((containerSize.w * containerSize.h) / count) * 0.16;
    glyphSizeRef.current = Math.min(52, Math.max(26, Math.round(raw)));
  }
  const glyphSize = glyphSizeRef.current;

  // 自動配置は「新しく庭に出てくる鳥は既存の鳥と被らないセルを選ぶ」(できるだけ)。
  // 一度決めた自動配置は表示中メモリ上で固定し(sticky)、他の鳥の出入りで動かさない。
  // 保存位置(ドラッグ済み)が付いたら sticky は捨てる。庭から消えた鳥の分も捨てる
  // 格子は、にわの大きさと鳥 1 羽の大きさ(名前・アイコン・吹き出しの空き・状態の行・印・足元の数)から決める。
  // 固定の格子だと、名前を上に出し吹き出しの空きを取って背の高くなった鳥が、広いにわでも隣の段に重なった
  const anyBubble = awake.some((s) => bubbleText(s) !== undefined);
  const nodeW = (anyBubble ? BUBBLE_MAX_PX : NODE_WIDTH_PX) + AUTO_GAP_PX;
  const nodeH =
    glyphSize +
    NODE_TEXT_PX +
    14 +
    (awake.some((s) => s.toolName !== undefined) ? STATUS_SUB_PX : 0) +
    (anyBubble ? BUBBLE_ROOM_PX : 0) +
    (awake.some((s) => s.watching !== undefined) ? WATCH_COUNT_PX : 0) +
    AUTO_GAP_PX;
  const grid = gardenGrid(containerSize.w, containerSize.h, nodeW, nodeH, awake.length, NEST_ROOM_PX);
  const present = new Set(awake.map((s) => s.id));
  const sticky = autoPosRef.current;
  // 格子の列・行が変わった(にわの大きさや吹き出しの有無が変わった)ら、自動で置いた位置は置き直す
  const gridKey = `${grid.cols}x${grid.rows}`;
  if (autoGridRef.current !== gridKey) {
    autoGridRef.current = gridKey;
    sticky.clear();
  }
  for (const id of [...sticky.keys()]) {
    if (!present.has(id) || positions[id]) sticky.delete(id);
  }
  // 既に鳥が居るセル = 保存位置 + 割り当て済み sticky
  const taken = new Set<number>();
  for (const s of awake) {
    const p = positions[s.id] ?? sticky.get(s.id);
    if (p) taken.add(gardenCellOf(p, grid));
  }
  // 新規の割り当ては id 順の安定した順序で行う(状態ソート順に依存させない)
  for (const s of [...awake].sort((a, b) => a.id.localeCompare(b.id))) {
    if (positions[s.id] || sticky.has(s.id)) continue;
    const pos = autoGardenPosition(s.id, taken, grid);
    sticky.set(s.id, pos);
    taken.add(gardenCellOf(pos, grid));
  }
  const resolvePosition = (id: string): GardenPosition =>
    positions[id] ?? sticky.get(id) ?? autoGardenPosition(id, taken, grid);

  // useLayoutEffect: awake から消えた id を leaving へ追加する。paint 前(コミット直後)
  // に同期実行されるため、「一瞬 DOM から消えてから leaving として復活する」フレームが
  // 見えない(react-dom は次のコミットまで browser に paint させない)。依存配列は
  // 敢えて空にせず、毎レンダー後に awake 集合の差分を見る。
  // sessions.length===0(全セッション消滅)の早期 return より前に置く: Hooks は
  // レンダーのたびに同じ順序で呼ばれる必要があり(Rules of Hooks)、早期 return の後ろに
  // 置くと 0 件になった瞬間だけこの hook が呼ばれず "Rendered fewer hooks" で落ちる
  useLayoutEffect(() => {
    const currentIds = new Set(awake.map((s) => s.id));
    const dozingIds = new Set(dozing.map((s) => s.id));
    const prevSnapshot = awakeSnapshotRef.current;

    setLeaving((prev) => {
      let next = prev;
      const ensureCopy = () => {
        if (next === prev) next = new Map(prev);
      };
      // awake に再登場した id は leaving から即削除(寝てすぐ起きた等のエッジは
      // 「awake 優先・leaving 破棄」で単純化する)
      for (const id of currentIds) {
        if (next.has(id)) {
          ensureCopy();
          next.delete(id);
        }
      }
      // 新しく awake から消えた id を追加する。target は現在 dozing に居れば "nest"、
      // それ以外(セッションそのものが消滅)なら "fade"
      for (const [id, entry] of prevSnapshot) {
        if (!currentIds.has(id) && !next.has(id)) {
          ensureCopy();
          next.set(id, {
            session: entry.session,
            position: entry.position,
            target: dozingIds.has(id) ? "nest" : "fade",
          });
        }
      }
      return next;
    });

    const newSnapshot = new Map<string, { session: SessionView; position: GardenPosition }>();
    for (const s of awake) {
      newSnapshot.set(s.id, { session: s, position: resolvePosition(s.id) });
    }
    awakeSnapshotRef.current = newSnapshot;
  });

  if (sessions.length === 0) {
    return (
      <div className="empty">
        {t(hasGranted ? "emptyNoSessions" : "emptyNeedsReauth")}
      </div>
    );
  }

  // ドラッグ中のまとまりは、最初に起動した鳥の位置を指の移動に合わせて差し替える
  const groupPositionOf = (id: string): GardenPosition =>
    groupDrag && id === groupDrag.rootId ? groupDrag.anchor : resolvePosition(id);
  const watchGroups = layoutWatchGroups(
    awake,
    groupPositionOf,
    containerSize.w,
    containerSize.h,
    glyphSize,
    groupDrag?.rootId,
    (id) => {
      const node = containerRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`);
      if (!node) return undefined;
      const w = visibleWidth(node);
      return w > 0 ? { w, h: node.offsetHeight } : undefined;
    },
  );
  // 狭いにわに鳥が入りきらないときは、にわを縦に伸ばす(窓はスクロールする)。重ねて読めなくするより良い。
  // 見守り中のブロックの中の鳥は数えず、ブロックの高さを足す
  const fitCols = Math.max(1, Math.floor(containerSize.w / nodeW));
  const looseCount = awake.filter((s) => !watchGroups.groupOf.has(s.id)).length;
  const blocksH = watchGroups.blocks.reduce((sum, b) => sum + b.height + AUTO_GAP_PX, 0);
  const gardenMinHeight =
    containerSize.w > 0
      ? Math.max(GARDEN_MIN_HEIGHT_PX, Math.ceil(looseCount / fitCols) * nodeH + blocksH + NEST_ROOM_PX)
      : undefined;
  return (
    <div className="garden" ref={containerRef} style={{ minHeight: gardenMinHeight }}>
      {/* 吹き出しの層。鳥・名前の層より上に置き、どの鳥の名前にも吹き出しの文(と「…」)を隠させない。
          吹き出しどうしは新しいターンほど上(bubbleOrder) */}
      <div className="garden-bubble-layer" ref={setBubbleLayer} />
      {/* 見守り中のまとまりを囲む角丸のブロック。鳥の層の下に敷く(docs/design.md) */}
      {watchGroups.blocks.map((b) => (
        <div
          key={b.key}
          className="garden-watch-block"
          style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
        >
          {/* 親の名前を 1 つだけ(中の鳥は違う所だけ名前を出す) */}
          <span className="garden-watch-block-name">
            {b.title}
          </span>
        </div>
      ))}
      {awake.map((s) => {
        const position = resolvePosition(s.id);
        const stackOrder = bubbleOrder.get(s.id);
        // events は新しい順(lib/sessions.ts)で来るので、先頭から拾えばそのまま新しい順になる
        const recent = events.filter((e) => e.sessionId === s.id).slice(0, HISTORY_LIMIT);
        // 初回表示は飛ばさず static、直前 dozing だった鳥は巣箱から、それ以外
        // (新規セッション)は上空から
        const entryOrigin: "none" | "sky" | "nest" = !animateEntry
          ? "none"
          : prevDozingRef.current.has(s.id)
            ? "nest"
            : "sky";
        return (
          <GardenNode
            key={s.id}
            session={s}
            position={position}
            recentEvents={recent}
            containerRef={containerRef}
            entryOrigin={entryOrigin}
            glyphSize={glyphSize}
            iconSet={resolveIconSet(iconSetAssignments, s.slug)}
            onDragEnd={(next) => handleDragEnd(s.id, next, liveIds)}
            stackOrder={stackOrder}
            bubbleLayer={bubbleLayer}
            watchPlace={watchGroups.places.get(s.id)}
            watchGroup={watchGroups.groupOf.get(s.id)}
            onGroupMove={setGroupDrag}
            onGroupDrop={(group) => {
              setGroupDrag(null);
              handleDragEnd(group.rootId, group.anchor, liveIds);
            }}
            focusable={Boolean(onFocus && canFocus?.(s.id))}
            onClick={() => onFocus?.(s.id)}
          />
        );
      })}
      {Array.from(leaving.entries()).map(([id, entry]) => (
        <GardenNode
          key={id}
          session={entry.session}
          position={entry.position}
          recentEvents={[]}
          containerRef={containerRef}
          entryOrigin="none"
          glyphSize={glyphSize}
          iconSet={resolveIconSet(iconSetAssignments, entry.session.slug)}
          onDragEnd={() => {}}
          exitTarget={entry.target}
          onExited={handleExited}
        />
      ))}
      {dozing.length > 0 && (
        <NestBox
          dozing={dozing}
          iconSetAssignments={iconSetAssignments}
          onFocus={onFocus}
          canFocus={canFocus}
        />
      )}
    </div>
  );
}

/**
 * dozing セッションを集約する巣箱。クリックで中の一覧(名前 + 経過時間)が開く。
 * 外側クリックでの自動クローズは document 全体(自分の外の任意の要素)を対象にする
 * 必要があり、React の合成イベント(portal container 単位のデリゲーション。App.tsx の
 * portalHost コメント参照)の枠には収まらないため、開閉・外側クリックの両方をネイティブ
 * addEventListener で張る(ownerDocument 経由で PiP 側の document にも同じ処理が張られる)
 */
function NestBox({
  dozing,
  iconSetAssignments,
  onFocus,
  canFocus,
}: {
  dozing: SessionView[];
  iconSetAssignments: IconSetAssignments;
  onFocus?: (id: string) => void;
  canFocus?: (id: string) => boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const btn = wrap.querySelector(".garden-nest-btn");
    if (!btn) return;
    const toggle = () => setOpen((v) => !v);
    btn.addEventListener("click", toggle);
    return () => btn.removeEventListener("click", toggle);
  }, []);

  // 開いている間だけ、巣箱の外のクリックで閉じる。PiP でも自ドキュメントに張れるよう
  // ownerDocument から取る
  useEffect(() => {
    if (!open) return;
    const wrap = wrapRef.current;
    const doc = wrap?.ownerDocument;
    if (!wrap || !doc) return;
    const onDown = (e: Event) => {
      if (e.target instanceof Node && !wrap.contains(e.target)) setOpen(false);
    };
    doc.addEventListener("pointerdown", onDown);
    return () => doc.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <div className="garden-nest" ref={wrapRef}>
      {open && (
        <ul className="garden-nest-list">
          {dozing.map((s) => {
            const focus = focusProps(s.id, onFocus, canFocus);
            return (
            <li key={s.id} {...focus} className={`garden-nest-row ${focus.className ?? ""}`}>
              <span className="garden-nest-row-glyph">
                <BirdGlyph
                  state="dozing"
                  size={14}
                  set={resolveIconSet(iconSetAssignments, s.slug)}
                  asking={hasQuestion(s)}
                />
              </span>
              <span className="garden-nest-row-name">{s.project}</span>
              <span className="garden-nest-row-since">{formatSince(s.sinceMs)}</span>
            </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        className="garden-nest-btn"
        aria-label={BIRD.dozing.label}
        aria-expanded={open}
      >
        <span className="garden-nest-glyph">
          <img
            className="bird-glyph-img"
            src={nestImg}
            width={24}
            height={24}
            alt=""
            draggable={false}
          />
        </span>
        <span className="garden-nest-count">{dozing.length}</span>
      </button>
    </div>
  );
}

function GardenNode({
  session,
  position,
  recentEvents,
  containerRef,
  entryOrigin,
  glyphSize,
  iconSet,
  onDragEnd,
  exitTarget,
  onExited,
  focusable = false,
  onClick,
  stackOrder,
  bubbleLayer,
  watchPlace,
  watchGroup,
  onGroupMove,
  onGroupDrop,
}: {
  session: SessionView;
  position: GardenPosition;
  recentEvents: SessionEvent[];
  containerRef: RefObject<HTMLDivElement | null>;
  entryOrigin: "none" | "sky" | "nest";
  glyphSize: number;
  iconSet: IconSetId;
  onDragEnd: (next: GardenPosition) => void;
  exitTarget?: "nest" | "fade";
  onExited?: (id: string) => void;
  focusable?: boolean;
  onClick?: () => void;
  // 吹き出しの重なり順(大きいほど上)。吹き出しの無い鳥は undefined
  stackOrder?: number;
  // 吹き出しを出す先(Garden の .garden-bubble-layer)
  bubbleLayer?: HTMLElement | null;
  // 見守り中のまとまりの中での位置(layoutWatchGroups)。あればこちらに置く
  watchPlace?: WatchPlace;
  // まとまりに入っている鳥は、ドラッグでブロックごと動かす(自分の位置ではなくブロックの基準位置を動かす)
  watchGroup?: WatchGroupRef;
  onGroupMove?: (group: WatchGroupRef) => void;
  onGroupDrop?: (group: WatchGroupRef) => void;
}) {
  // 自分が返事待ちか(状態の語・ツール名の出し分け)と、「?」を付けるか(実際に聞いている鳥だけ)
  const asking = needsAnswer(session.state, session.ask);
  const question = hasQuestion(session);
  const bubble = bubbleText(session);
  const nodeRef = useRef<HTMLDivElement>(null);
  const glyphRef = useRef<HTMLSpanElement>(null);
  // 見守り中のまとまりの鳥は、吹き出しが無くても吹き出しの空きを取ることがある(WatchPlace.bubbleRoom)
  const bubbleRoom = Boolean(bubble) || Boolean(watchPlace?.bubbleRoom);
  // ノードの上辺からアイコンの下辺まで(吹き出しの上辺の位置)。アイコンはにわの大きさに合わせて
  // なめらかに大きさを変える(perch.css の transition)ので、描画時に一度読むのではなく大きさの変化を追う
  const [glyphBottom, setGlyphBottom] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = glyphRef.current;
    if (!el) return;
    const measure = () => setGlyphBottom(el.offsetTop + el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // 入退場アニメーションを WAAPI(element.animate)で直接動かす対象。CSS transform は
  // 当てていない前提(位置決めは外側 .garden-node が担う)なので、animate の transform
  // keyframe と衝突しない
  const innerRef = useRef<HTMLDivElement>(null);
  // ドラッグ中だけ有効な追従用の一時位置。null のときは position prop(保存値/自動配置)を使う
  const [live, setLive] = useState<GardenPosition | null>(null);

  // onDragEnd は Garden が毎レンダー(3秒ポーリングの setSessions 含む)新規生成するクロージャ。
  // これを直接 effect の依存配列に入れると、ポーリングのたびに下の effect がクリーンアップ
  // →再セットアップされ、ドラッグ中なら dragging/startRect/grabOffset が無言でリセットされて
  // ドラッグが壊れる(実害)。ref 経由の最新値参照にして、effect 自体はマウント時に1度だけ張る
  const onDragEndRef = useRef(onDragEnd);
  const onClickRef = useRef(onClick);
  const groupRef = useRef({ watchGroup, onGroupMove, onGroupDrop });
  useEffect(() => {
    onDragEndRef.current = onDragEnd;
    onClickRef.current = onClick;
    groupRef.current = { watchGroup, onGroupMove, onGroupDrop };
  });

  // ドラッグは setPointerCapture によるノード外までの継続追跡(pointermove/pointerup を
  // ノードの外に出ても取り続ける)が要るため、React の合成イベントではなく常にネイティブ
  // addEventListener で張る。ノード単位のリスナーはドキュメントを跨いで移動しても
  // そのまま機能する(App.tsx の portalHost コメント参照)。
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;

    let startRect: DOMRect | null = null;
    let dragging = false;
    // ノードは translate(-50%, -50%) の中心基準。つかんだ点と中心のずれを保持しないと、
    // ドラッグ開始の瞬間に中心がカーソルへスナップして飛ぶ
    let grabOffsetX = 0;
    let grabOffsetY = 0;
    // ドラッグ(動かした)とクリック(動かしていない)を区別するための押した位置
    let downX = 0;
    let downY = 0;
    let moved = false;
    // まとまりの鳥をつかんだときの、ブロックの基準位置(%)。指の移動量だけこれを動かす
    let groupStart: WatchGroupRef | undefined;

    const onPointerDown = (e: PointerEvent) => {
      // 左ボタンだけ。右・中クリックで動かさずに離したときに Ghostty へ移らないようにする
      if (e.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;
      e.preventDefault();
      startRect = container.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      grabOffsetX = nodeRect.left + nodeRect.width / 2 - e.clientX;
      grabOffsetY = nodeRect.top + nodeRect.height / 2 - e.clientY;
      downX = e.clientX;
      downY = e.clientY;
      moved = false;
      dragging = true;
      groupStart = groupRef.current.watchGroup;
      node.setPointerCapture(e.pointerId);
    };

    const posFromEvent = (e: PointerEvent): GardenPosition | null => {
      if (!startRect || startRect.width === 0 || startRect.height === 0) return null;
      const xPct = ((e.clientX + grabOffsetX - startRect.left) / startRect.width) * 100;
      const yPct = ((e.clientY + grabOffsetY - startRect.top) / startRect.height) * 100;
      return clampGardenPosition(xPct, yPct);
    };

    // まとまりの鳥のドラッグ: ブロックの基準位置を指の移動量(%)だけ動かす
    const groupFromEvent = (e: PointerEvent): WatchGroupRef | undefined => {
      if (!groupStart || !startRect || startRect.width === 0 || startRect.height === 0) return undefined;
      const dx = ((e.clientX - downX) / startRect.width) * 100;
      const dy = ((e.clientY - downY) / startRect.height) * 100;
      return {
        rootId: groupStart.rootId,
        anchor: clampGardenPosition(groupStart.anchor.x + dx, groupStart.anchor.y + dy),
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) < CLICK_SLOP_PX) return;
      moved = true;
      const group = groupFromEvent(e);
      if (group) {
        groupRef.current.onGroupMove?.(group);
        return;
      }
      const next = posFromEvent(e);
      if (next) setLive(next);
    };

    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
      setLive(null);
      if (!moved) {
        // 動かしていない = クリック。位置は保存しない
        if (e.type === "pointerup") onClickRef.current?.();
        return;
      }
      const group = groupFromEvent(e);
      if (group) {
        groupRef.current.onGroupDrop?.(group);
        return;
      }
      const next = posFromEvent(e);
      if (next) onDragEndRef.current(next);
    };

    node.addEventListener("pointerdown", onPointerDown);
    node.addEventListener("pointermove", onPointerMove);
    node.addEventListener("pointerup", endDrag);
    node.addEventListener("pointercancel", endDrag);
    return () => {
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", endDrag);
      node.removeEventListener("pointercancel", endDrag);
    };
  }, [containerRef]);

  const pos = live ?? position;
  // 鳥(グリフ・「?」・名前・状態の行)を丸ごとにわの枠の内側に収める。保存する位置(%)は
  // そのままで、表示だけ寄せる(下の style の clamp)。ノードの大きさは前回の描画の実寸
  // (毎ポーリングで再描画されるので ref の読みで足りる)、まだ無ければ見積もり。
  // placed は吹き出しの向きと寄せ方を決めるための、今のにわの大きさでの位置(px)
  const containerW = containerRef.current?.clientWidth ?? 0;
  const containerH = containerRef.current?.clientHeight ?? 0;
  const nodeW = visibleWidth(nodeRef.current) || NODE_WIDTH_PX;
  // 吹き出しはアイコンのすぐ下に出し、ノードの中にそのぶんの空き(.garden-bubble-room)を取るので、ノードの高さに含まれる
  const nodeH = nodeRef.current?.offsetHeight || glyphSize + NODE_TEXT_PX + (bubbleRoom ? BUBBLE_ROOM_PX : 0);
  const minX = nodeW / 2 + NODE_EDGE_PX;
  const minY = nodeH / 2 + NODE_EDGE_PX;
  const maxYGap = nodeH / 2 + NODE_EDGE_PX;
  // 見守り中のまとまりの鳥はブロックの中の決まった位置に置く(ドラッグ中は指に付いてくる)
  const grouped = watchPlace && !live ? watchPlace : undefined;
  // 見守り中のブロックの中にいる鳥(ブロックの外へ出した鳥は watchPlace があっても bubbleRange が無い)
  const inBlock = grouped?.bubbleRange !== undefined;
  const placed = grouped
    ? { x: grouped.x, y: grouped.y }
    : containerW > 0 && containerH > 0
      ? {
          x: clampInside((pos.x / 100) * containerW, minX, containerW - minX),
          y: clampInside((pos.y / 100) * containerH, minY, containerH - maxYGap),
        }
      : undefined;
  // 位置は割合(%)のまま、枠の内側に収める制限は CSS の clamp に任せる(窓の大きさが変わっても
  // 再描画を待たずに追従する)。鳥と吹き出しの足場(anchor)は同じ位置を使う
  const left = grouped?.left ?? `clamp(${minX}px, ${pos.x}%, calc(100% - ${minX}px))`;
  const top = grouped?.top ?? `clamp(${minY}px, ${pos.y}%, calc(100% - ${maxYGap}px))`;
  // 左右の端に近い鳥は、アイコンの真下に出すと吹き出しが枠で切れるので、枠の内側に寄せる(しっぽは鳥を指したまま)
  // 見守り中のブロックの鳥は、吹き出しをブロックの内側に収める(ブロックの枠に掛けない)
  const bubbleStyle = placed
    ? grouped?.bubbleRange
      ? bubbleShift(placed.x, grouped.bubbleRange.lo, grouped.bubbleRange.hi)
      : bubbleShift(placed.x, BUBBLE_EDGE_PX, containerW - BUBBLE_EDGE_PX)
    : undefined;

  // 巣箱entry飛翔の px オフセット。mount 時点の position・コンテナ rect から1度だけ
  // 計算して固定する。rect が取れない/幅0(タブ非表示)ならフォールバック固定値を使う
  const [entryOffset] = useState(() => nestOffset(containerRef, position));

  // 鳥の向き。id 由来で決定的に約半数を左右反転する(全員同じ向きだと剥製っぽい)。
  // スプライトの素の向きは左向き想定 → flip = 右向き
  const flip = hashId(session.id) % 2 === 1;

  // 上空 entry の出発点は mount 時に1度だけ乱数で決める(state initializer なので
  // 以後は固定 = 再描画で軌道が変わらない)。横方向は向きと連動させる:
  // 右向き(flip)の鳥は左の空から右へ、左向きの鳥は右の空から左へ飛んでくる
  const [skyEntry] = useState(() => {
    const x = (Math.random() * 35 + 12) * (flip ? -1 : 1);
    const y = -(Math.random() * 120 + 280);
    const bank = -(Math.sign(x) * (Math.random() * 5 + 2));
    return { x, y, rotate: bank };
  });

  // 入場アニメーション: mount 時に1回だけ WAAPI で実行する。useLayoutEffect なので
  // paint 前に開始される(素の位置で一瞬見えてから飛ぶフラッシュを防ぐ)
  useLayoutEffect(() => {
    if (entryOrigin === "none") return;
    const el = innerRef.current;
    if (!el) return;
    if (entryOrigin === "nest") {
      el.animate(
        [
          {
            transform: `translate(${entryOffset.dx}px, ${entryOffset.dy}px) scale(0.3)`,
            opacity: 0,
          },
          { transform: "none", opacity: 1 },
        ],
        { duration: 550, easing: "cubic-bezier(0.22, 0.9, 0.35, 1)" },
      );
      return;
    }
    // sky: 3 キーフレームで弧を近似する(motion の per-property easing の代替)。
    // 着地(最終キーフレーム)以降は transform: none で止まるので、着地後に一瞬持ち上がる
    // ような残留動作は発生しない
    const { x, y, rotate } = skyEntry;
    el.animate(
      [
        { transform: `translate(${x}px, ${y}px) rotate(${rotate}deg)`, opacity: 0 },
        {
          transform: `translate(${x * 0.35}px, ${y * 0.08}px) rotate(${rotate * 0.5}deg)`,
          opacity: 1,
          offset: 0.6,
        },
        { transform: "none", opacity: 1 },
      ],
      { duration: 550, easing: "cubic-bezier(0.22, 0.9, 0.35, 1)" },
    );
    // entryOrigin は mount 時の値で固定(以後変化しない)なので mount 時 1 回のみでよい
  }, []);

  // 退場アニメーション: exitTarget が付いたら(Garden が leaving へ移した瞬間)WAAPI で
  // 実行し、終わったら onExited を呼んで Garden 側の leaving Map から消してもらう
  useLayoutEffect(() => {
    if (!exitTarget) return;
    const el = innerRef.current;
    if (!el) return;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      onExited?.(session.id);
    };
    const duration = exitTarget === "nest" ? 450 : 300;
    const keyframes: Keyframe[] =
      exitTarget === "nest"
        ? (() => {
            const { dx, dy } = nestOffset(containerRef, position);
            return [
              { transform: "none", opacity: 1 },
              { transform: `translate(${dx}px, ${dy}px) scale(0.25)`, opacity: 0 },
            ];
          })()
        : [{ opacity: 1 }, { opacity: 0 }];
    const anim = el.animate(keyframes, { duration, easing: "ease", fill: "forwards" });
    anim.onfinish = finish;
    // 保険: onfinish が来ない場合(要素が document から切り離される等)に備え、
    // duration+200ms でも onExited を呼ぶ。Garden 側は Map.delete なので二重呼びは冪等
    const timeoutId = setTimeout(finish, duration + 200);
    return () => {
      clearTimeout(timeoutId);
      // dev の StrictMode 二重実行等でこの effect が clean up されつつ要素が生き残る
      // ケースに備え、fill:"forwards" で止まったアニメーションを明示的に破棄する。
      // 破棄しないと次のマウントで再度 animate() したとき、既に opacity:0 で止まった
      // ままの要素から始まってしまう(「開発時だけ鳥が見えない」の再発防止)
      anim.cancel();
    };
    // exitTarget は leaving エントリ生成時に一度だけ決まる想定
  }, [exitTarget]);

  return (
    <div
      ref={nodeRef}
      data-session-id={session.id}
      className={`garden-node ${session.state}${question ? " asking" : ""}${live ? " dragging" : ""}${exitTarget ? " leaving" : ""}${focusable ? " focusable" : ""}${inBlock ? " in-watch-block" : ""}`}
      style={{
        left,
        top,
        // ドラッグ中は吹き出しの順より上に出す(.garden-node.dragging の z-index はインライン指定に負けるため)
        zIndex: live ? BUBBLE_Z_DRAGGING : stackOrder,
      }}
    >
      {/* 位置決め(left/top % + translate センタリング)・ドラッグ・hover/dragging の
          transform は外側の素の div が担う。WAAPI は transform を丸ごと上書きするため
          同じ要素には当てず、中身だけを包む内側の div に入退場アニメーションを持たせる */}
      <div className="garden-node-inner" ref={innerRef}>
        {/* ブロックの中の鳥は違う所(親からの相対パス)だけ出す。段に名前のある鳥がいれば、名前の無い鳥も行の高さを空ける */}
        {!inBlock ? (
          <span className="garden-name">{session.project}</span>
        ) : grouped.label !== undefined ? (
          <span className="garden-name" title={grouped.label}>
            {grouped.label}
          </span>
        ) : (
          grouped.nameRoom && <span className="garden-name" aria-hidden>{"\u00a0"}</span>
        )}
        <span className="garden-glyph" ref={glyphRef}>
          <BirdGlyph
            state={session.state}
            size={glyphSize}
            flip={flip}
            set={iconSet}
            asking={question}
          />
        </span>
        {/* 吹き出しの置き場。吹き出しそのものは吹き出しの層に出し(ほかの鳥より上に重ねるため)、ここは状態の行を下げる空きだけ */}
        {bubbleRoom && <span className="garden-bubble-room" aria-hidden />}
        {/* 止まり木の行と同じ部品。1 行目に状態の語と経過時間、ツール名はその下の行に出す */}
        <span className="garden-status">
          <StatusParts session={session} asking={asking} toolOnOwnLine stacked={inBlock} />
        </span>
        {/* 見守り中: 足元に動いている相手の数 */}
        {/* 数は今動いている相手だけ。猶予の間(0)は出さない */}
        {session.watching !== undefined && session.watching > 0 && (
          <span className="garden-watch-count" title={t("watchingPeersTitle")}>
            <MdLink size={12} aria-hidden />
            {session.watching}
          </span>
        )}
        {/* 「?」が付いている間はイベントの印を出さない。返事待ちの印は鳥の右上の「?」だけにする
            (docs/design.md「判断待ちの鳥に「?」を付ける」) */}
        {!question && recentEvents.length > 0 && (
          <span className="garden-icons">
            {recentEvents.map((e) => {
              const kind = eventKind(e);
              const Icon = EVENT[kind].icon;
              return (
                <span
                  key={e.key}
                  className="garden-icon-wrap"
                  title={`${EVENT[kind].label} · ${formatEventTime(e.at)}`}
                >
                  <Icon className={`event-icon tone-${EVENT[kind].tone}`} size={12} />
                </span>
              );
            })}
          </span>
        )}
      </div>
      {/* 吹き出しは鳥と同じ位置・同じ高さの足場を吹き出しの層に置き、アイコンの下辺(--bubble-top)のすぐ下、
          名前との間の空き(.garden-bubble-room)に出す。全羽でアイコンとの距離が同じになる */}
      {bubble &&
        bubbleLayer &&
        !exitTarget &&
        createPortal(
          <div
            className={`garden-bubble-anchor${inBlock ? " in-watch-block" : ""}`}
            style={
              {
                left,
                top,
                height: nodeH,
                zIndex: live ? BUBBLE_Z_DRAGGING : stackOrder,
                "--bubble-top": `${glyphBottom ?? glyphSize}px`,
              } as CSSProperties
            }
          >
            <SpeechBubble text={bubble} placement="below" style={bubbleStyle} />
          </div>,
          bubbleLayer,
        )}
    </div>
  );
}
