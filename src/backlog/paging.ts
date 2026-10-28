/**
 * ページングのヘルパー。クライアント(`client.ts`)は自動ページングをしない。呼び出し側(ツール)が
 * ここを使い、ページ数の上限を必ず付ける。ページは必ず順番に取る(並列にしない)。
 *
 * - offset/count 方式: issues など `offset` を受け付ける API 用。
 * - minId/maxId カーソル方式: activities など `offset` のない API 用(logvalet の FetchUserActivities 相当)。
 */

/** 1 回の取得で辿るページ数の上限。pageSize 100 で最大 1,000 件。 */
export const DEFAULT_MAX_PAGES = 10;
/** Backlog の count の最大値。 */
export const DEFAULT_PAGE_SIZE = 100;

export interface PagingOptions {
  pageSize?: number;
  maxPages?: number;
  /** これだけ集まったら止める(省略時は上限なし。maxPages だけが上限)。 */
  limit?: number;
}

export interface PagedResult<T> {
  items: T[];
  /** ページ上限または limit で止めた(続きがある可能性がある)。 */
  truncated: boolean;
}

export async function fetchByOffset<T>(
  fetchPage: (page: { offset: number; count: number }) => Promise<T[]>,
  options: PagingOptions = {},
): Promise<PagedResult<T>> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const items: T[] = [];
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const count = Math.min(pageSize, (options.limit ?? Number.POSITIVE_INFINITY) - items.length);
    const batch = await fetchPage({ offset: items.length, count });
    items.push(...batch);
    if (batch.length < count) return { items, truncated: false };
    if (options.limit !== undefined && items.length >= options.limit)
      return { items, truncated: true };
    truncated = true; // 最後のページが満杯なら、続きがあるかもしれない
  }
  return { items, truncated };
}

export interface CursorOptions extends PagingOptions {
  /** desc: 新しい順に maxId で遡る(既定)。asc: 古い順に minId で進む。 */
  direction?: "desc" | "asc";
}

export async function fetchByCursor<T>(
  fetchPage: (page: { minId?: number; maxId?: number; count: number }) => Promise<T[]>,
  getId: (item: T) => number,
  options: CursorOptions = {},
): Promise<PagedResult<T>> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const asc = options.direction === "asc";
  const items: T[] = [];
  let cursor: number | undefined;
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const count = Math.min(pageSize, (options.limit ?? Number.POSITIVE_INFINITY) - items.length);
    const batch = await fetchPage({
      ...(cursor === undefined ? {} : asc ? { minId: cursor } : { maxId: cursor }),
      count,
    });
    items.push(...batch);
    if (batch.length < count) return { items, truncated: false };
    if (options.limit !== undefined && items.length >= options.limit)
      return { items, truncated: true };
    const lastId = getId(batch[batch.length - 1] as T);
    cursor = asc ? lastId + 1 : lastId - 1;
    if (cursor <= 0) return { items, truncated: false };
    truncated = true;
  }
  return { items, truncated };
}
