// プロジェクトへのアイコンセット個別割り当てを永続化する(issue #14)。
//
// 経路は garden-layout.ts と同じ理由(権限ゼロ維持。garden-layout.ts 冒頭コメント参照)で
// chrome.storage ではなく idb 経由の "tomarigi" DB / "kv" ストアを使う。
//
// キーはデータソース内のプロジェクト識別子(lib/sessions.ts の SessionView.slug と同じ語彙)。
// rootId はキーに含めない — 同じプロジェクトパスを複数 root
// から見ている場合でも割り当てが共有される(仕様どおりの挙動)。
//
// IconSetId はここが唯一の定義元(source of truth)。画像そのもの(WebP import)は
// entrypoints/perch 側の関心事(lib はロジック層で、entrypoints/perch のアセット import に
// 依存できない)だが、"どの ID が存在するか" は永続化(バリデーション・デフォルト値解決)
// と表示の両方が必要とする共有語彙なので、BirdState(lib/sessions.ts)と同じ置き場に揃える。
// entrypoints/perch/icon-sets.ts はこの型を輸入して画像テーブルを組み立てる側に回る。

import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "tomarigi";
const STORE = "kv";
const KEY_ICON_SET_ASSIGNMENTS = "projectIconSets";
// 未リリースの旧方式(正規表現ルール)の残骸キー。load 時に見つけたら消す
const KEY_ICON_SET_RULES_LEGACY = "iconSetRules";

export type IconSetId = "birds" | "gnome" | "cat" | "robot" | "frog";

export const DEFAULT_ICON_SET: IconSetId = "birds";

// バリデーション・UI のトグル順送り(次のセットへの巡回)の両方で使う正準の並び順
export const ICON_SET_IDS: readonly IconSetId[] = ["birds", "gnome", "cat", "robot", "frog"];

function isIconSetId(value: unknown): value is IconSetId {
  return typeof value === "string" && (ICON_SET_IDS as readonly string[]).includes(value);
}

/**
 * 1件の割り当て。label は表示名(SessionView.project)のスナップショット — 走っていない
 * プロジェクトの行も人間可読な名前で出すために持つ。保存タイミングは割り当て変更時のみ
 * (セッションに出ている間は毎回最新の表示名で上書きしてよいが、ポーリングごとに書くのは
 * 禁止。App.tsx の呼び出し側参照)。
 */
export interface IconSetAssignment {
  set: IconSetId;
  label: string;
}

export type IconSetAssignments = Record<string /* slug */, IconSetAssignment>;

function isIconSetAssignment(value: unknown): value is IconSetAssignment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isIconSetId(v.set) && typeof v.label === "string";
}

function db(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    },
  });
}

/**
 * 保存済みの割り当て(slug → {set, label})。壊れた要素(将来セットが廃止された場合の
 * 残骸等)は読み込み時に取り除く。未保存時は空オブジェクト(=常に DEFAULT_ICON_SET に解決
 * される)。「鳥(既定)を選択 = エントリ削除」の意味論(下の resolveIconSet 参照)のため、
 * set が DEFAULT_ICON_SET のエントリが保存されていることは無い想定。
 */
export async function loadIconSetAssignments(): Promise<IconSetAssignments> {
  const d = await db();
  // 未リリースの旧方式(正規表現ルール)の残骸を掃除する。存在しなければ no-op
  await d.delete(STORE, KEY_ICON_SET_RULES_LEGACY);
  const saved = (await d.get(STORE, KEY_ICON_SET_ASSIGNMENTS)) as unknown;
  if (typeof saved !== "object" || saved === null) return {};
  const out: IconSetAssignments = {};
  for (const [slug, value] of Object.entries(saved as Record<string, unknown>)) {
    if (isIconSetAssignment(value)) out[slug] = value;
  }
  return out;
}

export async function saveIconSetAssignments(assignments: IconSetAssignments): Promise<void> {
  await (await db()).put(STORE, assignments, KEY_ICON_SET_ASSIGNMENTS);
}

/** slug → IconSetId の解決。割り当てが無ければ DEFAULT_ICON_SET(鳥)。 */
export function resolveIconSet(assignments: IconSetAssignments, slug: string): IconSetId {
  return assignments[slug]?.set ?? DEFAULT_ICON_SET;
}
