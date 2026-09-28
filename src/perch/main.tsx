import { initI18n } from "@/lib/i18n";

// App.tsx and its dependencies (stage.tsx / icon-sets.ts) call t() at module evaluation to
// build display string tables (see BIRD/EVENT/ICON_SET_LABEL). Outside an extension context
// (served statically with ?mock=1), the fallback dictionary must finish loading before that evaluation
// happens. Waiting for initI18n() to complete before dynamically importing ./boot
// delays evaluation of the whole app (including the static imports of App/mock/source/perch.css) until after that
// (this file itself must not statically import the app)
await initI18n();
await import("./boot");
