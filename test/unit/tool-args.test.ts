import { describe, expect, it } from "vitest";
import { ArgumentError } from "../../src/errors";
import {
  boundedCount,
  dateRangeFor,
  parseCsvInts,
  parseCsvStrings,
  parseDate,
  positiveOrUndefined,
  resolveProjectId,
  resolveStatusIds,
  resolveUserId,
  seg,
  todayIn,
} from "../../src/mcp/args";
import { fakeClient } from "../helpers/mcp";

const argErr = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ArgumentError);
    return (e as ArgumentError).message;
  }
  throw new Error("ArgumentError が投げられるはずだった");
};

describe("seg", () => {
  it("パスの 1 セグメントとして安全にエスケープする", () => {
    expect(seg("PROJ-1")).toBe("PROJ-1");
    expect(seg("a/b c?d#e")).toBe("a%2Fb%20c%3Fd%23e");
    expect(seg(42)).toBe("42");
  });
  it("`.` と `..` はパスを辿れてしまう(URL の正規化で別の API になる)ので argument_error", () => {
    expect(argErr(() => seg("."))).toContain("path");
    expect(argErr(() => seg(".."))).toContain("path");
    expect(seg("..a")).toBe("..a");
  });
});

describe("boundedCount / positiveOrUndefined", () => {
  it("boundedCount: 未指定は undefined、1〜100 はそのまま、範囲外は argument_error", () => {
    expect(boundedCount("count", undefined)).toBeUndefined();
    expect(boundedCount("count", 1)).toBe(1);
    expect(boundedCount("count", 100)).toBe(100);
    expect(argErr(() => boundedCount("count", 0))).toContain("count");
    expect(argErr(() => boundedCount("count", 101))).toContain("1");
    expect(argErr(() => boundedCount("count", -5))).toContain("100");
  });
  it("positiveOrUndefined: 0 以下は送らない(logvalet と同じ)", () => {
    expect(positiveOrUndefined(undefined)).toBeUndefined();
    expect(positiveOrUndefined(0)).toBeUndefined();
    expect(positiveOrUndefined(-1)).toBeUndefined();
    expect(positiveOrUndefined(3)).toBe(3);
  });
});

describe("CSV", () => {
  it("parseCsvInts: 空白を許し、空要素を捨てる。未指定・空は undefined", () => {
    expect(parseCsvInts("activity_type_ids", undefined)).toBeUndefined();
    expect(parseCsvInts("activity_type_ids", "")).toBeUndefined();
    expect(parseCsvInts("activity_type_ids", "1, 2,,3")).toEqual([1, 2, 3]);
  });
  it("parseCsvInts: 整数でない要素は argument_error(引数名入り)", () => {
    expect(argErr(() => parseCsvInts("parent_issue_ids", "1,x"))).toContain("parent_issue_ids");
    expect(argErr(() => parseCsvInts("parent_issue_ids", "1.5"))).toContain("parent_issue_ids");
  });
  it("parseCsvStrings: 空白を除き、空要素を捨てる", () => {
    expect(parseCsvStrings("")).toEqual([]);
    expect(parseCsvStrings(undefined)).toEqual([]);
    expect(parseCsvStrings(" A, B ,,C")).toEqual(["A", "B", "C"]);
  });
});

describe("parseDate", () => {
  it("YYYY-MM-DD を検証してそのまま返す", () => {
    expect(parseDate("updated_since", "2026-02-28")).toBe("2026-02-28");
    expect(parseDate("updated_since", "2024-02-29")).toBe("2024-02-29");
  });
  it("形式違い・存在しない日付は argument_error(引数名入り)", () => {
    for (const bad of ["2026-2-1", "2026-02-30", "20260201", "2026-13-01", "abc", ""]) {
      expect(argErr(() => parseDate("updated_since", bad))).toContain("updated_since");
    }
  });
});

describe("resolveStatusIds", () => {
  it("not-closed は [1,2,3]、数値の CSV はそのまま", () => {
    expect(resolveStatusIds("not-closed")).toEqual([1, 2, 3]);
    expect(resolveStatusIds("4, 5")).toEqual([4, 5]);
  });
  it("それ以外・空は argument_error", () => {
    expect(argErr(() => resolveStatusIds("open"))).toContain("status_id");
    expect(argErr(() => resolveStatusIds(",,"))).toContain("status_id");
  });
});

describe("todayIn(基準タイムゾーンの今日)", () => {
  it("UTC の 15:00 は Asia/Tokyo では翌日", () => {
    const now = new Date("2026-10-28T15:00:00Z");
    expect(todayIn(now, "Asia/Tokyo")).toEqual({ y: 2026, m: 10, d: 29 });
    expect(todayIn(now, "UTC")).toEqual({ y: 2026, m: 10, d: 28 });
    expect(todayIn(now, "America/Los_Angeles")).toEqual({ y: 2026, m: 10, d: 28 });
  });
  it("存在しないタイムゾーンは例外(設定ミス)", () => {
    expect(() => todayIn(new Date(), "Mars/Base")).toThrow();
  });
});

