import { initI18n } from "@/lib/i18n";

// App.tsx とその依存(stage.tsx / icon-sets.ts)はモジュール評価時に t() を呼んで
// 表示文字列テーブルを組み立てる(BIRD/EVENT/ICON_SET_LABEL 参照)。拡張コンテキスト外
// (?mock=1 の静的サーバー配信)では、その評価が起きる前にフォールバック辞書の読み込みが
// 完了していなければならない。initI18n() の完了を待ってから ./boot を dynamic import する
// ことで、本体一式(App/mock/source/perch.css の静的 import を含む)の評価をそれ以降に
// 遅らせる(このファイル自体は本体を静的 import しないこと)
await initI18n();
await import("./boot");
