/**
 * ツール共通の引数処理。logvalet では各ツールに散らばっていたものを 1 か所にまとめる。
 *
 * 入力スキーマ用の zod ビルダー(`reqStr` など)は `.refine` で検証するので、公開される JSON Schema は
 * `{ type, description }` だけになる(`minLength` や `integer` が混ざって logvalet の baseline と食い違わない)。
 */
import { z } from "zod";
import type { BacklogClient } from "../backlog/client";
import { ArgumentError } from "../errors";

// --- 入力スキーマ ---

const isInt = (n: number) => Number.isInteger(n);

/** 必須の文字列(空文字は不可)。 */
export const reqStr = (description: string) =>
  z
    .string()
    .refine((s) => s.trim() !== "", "must not be empty")
    .describe(description);
/** 必須の文字列（空文字も可。note のように「空にする」ことに意味があるもの）。 */
export const reqText = (description: string) => z.string().describe(description);
/** 任意の文字列。 */
export const optStr = (description: string) => z.string().describe(description).optional();
/** 必須の整数 ID(JSON Schema 上は number)。 */
export const reqInt = (description: string) =>
  z.number().refine(isInt, "must be an integer").describe(description);
/** 任意の整数(JSON Schema 上は number)。 */
export const optInt = (description: string) =>
  z.number().refine(isInt, "must be an integer").describe(description).optional();
/** 任意の真偽値。 */
export const optBool = (description: string) => z.boolean().describe(description).optional();

/** ID が 0（未指定）なら argument_error。logvalet の `id == 0` の検査と同じ。 */
export function requireId(name: string, value: number): number {
  if (value === 0) throw new ArgumentError(`${name} is required`);
  return value;
}

/** 空文字でない任意の文字列だけを残す。 */
export function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

// --- パスとクエリ ---

/**
 * パスの 1 セグメントとしてエスケープする。`.` と `..` は URL の正規化でパスを辿れてしまう
 * (別の API を叩ける)ので拒否する。
 */
export function seg(value: string | number): string {
  const text = String(value);
  if (text === "." || text === "..") {
    throw new ArgumentError(`"${text}" cannot be used as a path segment`);
  }
  return encodeURIComponent(text);
}

/** `count` の範囲(1〜100)。説明文に「最大 100」とあるツール用。範囲外は argument_error。 */
export function boundedCount(
  name: string,
  value: number | undefined,
  max = 100,
): number | undefined {
  if (value === undefined) return undefined;
  if (value < 1 || value > max) {
    throw new ArgumentError(`${name} must be between 1 and ${max}, got ${value}`);
  }
  return value;
}

/** 0 以下は送らない(logvalet と同じ。上限のない count / offset 用)。 */
export function positiveOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined;
}

/** "1,2,3" → [1,2,3]。空・未指定は undefined。 */
export function parseCsvInts(name: string, input: string | undefined): number[] | undefined {
  if (input === undefined || input.trim() === "") return undefined;
  const ids: number[] = [];
  for (const part of input.split(",")) {
    const p = part.trim();
    if (p === "") continue;
    if (!/^-?\d+$/.test(p)) {
      throw new ArgumentError(`${name} must be comma-separated integers, got "${input}"`);
    }
    ids.push(Number(p));
  }
  return ids.length > 0 ? ids : undefined;
}

/** "A,B,C" → ["A","B","C"]。空要素は捨てる。 */
export function parseCsvStrings(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// --- 日付 ---

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const formatYmd = ({ y, m, d }: Ymd): string => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

function validYmd(text: string): Ymd | undefined {
  const match = YMD.exec(text);
  if (!match) return undefined;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const t = new Date(Date.UTC(y, m - 1, d));
  // 2026-02-30 のような存在しない日付を弾く。
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return undefined;
  }
  return { y, m, d };
}

/** `YYYY-MM-DD` を検証して返す。 */
export function parseDate(name: string, value: string): string {
  if (!validYmd(value)) {
    throw new ArgumentError(`${name} must be a date in YYYY-MM-DD format, got "${value}"`);
  }
  return value;
}