describe("dateRangeFor", () => {
  // 2026-10-28 は水曜日
  const today = { y: 2026, m: 10, d: 28 };
  it("today", () => {
    expect(dateRangeFor("due_date", "today", today)).toEqual({
      since: "2026-10-28",
      until: "2026-10-28",
    });
  });
  it("overdue は昨日まで(due_date のみ)", () => {
    expect(dateRangeFor("due_date", "overdue", today)).toEqual({ until: "2026-10-27" });
    expect(argErr(() => dateRangeFor("start_date", "overdue", today))).toContain("start_date");
  });
  it("this-week は月曜〜日曜", () => {
    expect(dateRangeFor("due_date", "this-week", today)).toEqual({
      since: "2026-10-26",
      until: "2026-11-01",
    });
  });
  it("this-week: 日曜日は前の月曜から(週の始まりは月曜)", () => {
    expect(dateRangeFor("due_date", "this-week", { y: 2026, m: 11, d: 1 })).toEqual({
      since: "2026-10-26",
      until: "2026-11-01",
    });
    expect(dateRangeFor("due_date", "this-week", { y: 2026, m: 10, d: 26 })).toEqual({
      since: "2026-10-26",
      until: "2026-11-01",
    });
  });
  it("this-month", () => {
    expect(dateRangeFor("start_date", "this-month", today)).toEqual({
      since: "2026-10-01",
      until: "2026-10-31",
    });
    expect(dateRangeFor("start_date", "this-month", { y: 2028, m: 2, d: 10 })).toEqual({
      since: "2028-02-01",
      until: "2028-02-29",
    });
  });
  it("単一日付・範囲 A:B・A:・:B", () => {
    expect(dateRangeFor("due_date", "2026-01-05", today)).toEqual({
      since: "2026-01-05",
      until: "2026-01-05",
    });
    expect(dateRangeFor("due_date", "2026-01-05:2026-01-09", today)).toEqual({
      since: "2026-01-05",
      until: "2026-01-09",
    });
    expect(dateRangeFor("due_date", "2026-01-05:", today)).toEqual({ since: "2026-01-05" });
    expect(dateRangeFor("due_date", ":2026-01-09", today)).toEqual({ until: "2026-01-09" });
  });
  it("不正な値は argument_error(引数名と許される形式入り)", () => {
    for (const bad of ["tomorrow", "2026-1-1", ":", "2026-01-05:x", "x:2026-01-05"]) {
      const m = argErr(() => dateRangeFor("due_date", bad, today));
      expect(m).toContain("due_date");
      expect(m).toContain("YYYY-MM-DD");
    }
  });
  it("年またぎ(1/1 の this-week)", () => {
    expect(dateRangeFor("due_date", "this-week", { y: 2026, m: 1, d: 1 })).toEqual({
      since: "2025-12-29",
      until: "2026-01-04",
    });
  });
});

describe("resolveUserId", () => {
  it("me は GET /users/myself の id、数値文字列は数値", async () => {
    const client = fakeClient({ getMyself: async () => ({ id: 42, userId: "a", name: "A" }) });
    expect(await resolveUserId(client, "me")).toBe(42);
    expect(await resolveUserId(client, "12345")).toBe(12345);
  });
  it("数値文字列なら Backlog を呼ばない(fakeClient は想定外の呼び出しで例外)", async () => {
    await expect(resolveUserId(fakeClient(), "7")).resolves.toBe(7);
  });
  it("それ以外は argument_error", async () => {
    await expect(resolveUserId(fakeClient(), "alice", "assignee_id")).rejects.toThrow(
      /assignee_id/,
    );
    await expect(resolveUserId(fakeClient(), "", "user_id")).rejects.toBeInstanceOf(ArgumentError);
  });
});

describe("resolveProjectId", () => {
  it("GET /projects/{key} の id を返し、同じクライアントの中ではキャッシュする", async () => {
    const calls: string[] = [];
    const client = fakeClient({
      request: (async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        return { id: path.endsWith("A") ? 1 : 2 };
      }) as never,
    });
    expect(await resolveProjectId(client, "A")).toBe(1);
    expect(await resolveProjectId(client, "A")).toBe(1);
    expect(await resolveProjectId(client, "B")).toBe(2);
    expect(calls).toEqual(["GET /projects/A", "GET /projects/B"]);
  });
  it("別のクライアント(= 別のツール呼び出し)では共有しない", async () => {
    let n = 0;
    const make = () =>
      fakeClient({
        request: (async () => ({ id: ++n })) as never,
      });
    expect(await resolveProjectId(make(), "A")).toBe(1);
    expect(await resolveProjectId(make(), "A")).toBe(2);
  });
  it("失敗はキャッシュしない", async () => {
    let n = 0;
    const client = fakeClient({
      request: (async () => {
        if (++n === 1) throw new Error("boom");
        return { id: 9 };
      }) as never,
    });
    await expect(resolveProjectId(client, "A")).rejects.toThrow("boom");
    expect(await resolveProjectId(client, "A")).toBe(9);
  });
  it("キーはエスケープして送る", async () => {
    let path = "";
    const client = fakeClient({
      request: (async (_m: string, p: string) => {
        path = p;
        return { id: 1 };
      }) as never,
    });
    await resolveProjectId(client, "A/B");
    expect(path).toBe("/projects/A%2FB");
  });
});
