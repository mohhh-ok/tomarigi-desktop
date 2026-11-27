// The concierge's look, apart from lib/concierge.ts so the settings file's conversions (lib/settings-file-fields.ts,
// which lib/kv.ts imports) can take the default without importing the AI runners

/** The concierge's looks the user picks between in settings; the same image in every icon set */
export const CONCIERGE_LOOKS = ["owl", "penguin"] as const;
export type ConciergeLook = (typeof CONCIERGE_LOOKS)[number];
/** The owl (Claude's own decision, docs/design/concierge.md "Concierge") */
export const DEFAULT_CONCIERGE_LOOK: ConciergeLook = "owl";
