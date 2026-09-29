import { t } from "@/lib/i18n";

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

// Shown as relative time rather than absolute time (HH:MM). Using the same notation as formatSince on
// Perch rows keeps support for 43 locales without extra i18n keys.
// Re-renders happen via setEvents on every poll (3 seconds), so the display naturally keeps up
export function formatEventTime(at: number): string {
  return formatSince(Math.max(0, Date.now() - at));
}
