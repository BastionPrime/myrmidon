const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

// myrmidon(UI-RU): optional translator keeps the vendor English output when
// no translation is active; callers in translated surfaces pass t().
const ENGLISH_FALLBACKS: Record<string, string> = {
  "time.justNow": "just now",
  "time.minutesAgo": "{{count}}m ago",
  "time.hoursAgo": "{{count}}h ago",
  "time.daysAgo": "{{count}}d ago",
  "time.weeksAgo": "{{count}}w ago",
  "time.monthsAgo": "{{count}}mo ago",
};

export function timeAgo(date: Date | string, t?: (key: string, options?: Record<string, unknown>) => string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);
  const translate = t ?? ((key: string, options?: Record<string, unknown>) =>
    (ENGLISH_FALLBACKS[key] ?? key).replace("{{count}}", String(options?.count ?? "")));

  if (seconds < MINUTE) return translate("time.justNow");
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return translate("time.minutesAgo", { count: m });
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return translate("time.hoursAgo", { count: h });
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return translate("time.daysAgo", { count: d });
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return translate("time.weeksAgo", { count: w });
  }
  const mo = Math.floor(seconds / MONTH);
  return translate("time.monthsAgo", { count: mo });
}