/** 基準タイムゾーンでの「今日」。不正なタイムゾーン名は RangeError(運用者の設定ミス)。 */
export function todayIn(now: Date, timezone: string): Ymd {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

const utcDate = ({ y, m, d }: Ymd) => new Date(Date.UTC(y, m - 1, d));
const toYmd = (t: Date): Ymd => ({
  y: t.getUTCFullYear(),
  m: t.getUTCMonth() + 1,
  d: t.getUTCDate(),
});
const addDays = (ymd: Ymd, days: number): Ymd => {
  const t = utcDate(ymd);
  t.setUTCDate(t.getUTCDate() + days);
  return toYmd(t);
};

export interface DateRange {
  since?: string;
  until?: string;
}

/**
 * issue_list の `due_date` / `start_date` を since/until(YYYY-MM-DD)にする。
 * today / this-week(月曜〜日曜)/ this-month、`overdue`(due_date のみ。昨日まで)、
 * 単一の日付、`A:B` / `A:` / `:B` の範囲。
 */
export function dateRangeFor(
  name: "due_date" | "start_date",
  input: string,
  today: Ymd,
): DateRange {
  const keywords =
    name === "due_date" ? "today, overdue, this-week, this-month" : "today, this-week, this-month";
  const invalid = () =>
    new ArgumentError(
      `${name} must be one of: ${keywords}, YYYY-MM-DD, YYYY-MM-DD:YYYY-MM-DD: "${input}"`,
    );

  switch (input) {
    case "today":
      return { since: formatYmd(today), until: formatYmd(today) };
    case "overdue":
      if (name === "due_date") return { until: formatYmd(addDays(today, -1)) };
      throw invalid();
    case "this-week": {
      const dow = utcDate(today).getUTCDay(); // 0 = 日曜
      const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
      return { since: formatYmd(monday), until: formatYmd(addDays(monday, 6)) };
    }
    case "this-month": {
      const first = { y: today.y, m: today.m, d: 1 };
      const last = toYmd(new Date(Date.UTC(today.y, today.m, 0)));
      return { since: formatYmd(first), until: formatYmd(last) };
    }
  }

  if (input.includes(":")) {
    // 最初の ':' だけで分ける。右側に ':' が残れば日付として読めず invalid になる(logvalet の SplitN)。
    const at = input.indexOf(":");
    const left = input.slice(0, at).trim();
    const right = input.slice(at + 1).trim();
    if (left === "" && right === "") throw invalid();
    if ((left !== "" && !validYmd(left)) || (right !== "" && !validYmd(right))) throw invalid();
    return {
      ...(left === "" ? {} : { since: left }),
      ...(right === "" ? {} : { until: right }),
    };
  }
  if (!validYmd(input)) throw invalid();
  return { since: input, until: input };
}

/** issue_list の `status_id`。`not-closed` は [1,2,3]、それ以外は数値の CSV。 */
export function resolveStatusIds(input: string): number[] {
  if (input === "not-closed") return [1, 2, 3];
  const ids = parseCsvInts("status_id", input);
  if (!ids) {
    throw new ArgumentError(
      `status_id must be not-closed or comma-separated numeric IDs, got "${input}"`,
    );
  }
  return ids;
}

// --- ID の解決 ---

/** `"me"` → GET /users/myself の id、数値文字列 → 数値。 */
export async function resolveUserId(
  client: BacklogClient,
  value: string,
  name = "user_id",
): Promise<number> {
  if (value === "me") return (await client.getMyself()).id;
  if (!/^\d+$/.test(value)) {
    throw new ArgumentError(`${name} must be "me" or a numeric ID, got "${value}"`);
  }
  return Number(value);
}

/** 1 回のツール呼び出し(= 1 クライアント)の中だけで効くキャッシュ。 */
const projectIds = new WeakMap<BacklogClient, Map<string, number>>();

/** project_key → projectId(GET /projects/{key})。 */
export async function resolveProjectId(client: BacklogClient, projectKey: string): Promise<number> {
  let cache = projectIds.get(client);
  if (!cache) {
    cache = new Map();
    projectIds.set(client, cache);
  }
  const hit = cache.get(projectKey);
  if (hit !== undefined) return hit;
  const project = await client.request<{ id: number }>("GET", `/projects/${seg(projectKey)}`);
  cache.set(projectKey, project.id);
  return project.id;
}
