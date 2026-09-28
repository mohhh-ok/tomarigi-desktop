// にわ(Garden)タブのノード配置の永続化(issue #12)。
//
// 設計メモ: issue の指示文では browser.storage.local を挙げているが、本プロジェクトは
// 「権限ゼロ」が信用の根拠(wxt.config.ts のコメント参照)で manifest.permissions が
// 空のまま維持されている。chrome.storage 系 API は "storage" permission が要るため、
// ここで使うと唯一の権限追加になってしまう。IndexedDB は拡張ページから権限なしで
// 使えるため、fsa.ts と同じ idb 経由の "tomarigi" DB / "kv" ストアに寄せて、
// 権限ゼロを崩さずに永続化する。

import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "tomarigi";
const STORE = "kv";
const KEY_GARDEN_POSITIONS = "gardenPositions";

export interface GardenPosition {
  x: number; // コンテナ幅に対する %
  y: number; // コンテナ高さに対する %
}

// ノードがコンテナの端で見切れすぎないための可動域(コンテナに対する %)。
// ドラッグ中のクランプと自動配置の両方で同じ値を使う。
const CLAMP_X_MIN = 8;
const CLAMP_X_MAX = 92;
const CLAMP_Y_MIN = 10;
const CLAMP_Y_MAX = 90;

/**
 * 自動配置の格子。にわの大きさと鳥 1 羽の大きさ(px)から列と行を決める(docs/design.md のにわ)。
 * jitterX / jitterY は、セルの中でずらしてよい幅(セルに対する割合)。鳥がセルより小さい余りの分だけずらし、
 * 隣のセルの鳥に重ならないようにする
 */
export interface GardenGrid {
  cols: number;
  rows: number;
  jitterX: number;
  jitterY: number;
  // 格子を置く高さの、にわの高さに対する割合(下端に巣箱の分の空きを取るため 1 未満になる)
  yScale: number;
}

// にわの大きさがまだ分からないときの格子(以前の固定の 4×3)
const FALLBACK_GRID: GardenGrid = { cols: 4, rows: 3, jitterX: 0.6, jitterY: 0.6, yScale: 1 };
// セルの中でずらす幅の上限(綺麗すぎる整列を崩す程度)
const MAX_JITTER = 0.6;

/**
 * にわ(w×h px)に、鳥(nodeW×nodeH px)が重ならずに入る列と行。count 羽が入らなければ、鳥 1 羽に対して
 * 余裕の大きい向き(横か縦)から列・行を足す(狭いにわでは重なる。以前と同じく「できるだけ」)
 */
export function gardenGrid(
  w: number,
  fullH: number,
  nodeW: number,
  nodeH: number,
  count: number,
  bottomReserve = 0,
): GardenGrid {
  if (w <= 0 || fullH <= 0) return FALLBACK_GRID;
  // 下端の bottomReserve px(巣箱)には鳥を置かない
  const h = Math.max(nodeH, fullH - bottomReserve);
  let cols = Math.max(1, Math.floor(w / nodeW));
  let rows = Math.max(1, Math.floor(h / nodeH));
  while (cols * rows < count) {
    if (w / (cols + 1) / nodeW >= h / (rows + 1) / nodeH) cols++;
    else rows++;
  }
  const jitter = (cell: number, node: number) => Math.min(MAX_JITTER, Math.max(0, (cell - node) / cell));
  return {
    cols,
    rows,
    jitterX: jitter(w / cols, nodeW),
    jitterY: jitter(h / rows, nodeH),
    yScale: Math.min(1, h / fullH),
  };
}

function db(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    },
  });
}

export async function loadGardenPositions(): Promise<Record<string, GardenPosition>> {
  const saved = (await (await db()).get(STORE, KEY_GARDEN_POSITIONS)) as
    | Record<string, GardenPosition>
    | undefined;
  return saved ?? {};
}

export async function saveGardenPositions(
  positions: Record<string, GardenPosition>,
): Promise<void> {
  await (await db()).put(STORE, positions, KEY_GARDEN_POSITIONS);
}

export function clampGardenPosition(x: number, y: number): GardenPosition {
  return {
    x: Math.min(CLAMP_X_MAX, Math.max(CLAMP_X_MIN, x)),
    y: Math.min(CLAMP_Y_MAX, Math.max(CLAMP_Y_MIN, y)),
  };
}

// 文字列から決定的な非負整数を作る(FNV 風の簡易ハッシュ)。ランダムは再描画のたびに
// 位置が動いてしまうため使えず、id から毎回同じ値を再現する必要がある。
// (配置のほか、にわの鳥の向き(左右反転)の決定にも使う)
export function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** 位置が格子のどのセルに属するか(0 〜 cols*rows-1)。空きセル探索用 */
export function gardenCellOf(pos: GardenPosition, grid: GardenGrid): number {
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor(pos.x / (100 / grid.cols))));
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor(pos.y / grid.yScale / (100 / grid.rows))));
  return row * grid.cols + col;
}

/**
 * 位置未登録セッションの初期配置。id ハッシュのセルを起点に、taken(既存の鳥が居るセル)
 * を避けて空きセルを線形に探す(全セル埋まっていたら起点セルに重ねる = 「できるだけ」被らない)。
 * セル内のジッターは id ハッシュだけで決まる決定的な微小オフセット(綺麗すぎる整列を崩す)。ずらす幅は
 * 鳥がセルより小さい余りの分まで(grid.jitterX / jitterY)。
 * ランダムや配列 index を使うと再描画・状態変化のたびに位置が飛ぶため使わない(実害あり)。
 */
export function autoGardenPosition(id: string, taken: ReadonlySet<number>, grid: GardenGrid): GardenPosition {
  const cells = grid.cols * grid.rows;
  const hash = hashId(id);
  const start = hash % cells;
  let slot = start;
  for (let i = 0; i < cells; i++) {
    const cand = (start + i) % cells;
    if (!taken.has(cand)) {
      slot = cand;
      break;
    }
  }
  const col = slot % grid.cols;
  const row = Math.floor(slot / grid.cols);
  const cellW = 100 / grid.cols;
  const cellH = 100 / grid.rows;
  const jitterX = ((hash % 100) / 100 - 0.5) * cellW * grid.jitterX;
  const jitterY = (((hash >> 8) % 100) / 100 - 0.5) * cellH * grid.jitterY;
  // clampGardenPosition は通さない。セルの中心とジッターはもともとセルの内側に収まり、端のセルを 8〜92% に寄せると
  // 隣のセルの鳥との間が詰まって状態の行どうしが重なった
  return { x: col * cellW + cellW / 2 + jitterX, y: (row * cellH + cellH / 2 + jitterY) * grid.yScale };
}
