import { type RootEntry } from "@/lib/fsa";
import { scanSessions, type ScanResult } from "@/lib/sessions";

/**
 * App.tsx が使うデータソースの抽象。実データ(FileSystemAccess 経由の roots 走査)と
 * mock データ(entrypoints/perch/mock.tsx)を同じ形で App.tsx に注入するための境界。
 * ?mock=1 のとき実 App.tsx のシェルを複製した別コンポーネントを丸ごと維持するのをやめ、
 * App.tsx 自体を source 差し替えで動かす(シェルの source of truth を1つにする)ための導入。
 */
export interface PerchSource {
  /** roots/権限サブシステムを使うか。false ならセットアップ画面・監視フォルダ設定・
   * 権限チェックを全てスキップする(mock 用) */
  usesRoots: boolean;
  scan(granted: RootEntry[]): Promise<ScanResult>;
  /** データ変更を即時反映したいソース用(mock)。App.tsx のポーリング(3秒)を待たずに
   * 再スキャンさせたいときに呼ぶ。戻り値は unsubscribe。real は使わないため未定義のまま */
  subscribe?(onChange: () => void): () => void;
}

export const realSource: PerchSource = {
  usesRoots: true,
  scan: (granted) => scanSessions(granted),
};
