import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_PAGES, fetchByCursor, fetchByOffset } from "../../src/backlog/paging";

/** id 1..total の降順(新しい順)配列から、Backlog 風に maxId / count で切り出す。 */
function descSource(total: number) {
  const calls: { maxId?: number; count: number }[] = [];
  const all = Array.from({ length: total }, (_, i) => ({ id: total - i }));
  return {
    calls,
    fetchPage: async (p: { maxId?: number; count: number }) => {
      calls.push(p);
      const max = p.maxId ?? Number.POSITIVE_INFINITY;
      return all.filter((x) => x.id <= max).slice(0, p.count);
    },
  };
}

describe("fetchByOffset (offset/count 方式)", () => {
  function source(total: number) {
    const calls: { offset: number; count: number }[] = [];
    return {
      calls,
      fetchPage: async (p: { offset: number; count: number }) => {
        calls.push(p);
        return Array.from({ length: total }, (_, i) => i).slice(p.offset, p.offset + p.count);
      },
    };
  }

  it("既定のページ上限は 10", () => {
    expect(DEFAULT_MAX_PAGES).toBe(10);
  });

  it("端数のページで終わったら、そこで止まる", async () => {
    const s = source(250);
    const r = await fetchByOffset(s.fetchPage, { pageSize: 100 });
    expect(r.items).toHaveLength(250);
    expect(r.truncated).toBe(false);
    expect(s.calls).toEqual([
      { offset: 0, count: 100 },
      { offset: 100, count: 100 },
      { offset: 200, count: 100 },
    ]);
  });

  it("ページ上限で打ち切り、truncated=true にする", async () => {
    const s = source(10_000);
    const r = await fetchByOffset(s.fetchPage, { pageSize: 100, maxPages: 3 });
    expect(r.items).toHaveLength(300);
    expect(r.truncated).toBe(true);
    expect(s.calls).toHaveLength(3);
  });

  it("limit に達したら止まり、最後のページは count を絞る", async () => {
    const s = source(1000);
    const r = await fetchByOffset(s.fetchPage, { pageSize: 100, limit: 150 });
    expect(r.items).toHaveLength(150);
    expect(s.calls.at(-1)).toEqual({ offset: 100, count: 50 });
    expect(r.truncated).toBe(true);
  });

  it("ちょうど全件でページ上限に達したときは truncated=false(次ページが空と確認できた場合のみ)", async () => {
    const s = source(200);
    const r = await fetchByOffset(s.fetchPage, { pageSize: 100, maxPages: 3 });
    expect(r.items).toHaveLength(200);
    expect(r.truncated).toBe(false);
  });

  it("ページを並列に取らず、順番に取る", async () => {
    let inFlight = 0;
    let max = 0;
    await fetchByOffset(
      async (p) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return p.offset < 200 ? new Array(p.count).fill(0) : [];
      },
      { pageSize: 100 },
    );
    expect(max).toBe(1);
  });
});

describe("fetchByCursor (minId/maxId 方式)", () => {
  it("降順: 最後の id - 1 を maxId にして続きを取り、端数のページで止まる", async () => {
    const s = descSource(250);
    const r = await fetchByCursor(s.fetchPage, (x) => x.id, { pageSize: 100 });
    expect(r.items).toHaveLength(250);
    expect(r.items[0]?.id).toBe(250);
    expect(r.items.at(-1)?.id).toBe(1);
    expect(r.truncated).toBe(false);
    expect(s.calls).toEqual([
      { count: 100 },
      { maxId: 150, count: 100 },
      { maxId: 50, count: 100 },
    ]);
  });

  it("昇順: 最後の id + 1 を minId にして続きを取る", async () => {
    const calls: { minId?: number; count: number }[] = [];
    const all = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
    const r = await fetchByCursor(
      async (p: { minId?: number; count: number }) => {
        calls.push(p);
        return all.filter((x) => x.id >= (p.minId ?? 0)).slice(0, p.count);
      },
      (x) => x.id,
      { pageSize: 2, direction: "asc" },
    );
    expect(r.items.map((x) => x.id)).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toEqual([{ count: 2 }, { minId: 3, count: 2 }, { minId: 5, count: 2 }]);
  });

  it("ページ上限で打ち切り、truncated=true にする", async () => {
    const s = descSource(10_000);
    const r = await fetchByCursor(s.fetchPage, (x) => x.id, { pageSize: 100, maxPages: 2 });
    expect(r.items).toHaveLength(200);
    expect(r.truncated).toBe(true);
    expect(s.calls).toHaveLength(2);
  });

  it("limit に達したら止まる", async () => {
    const s = descSource(1000);
    const r = await fetchByCursor(s.fetchPage, (x) => x.id, { pageSize: 100, limit: 120 });
    expect(r.items).toHaveLength(120);
    expect(s.calls.at(-1)).toEqual({ maxId: 900, count: 20 });
    expect(r.truncated).toBe(true);
  });

  it("次のカーソルが 0 以下になったら止まる", async () => {
    const s = descSource(100);
    const r = await fetchByCursor(s.fetchPage, (x) => x.id, { pageSize: 100 });
    expect(r.items).toHaveLength(100);
    expect(s.calls).toHaveLength(1);
    expect(r.truncated).toBe(false);
  });
});
