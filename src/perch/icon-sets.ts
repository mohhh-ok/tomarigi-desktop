// アイコンセット(issue #14): プロジェクト(slug)ごとに鳥以外の見た目(小人・ネコ・ロボット・
// カエル)を個別に選べるようにする。IconSetId 自体の定義・DEFAULT_ICON_SET・割り当ての
// 永続化・解決(resolveIconSet)は lib/icon-set-store.ts が持つ(lib はロジック層で
// entrypoints/perch のアセット import に依存できないため、"どの ID が存在するか"
// "slug をどう解決するか" という語彙だけを lib 側に置き、ここではその型を輸入して
// 画像(WebP import)・表示ラベルという perch 固有の関心事を組み立てる)。
import { t } from "@/lib/i18n";
import type { BirdState } from "@/lib/sessions";
import {
  DEFAULT_ICON_SET,
  ICON_SET_IDS,
  resolveIconSet,
  type IconSetAssignment,
  type IconSetAssignments,
  type IconSetId,
} from "@/lib/icon-set-store";

import birdsWorking from "@/assets/birds/working.webp";
import birdsDone from "@/assets/birds/done.webp";
import birdsDozing from "@/assets/birds/dozing.webp";
import birdsChick from "@/assets/birds/chick.webp";

import gnomeWorking from "@/assets/gnome/working.webp";
import gnomeDone from "@/assets/gnome/done.webp";
import gnomeDozing from "@/assets/gnome/dozing.webp";
import gnomeChick from "@/assets/gnome/chick.webp";

import catWorking from "@/assets/cat/working.webp";
import catDone from "@/assets/cat/done.webp";
import catDozing from "@/assets/cat/dozing.webp";
import catChick from "@/assets/cat/chick.webp";

import robotWorking from "@/assets/robot/working.webp";
import robotDone from "@/assets/robot/done.webp";
import robotDozing from "@/assets/robot/dozing.webp";
import robotChick from "@/assets/robot/chick.webp";

import frogWorking from "@/assets/frog/working.webp";
import frogDone from "@/assets/frog/done.webp";
import frogDozing from "@/assets/frog/dozing.webp";
import frogChick from "@/assets/frog/chick.webp";

export type { IconSetId, IconSetAssignment, IconSetAssignments };
export { DEFAULT_ICON_SET, ICON_SET_IDS, resolveIconSet };

type IconSetSprites = Record<BirdState | "chick", string>;

// BirdState/chick → WebP の対応表。waiting は done と同じ絵に「?」バッジを重ねて見せる
// (stage.tsx の BirdGlyph。セットごとに絵を描き足さない)。stage.tsx の BIRD.img はこの birds セットの値を
// source にする(二重管理を避けるため BIRD 側は ICON_SETS.birds を参照するだけにする)
export const ICON_SETS: Record<IconSetId, IconSetSprites> = {
  birds: { working: birdsWorking, waiting: birdsDone, done: birdsDone, dozing: birdsDozing, chick: birdsChick },
  gnome: { working: gnomeWorking, waiting: gnomeDone, done: gnomeDone, dozing: gnomeDozing, chick: gnomeChick },
  cat: { working: catWorking, waiting: catDone, done: catDone, dozing: catDozing, chick: catChick },
  robot: { working: robotWorking, waiting: robotDone, done: robotDone, dozing: robotDozing, chick: robotChick },
  frog: { working: frogWorking, waiting: frogDone, done: frogDone, dozing: frogDozing, chick: frogChick },
};

// 設定 UI のトグルボタン横のスプライトに title として出す表示名。BIRD.label(stage.tsx)と
// 同じく、モジュール読み込み時に t() で解決済みの文字列として持つ(呼び出し側で毎回
// 呼ばない)。フォールバック時(拡張外)はこのモジュール評価より前に initI18n() の完了が
// 必要(main.tsx 参照)
export const ICON_SET_LABEL: Record<IconSetId, string> = {
  birds: t("iconSetBirds"),
  gnome: t("iconSetGnome"),
  cat: t("iconSetCat"),
  robot: t("iconSetRobot"),
  frog: t("iconSetFrog"),
};
