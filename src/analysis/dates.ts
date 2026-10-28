/**
 * 分析ツール共通の日付処理。日付の解釈はツール引数 `timezone`(`ToolContext.timezone`)、時刻は `ToolContext.now`。
 * logvalet は日付を UTC で読み、until を 00:00 で切っていた(当日を含めない)。ここでは until を当日の
 * 23:59:59.999(タイムゾーン基準)にする(ロードマップの決定事項)。
 */
import { ArgumentError } from "../errors";
import { formatYmd, parseDate, todayIn, type Ymd } from "../mcp/args";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** 不正なタイムゾーン名は RangeError(運用者の設定ミス。ADR 0004)。 */
function wallClock(instant: Date, timezone: string): Wall {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(timezone, f);
  }
  const parts = f.formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    h: Number(get("hour")) % 24,
    mi: Number(get("minute")),
    s: Number(get("second")),
    weekday: weekdays.indexOf(get("weekday")),
  };
}

/** タイムゾーンの UTC からのオフセット(ミリ秒)。秒未満は切り捨てて比べる。 */
function offsetMs(instant: Date, timezone: string): number {
  const w = wallClock(instant, timezone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** タイムゾーンの壁時計 (y-m-d h:mi:s.ms) の瞬間。夏時間の境目でも収束するよう 2 回補正する。 */
function wallToInstant(ymd: Ymd, h: number, mi: number, s: number, ms: number, tz: string): Date {
  const naive = Date.UTC(ymd.y, ymd.m - 1, ymd.d, h, mi, s, ms);
  let t = naive;
  for (let i = 0; i < 2; i++) t = naive - offsetMs(new Date(t), tz);
  return new Date(t);
}

export const startOfDay = (ymd: Ymd, timezone: string): Date =>
  wallToInstant(ymd, 0, 0, 0, 0, timezone);
/** その日の 23:59:59.999。 */
export const endOfDay = (ymd: Ymd, timezone: string): Date =>
  wallToInstant(ymd, 23, 59, 59, 999, timezone);

export const ymdIn = (instant: Date, timezone: string): Ymd => todayIn(instant, timezone);
export const hourIn = (instant: Date, timezone: string): number => wallClock(instant, timezone).h;
/** 0 = 日曜。 */
export const weekdayIn = (instant: Date, timezone: string): number =>
  wallClock(instant, timezone).weekday;

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** オフセットつきの RFC 3339(例 `2026-10-26T00:00:00+09:00`)。UTC は `Z`。ミリ秒が 0 でなければ付ける。 */
export function formatInZone(instant: Date, timezone: string): string {
  const w = wallClock(instant, timezone);
  const ms = instant.getUTCMilliseconds();
  const frac = ms === 0 ? "" : `.${pad(ms, 3)}`;
  const base = `${pad(w.y, 4)}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${frac}`;
  const off = Math.round(offsetMs(instant, timezone) / 60000);
  if (off === 0) return `${base}Z`;
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `${base}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** `to - from` の経過日数(0 方向に切り捨て。Go の `int(d.Hours() / 24)` と同じ)。 */
export function wholeDaysBetween(from: string | Date, to: Date): number {
  const f = typeof from === "string" ? Date.parse(from) : from.getTime();
  return Math.trunc((to.getTime() - f) / DAY_MS) || 0; // -0 を 0 にする
}

export interface RangeInput {
  since?: string;
  until?: string;
  now: Date;
  timezone: string;
  /** since 省略時の遡る日数(daily 1、weekly / stats 7)。 */
  defaultDays: number;
}

/**
 * since / until(YYYY-MM-DD)を瞬間にする。since は当日 00:00、until は当日 23:59:59.999(タイムゾーン基準)。
 * since 省略は now - defaultDays 日、until 省略は now。
 */
export function resolveRange(input: RangeInput): { since: Date; until: Date } {
  const since = input.since
    ? startOfDay(ymdOf("since", input.since), input.timezone)
    : new Date(input.now.getTime() - input.defaultDays * DAY_MS);
  const until = input.until
    ? endOfDay(ymdOf("until", input.until), input.timezone)
    : new Date(input.now.getTime());
  if (since.getTime() > until.getTime()) {
    throw new ArgumentError(
      `since must not be after until (since=${input.since ?? "default"}, until=${input.until ?? "now"})`,
    );
  }
  return { since, until };
}

function ymdOf(name: string, value: string): Ymd {
  const [y, m, d] = parseDate(name, value).split("-").map(Number) as [number, number, number];
  return { y, m, d };
}

export { formatYmd };

/** since / until が片方・両方なくてもよい版(timeline など)。省略した側は制限なし。 */
export function optionalRange(input: { since?: string; until?: string; timezone: string }): {
  since?: Date;
  until?: Date;
} {
  const since = input.since ? startOfDay(ymdOf("since", input.since), input.timezone) : undefined;
  const until = input.until ? endOfDay(ymdOf("until", input.until), input.timezone) : undefined;
  if (since && until && since.getTime() > until.getTime()) {
    throw new ArgumentError(
      `since must not be after until (since=${input.since}, until=${input.until})`,
    );
  }
  return { since, until };
}
