// Icon sets (issue #14): lets each project (slug) choose a look other than birds (gnome, cat, robot,
// frog). The IconSetId definition itself, DEFAULT_ICON_SET, persisting assignments, and
// resolving them (resolveIconSet) live in lib/icon-set-store.ts (lib is the logic layer and
// can't depend on src/perch's asset imports, so only the vocabulary "which IDs exist" and
// "how a slug is resolved" lives in lib; this file imports those types and
// assembles the perch-specific concerns: images (WebP imports) and display labels).
import { t } from "@/lib/i18n";
import type { BirdState } from "@/lib/sessions";
import {
  DEFAULT_ICON_SET,
  ICON_SET_IDS,
  resolveIconSet,
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

export { DEFAULT_ICON_SET, ICON_SET_IDS, resolveIconSet };

type IconSetSprites = Record<BirdState | "chick", string>;

// BirdState/chick → WebP table. waiting is shown as the same picture as done with a "?" badge on top
// (BirdGlyph in bird-glyph.tsx; no extra drawings per set). BIRD.img in bird-glyph.tsx uses this birds set's values as its
// source (to avoid keeping two copies, BIRD only refers to ICON_SETS.birds)
export const ICON_SETS: Record<IconSetId, IconSetSprites> = {
  birds: { working: birdsWorking, waiting: birdsDone, done: birdsDone, dozing: birdsDozing, chick: birdsChick },
  gnome: { working: gnomeWorking, waiting: gnomeDone, done: gnomeDone, dozing: gnomeDozing, chick: gnomeChick },
  cat: { working: catWorking, waiting: catDone, done: catDone, dozing: catDozing, chick: catChick },
  robot: { working: robotWorking, waiting: robotDone, done: robotDone, dozing: robotDozing, chick: robotChick },
  frog: { working: frogWorking, waiting: frogDone, done: frogDone, dozing: frogDozing, chick: frogChick },
};

// Display names shown as the title of the sprite next to the toggle button in the settings UI. Like BIRD.label (bird-glyph.tsx),
// held as strings already resolved with t() at module load (not called every time
// at the call site). initI18n() must complete before this module is evaluated (see main.tsx)
export const ICON_SET_LABEL: Record<IconSetId, string> = {
  birds: t("iconSetBirds"),
  gnome: t("iconSetGnome"),
  cat: t("iconSetCat"),
  robot: t("iconSetRobot"),
  frog: t("iconSetFrog"),
};
