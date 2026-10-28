/**
 * 期間つきでアクティビティを集める(user_activity と digest_unified が共有する)。
 * Backlog のアクティビティ API は日付で絞れず `offset` もないので、新しい順に `maxId` のカーソルで遡り、
 * `since` より古いものに届いたらそこで止める。`until` より新しいものは取得後に除く。
 *
 * logvalet の `FetchActivitiesWithDateFilter` は、取得関数が `maxId` を受け取っておらず(同じページを繰り返し取得)、
 * `until` より新しい活動ばかりが続くと止まらなかった。ここではカーソルを必ず進め、ページ数に上限を付ける(ADR 0006)。
 */
import type { BacklogClient, Params } from "../backlog/client";
import { DEFAULT_MAX_PAGES, fetchByCursor } from "../backlog/paging";

export interface BacklogActivity {
  id: number;
  type: number;
  created?: string | null;
  createdUser?: { id: number; name: string } | null;
  content?: Record<string, unknown> | null;
  [extra: string]: unknown;
}

export interface FetchActivityRangeOptions {
  since?: Date;
  until?: Date;
  /** `activityTypeId` などの追加のクエリ。 */
  query?: Params;
  /** 期間がないときに、これだけ集まったら止める。 */
  limit?: number;
  maxPages?: number;
}

export interface ActivityRange {
  /** 新しい順。`created` のないものは除く(logvalet と同じ)。 */
  activities: BacklogActivity[];
  /** ページ数の上限か limit で止めた(続きがある可能性がある)。 */
  truncated: boolean;
  /** ページ数の上限で止めた(limit に届く前に止まった場合を含む)。warning を出す目安。 */
  hitPageCap: boolean;
}

export async function fetchActivityRange(
  client: BacklogClient,
  path: string,
  options: FetchActivityRangeOptions = {},
): Promise<ActivityRange> {
  const { since, until, limit } = options;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const sinceMs = since?.getTime();
  const { items, truncated } = await fetchByCursor<BacklogActivity>(
    async ({ maxId, count }) => {
      const batch =
        (await client.request<BacklogActivity[]>("GET", path, {
          query: { ...options.query, count, maxId },
        })) ?? [];
      if (sinceMs === undefined) return batch;
      // 新しい順なので、since より古いものに届いたらそれ以降は全部古い。短いページにしてここで終わらせる。
      const at = batch.findIndex((a) => a.created && Date.parse(a.created) < sinceMs);
      return at < 0 ? batch : batch.slice(0, at);
    },
    (a) => a.id,
    { maxPages, ...(limit === undefined ? {} : { limit }) },
  );
  const untilMs = until?.getTime();
  const activities = items.filter(
    (a) => !!a.created && (untilMs === undefined || Date.parse(a.created) <= untilMs),
  );
  const reachedLimit = limit !== undefined && items.length >= limit;
  return { activities, truncated, hitPageCap: truncated && !reachedLimit };
}
