import { describe, expect, it } from "vitest";
import { myTasks } from "../../src/mcp/tools/analysis";
import { ago, endless, issue, NOW, paged, USER_B } from "../helpers/analysis-fixtures";
import { callTool } from "../helpers/tool-call";

const ME = { id: 1, userId: "a", name: "Alice" };
const run = (
  args: Record<string, unknown>,
  respond: Parameters<typeof callTool>[2],
  opts: { now?: Date; timezone?: string } = {},
) =>
  callTool(
    "logbutler_my_tasks",
    args,
    { "GET /users/myself": ME, "GET /users/1/watchings": [], ...respond },
    { now: opts.now ?? NOW, timezone: opts.timezone ?? "Asia/Tokyo" },
  );
const keys = (items: { issue_key: string }[]) => items.map((i) => i.issue_key);
const watching = (
  key: string,
  over: Record<string, unknown> = {},
  w: Record<string, unknown> = {},
) => ({
  id: Number(key.split("-")[1]),
  type: "issue",
  resourceAlreadyRead: false,
  lastContentUpdated: null,
  issue: issue({ key, ...over }),
  ...w,
});

describe("my_tasks", () => {
  it("API は GetMyself → overdue → upcoming → watching の順に直列。week の NOW(水 10/28)は月 10/26〜日 11/01、overdue は昨日(10/27)まで", async () => {
    const r = await run({}, { "GET /issues": [] });
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toEqual([
      "GET /users/myself",
      "GET /issues?assigneeId[]=1&count=100&dueDateUntil=2026-10-27&statusId[]=1&statusId[]=2&statusId[]=3",
      "GET /issues?assigneeId[]=1&count=100&dueDateSince=2026-10-26&dueDateUntil=2026-11-01&statusId[]=1&statusId[]=2&statusId[]=3",
      "GET /users/1/watchings?count=100",
    ]);
    expect(r.json.resource).toBe("my_tasks");
    expect(r.json.analysis).toMatchObject({
      user: { id: 1, name: "Alice" },
      mode: "week",
      date_range: { since: "2026-10-26T00:00:00+09:00", until: "2026-11-01T00:00:00+09:00" },
      overdue: [],
      upcoming: [],
      watching: [],
      summary: { overdue_count: 0, upcoming_count: 0, watching_count: 0, total_count: 0 },
      truncated: false,
    });
  });

  it("overdue と upcoming の期間が重なる日の課題は overdue にだけ出す(再現: logvalet は両方に出していた)", async () => {
    // 水曜の今日は since=月曜 ≤ 昨日=火曜 なので、月・火が重なる。
    const a = issue({ key: "P-1", dueDate: "2026-10-25T00:00:00Z" });
    const b = issue({ key: "P-2", dueDate: "2026-10-27T00:00:00Z" }); // 重なる日
    const c = issue({ key: "P-3", dueDate: "2026-10-30T00:00:00Z" });
    let n = 0;
    const r = await run({}, { "GET /issues": () => (n++ === 0 ? [a, b] : [b, c]) });
    expect(keys(r.json.analysis.overdue)).toEqual(["P-1", "P-2"]);
    expect(keys(r.json.analysis.upcoming)).toEqual(["P-3"]);
    expect(r.json.analysis.summary).toEqual({
      overdue_count: 2,
      upcoming_count: 1,
      watching_count: 0,
      total_count: 3,
    });
  });

  it("項目: issue_key / summary / status / priority / due_date(なければ null)/ project_key", async () => {
    const r = await run(
      {},
      {
        "GET /issues": [
          issue({
            key: "PROJ-7",
            status: "処理中",
            priority: "高",
            dueDate: "2026-10-27T00:00:00Z",
          }),
          issue({ key: "PROJ-8", status: null, priority: null }),
        ],
      },
    );
    expect(r.json.analysis.overdue[0]).toEqual({
      issue_key: "PROJ-7",
      summary: "summary PROJ-7",
      status: "処理中",
      priority: "高",
      due_date: "2026-10-27T00:00:00Z",
      project_key: "PROJ",
    });
    expect(r.json.analysis.overdue[1]).toMatchObject({ status: "", priority: "", due_date: null });
  });

  it.each([
    ["月", "2026-10-26T03:00:00Z", "2026-10-26", "2026-10-30"],
    ["火", "2026-10-27T03:00:00Z", "2026-10-27", "2026-11-02"],
    ["水", "2026-10-28T03:00:00Z", "2026-10-28", "2026-11-03"],
    ["木", "2026-10-29T03:00:00Z", "2026-10-29", "2026-11-04"],
    ["金", "2026-10-30T03:00:00Z", "2026-10-30", "2026-11-05"],
    ["土", "2026-10-31T03:00:00Z", "2026-10-31", "2026-11-05"],
    ["日", "2026-11-01T03:00:00Z", "2026-11-01", "2026-11-05"],
  ])(
    "next モード(%s曜): 今日から営業日 4〜6 日先(月 +4 / 火〜金 +6 / 土 +5 / 日 +4)",
    async (_d, now, since, until) => {
      const r = await run({ mode: "next" }, { "GET /issues": [] }, { now: new Date(now) });
      expect(r.json.analysis.mode).toBe("next");
      expect(r.calls[2]).toContain(`dueDateSince=${since}&dueDateUntil=${until}`);
      expect(r.json.analysis.date_range).toEqual({
        since: `${since}T00:00:00+09:00`,
        until: `${until}T00:00:00+09:00`,
      });
    },
  );

  it("日付は timezone の暦日(UTC 10/28 16:30 は JST では 10/29 木曜、UTC では 10/28 水曜)", async () => {
    const now = new Date("2026-10-28T16:30:00Z");
    const jst = await run({ mode: "next" }, { "GET /issues": [] }, { now, timezone: "Asia/Tokyo" });
    expect(jst.calls[1]).toContain("dueDateUntil=2026-10-28"); // 昨日 = JST の 10/28
    expect(jst.calls[2]).toContain("dueDateSince=2026-10-29&dueDateUntil=2026-11-04");
    const utc = await run({ mode: "next" }, { "GET /issues": [] }, { now, timezone: "UTC" });
    expect(utc.calls[1]).toContain("dueDateUntil=2026-10-27");
    expect(utc.calls[2]).toContain("dueDateSince=2026-10-28&dueDateUntil=2026-11-03");
    expect(utc.json.analysis.date_range.since).toBe("2026-10-28T00:00:00Z");
  });

  it("mode が week / next 以外は argument_error(logvalet は week として扱い mode をそのまま返していた)", async () => {
    const r = await run({ mode: "month" }, {});
    expect(r.isError).toBe(true);
    expect(r.json.error.code).toBe("argument_error");
    expect(r.calls).toEqual([]);
  });

  describe("watching", () => {
    const list = (...w: unknown[]) => ({ "GET /issues": [], "GET /users/1/watchings": w });

    it("担当済み(overdue / upcoming に出た課題)と status.id = 4 の課題は除く", async () => {
      const r = await run(
        {},
        {
          "GET /issues": [issue({ key: "P-1", dueDate: "2026-10-25T00:00:00Z" })],
          "GET /users/1/watchings": [
            watching("P-1"),
            watching("P-2", { status: "完了", statusId: 4 }),
            watching("P-3", { status: "処理中", statusId: 2 }),
            { id: 99, type: "issue", issue: null },
          ],
        },
      );
      expect(keys(r.json.analysis.watching)).toEqual(["P-3"]);
      expect(r.json.analysis.summary.watching_count).toBe(1);
    });

    it("項目: assignee は名前(なければ空文字)、is_overdue、is_stale と days_since_update は lastContentUpdated を優先し、なければ issue.updated", async () => {
      const r = await run(
        { stale_days: 5 },
        list(
          watching(
            "P-1",
            {
              assignee: USER_B,
              updated: ago(1),
              dueDate: "2026-10-20T00:00:00Z",
              status: "処理中",
              priority: "高",
            },
            { lastContentUpdated: ago(6) },
          ),
          watching("P-2", { updated: ago(4) }),
          watching("P-3", { updated: ago(5) }),
        ),
      );
      const [a, b, c] = r.json.analysis.watching;
      expect(a).toEqual({
        issue_key: "P-1",
        summary: "summary P-1",
        status: "処理中",
        priority: "高",
        due_date: "2026-10-20T00:00:00Z",
        project_key: "P",
        assignee: "Bob",
        is_overdue: true,
        is_stale: true,
        days_since_update: 6,
      });
      expect(b).toMatchObject({
        assignee: "",
        is_overdue: false,
        is_stale: false,
        days_since_update: 4,
      });
      expect(c).toMatchObject({ is_stale: true, days_since_update: 5 }); // 境界(5 日ちょうど)は含む
    });

    it("stale_days 未指定・0 以下は 7 日", async () => {
      for (const args of [{}, { stale_days: 0 }]) {
        const r = await run(
          args,
          list(watching("P-1", { updated: ago(7) }), watching("P-2", { updated: ago(6) })),
        );
        expect(r.json.analysis.watching.map((w: { is_stale: boolean }) => w.is_stale)).toEqual([
          true,
          false,
        ]);
      }
    });

    it("ウォッチが 100 件を超えてもページングで全件取る", async () => {
      const all = Array.from({ length: 130 }, (_, i) =>
        watching(`P-${i + 1}`, { updated: ago(1) }),
      );
      const r = await run({}, { "GET /issues": [], "GET /users/1/watchings": paged(all) });
      expect(r.json.analysis.watching).toHaveLength(130);
      expect(r.calls.filter((c) => c.includes("watchings"))).toEqual([
        "GET /users/1/watchings?count=100",
        "GET /users/1/watchings?count=100&offset=100",
      ]);
    });
  });

  it("20 件より多い担当課題も全件取る(再現: logvalet は 20 件で打ち切り)", async () => {
    const all = Array.from({ length: 150 }, (_, i) =>
      issue({ key: `P-${i + 1}`, dueDate: "2026-10-01T00:00:00Z" }),
    );
    const r = await run({}, { "GET /issues": paged(all) });
    expect(r.json.analysis.overdue).toHaveLength(150);
  });

  it("overdue / upcoming / watching の取得失敗は、それぞれ warning にして残りを返す", async () => {
    const err = (status: number) =>
      new Response(JSON.stringify({ errors: [{ message: "x", code: 1 }] }), { status });
    let n = 0;
    const r = await run(
      {},
      {
        "GET /issues": () => (n++ === 0 ? err(500) : err(500)),
        "GET /users/1/watchings": err(503),
      },
    );
    expect(r.isError, r.text).toBe(false);
    expect(
      r.json.warnings.map((w: { code: string; component: string }) => [w.code, w.component]),
    ).toEqual([
      ["overdue_fetch_failed", "overdue"],
      ["upcoming_fetch_failed", "upcoming"],
      ["watching_fetch_failed", "watching"],
    ]);
    expect(r.json.analysis.summary.total_count).toBe(0);
  });

  it("GetMyself の失敗はツールエラー", async () => {
    const r = await callTool(
      "logbutler_my_tasks",
      {},
      {
        "GET /users/myself": new Response(
          JSON.stringify({ errors: [{ message: "x", code: 11 }] }),
          { status: 403 },
        ),
      },
      { now: NOW },
    );
    expect(r.isError).toBe(true);
    expect(r.json.error.code).toBe("permission_error");
  });

  describe("API 呼び出し数(最悪ケース = 1 + 10 + 10 + 10)", () => {
    it("maxApiCalls は 31", () => {
      expect(myTasks.maxApiCalls).toBe(31);
    });
    it("3 つとも上限まで続いても 31 回で止まり、truncated と警告が出る", async () => {
      const r = await run(
        {},
        {
          "GET /issues": endless((n) => issue({ key: `P-${n}`, dueDate: "2026-10-01T00:00:00Z" })),
          "GET /users/1/watchings": endless((n) => watching(`W-${n}`, { updated: ago(1) })),
        },
      );
      expect(r.isError, r.text).toBe(false);
      expect(r.calls).toHaveLength(31);
      expect(r.json.analysis.truncated).toBe(true);
      expect(r.json.warnings.map((w: { code: string }) => w.code)).toEqual([
        "overdue_truncated",
        "upcoming_truncated",
        "watching_truncated",
      ]);
    });
  });
});
