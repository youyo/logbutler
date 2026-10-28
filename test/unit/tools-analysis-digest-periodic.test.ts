import { describe, expect, it } from "vitest";
import { digestDaily, digestWeekly } from "../../src/mcp/tools/analysis";
import { ago, endless, issue, NOW, paged, USER_A } from "../helpers/analysis-fixtures";
import { callTool } from "../helpers/tool-call";

const run = (
  tool: "daily" | "weekly",
  args: Record<string, unknown>,
  respond: Parameters<typeof callTool>[2],
  now = NOW,
) =>
  callTool(
    `logbutler_digest_${tool}`,
    { project_key: "P", ...args },
    { "GET /projects/P": { id: 10 }, ...respond },
    { now, timezone: "Asia/Tokyo" },
  );
const listing = (issues: unknown[]) => ({ "GET /issues": paged(issues) });
const keys = (items: { issue_key: string }[]) => items.map((i) => i.issue_key);

describe("digest_daily / digest_weekly", () => {
  it("API は GetProject → 課題一覧(updatedSince / updatedUntil を日付で渡す)。daily の既定は 1 日前〜今", async () => {
    const r = await run("daily", {}, listing([]));
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toEqual([
      "GET /projects/P",
      "GET /issues?count=100&projectId[]=10&updatedSince=2026-10-27&updatedUntil=2026-10-28",
    ]);
    expect(r.json.resource).toBe("periodic_digest");
    expect(r.json.analysis).toMatchObject({
      project_key: "P",
      period: "daily",
      since: "2026-10-27T12:00:00+09:00",
      until: "2026-10-28T12:00:00+09:00",
      truncated: false,
    });
  });

  it("weekly の既定は 7 日前〜今", async () => {
    const r = await run("weekly", {}, listing([]));
    expect(r.json.analysis).toMatchObject({
      period: "weekly",
      since: "2026-10-21T12:00:00+09:00",
      until: "2026-10-28T12:00:00+09:00",
    });
    expect(r.calls[1]).toContain("updatedSince=2026-10-21&updatedUntil=2026-10-28");
  });

  it("until は当日を含める: until=2026-10-27 なら JST の 10/27 23:59:59.999 まで(logvalet は 10/27 00:00 で切っていた)", async () => {
    const inside = issue({ key: "P-1", status: "完了", updated: "2026-10-27T14:00:00Z" }); // JST 10/27 23:00
    const outside = issue({ key: "P-2", status: "完了", updated: "2026-10-27T15:00:00Z" }); // JST 10/28 00:00
    const r = await run(
      "weekly",
      { since: "2026-10-20", until: "2026-10-27" },
      listing([inside, outside]),
    );
    expect(keys(r.json.analysis.completed)).toEqual(["P-1"]);
    expect(r.json.analysis.until).toBe("2026-10-27T23:59:59.999+09:00");
    expect(r.calls[1]).toContain("updatedSince=2026-10-20&updatedUntil=2026-10-27");
  });

  it("since は当日 00:00(JST)から含める", async () => {
    const edge = issue({ key: "P-1", status: "完了", updated: "2026-10-19T15:00:00Z" }); // JST 10/20 00:00
    const before = issue({ key: "P-2", status: "完了", updated: "2026-10-19T14:59:59Z" });
    const r = await run(
      "weekly",
      { since: "2026-10-20", until: "2026-10-27" },
      listing([edge, before]),
    );
    expect(keys(r.json.analysis.completed)).toEqual(["P-1"]);
    expect(r.json.analysis.since).toBe("2026-10-20T00:00:00+09:00");
  });

  it("優先順位 completed > blocked > started。started は created が期間内で完了でないもの", async () => {
    const r = await run(
      "weekly",
      {},
      listing([
        // 完了(期間内に更新)。タイトルにキーワードがあっても completed
        issue({
          key: "P-1",
          status: "完了",
          summary: "保留だった件",
          assignee: USER_A,
          updated: ago(1),
        }),
        // 完了集合の別名(Closed / Done / Resolved / 対応済み)
        issue({ key: "P-2", status: "Closed", updated: ago(2) }),
        issue({ key: "P-3", status: "Done", updated: ago(2) }),
        // 期間内に作成され、タイトルに blocked → blocked(started にはならない)
        issue({
          key: "P-4",
          status: "処理中",
          summary: "API is Blocked",
          created: ago(2),
          updated: ago(1),
        }),
        // 期間内に作成 → started
        issue({ key: "P-5", status: "未対応", created: ago(3), updated: ago(1), assignee: USER_A }),
        // 期間前に作成 → どれにも入らない
        issue({ key: "P-6", status: "未対応", created: ago(30), updated: ago(1) }),
        // created なし → started にしない
        issue({ key: "P-7", status: "未対応", created: null, updated: ago(1) }),
      ]),
    );
    const a = r.json.analysis;
    expect(keys(a.completed)).toEqual(["P-1", "P-2", "P-3"]);
    expect(keys(a.blocked)).toEqual(["P-4"]);
    expect(keys(a.started)).toEqual(["P-5"]);
    expect(a.summary).toEqual({
      completed_count: 3,
      started_count: 1,
      blocked_count: 1,
      total_active_count: 7,
    });
  });

  it("completed は updated が期間内の完了集合。期間外に更新された完了は completed にしない", async () => {
    const r = await run(
      "weekly",
      {},
      listing([issue({ key: "P-1", status: "完了", updated: ago(10), created: ago(40) })]),
    );
    expect(r.json.analysis.completed).toEqual([]);
  });

  it("項目: completed は completed_at(= updated)、started は started_at(= created)、assignee は {id,name} か null、blocked は block_signals", async () => {
    const r = await run(
      "daily",
      {},
      listing([
        issue({ key: "P-1", status: "完了", assignee: USER_A, updated: ago(0, 3) }),
        issue({ key: "P-2", status: "未対応", created: ago(0, 5), updated: ago(0, 5) }),
        issue({ key: "P-3", status: "on hold", summary: "保留 と blocked", updated: ago(0, 2) }),
      ]),
    );
    expect(r.json.analysis.completed[0]).toEqual({
      issue_key: "P-1",
      summary: "summary P-1",
      assignee: { id: 1, name: "Alice" },
      completed_at: ago(0, 3),
    });
    expect(r.json.analysis.started[0]).toEqual({
      issue_key: "P-2",
      summary: "summary P-2",
      assignee: null,
      started_at: ago(0, 5),
    });
    expect(r.json.analysis.blocked[0]).toEqual({
      issue_key: "P-3",
      summary: "保留 と blocked",
      assignee: null,
      block_signals: [
        '課題タイトルにブロッカーキーワードを含む: "保留"',
        '課題タイトルにブロッカーキーワードを含む: "blocked"',
        'ステータス名がブロッカーキーワードに一致: "on hold"',
      ],
    });
  });

  it("ブロッカーキーワードは 対応中断 / 保留 / ブロック / blocked / on hold。ステータス名は大文字小文字を区別しない一致", async () => {
    const r = await run(
      "daily",
      {},
      listing([
        issue({ key: "P-1", status: "ON HOLD", updated: ago(0, 1) }),
        issue({ key: "P-2", summary: "対応中断します", updated: ago(0, 1) }),
        issue({ key: "P-3", summary: "ブロックされた", updated: ago(0, 1) }),
        issue({ key: "P-4", summary: "普通の課題", updated: ago(0, 1) }),
      ]),
    );
    expect(keys(r.json.analysis.blocked)).toEqual(["P-1", "P-2", "P-3"]);
  });

  it("同順位の並びは issue_key 昇順(API の返す順に依存しない)", async () => {
    const r = await run(
      "daily",
      {},
      listing([
        issue({ key: "P-3", status: "完了", updated: ago(0, 1) }),
        issue({ key: "P-1", status: "完了", updated: ago(0, 1) }),
        issue({ key: "P-2", status: "完了", updated: ago(0, 1) }),
      ]),
    );
    expect(keys(r.json.analysis.completed)).toEqual(["P-1", "P-2", "P-3"]);
  });

  it("llm_hints: ブロック課題と完了課題の件数", async () => {
    const r = await run(
      "weekly",
      {},
      listing([
        issue({ key: "P-1", status: "完了", updated: ago(1) }),
        issue({ key: "P-2", summary: "保留", updated: ago(1) }),
      ]),
    );
    expect(r.json.analysis.llm_hints).toEqual({
      primary_entities: ["project:P"],
      open_questions: ["1件のブロック課題があります"],
      suggested_next_actions: ["1件の完了課題をレビューしてください"],
    });
  });

  it("20 件より多い課題がある場合も全件を分類する(再現: logvalet は 20 件で打ち切り)", async () => {
    const all = Array.from({ length: 250 }, (_, i) =>
      issue({ key: `P-${i + 1}`, status: "完了", updated: ago(1) }),
    );
    const r = await run("weekly", {}, listing(all));
    expect(r.json.analysis.summary).toMatchObject({
      completed_count: 250,
      total_active_count: 250,
    });
    expect(r.calls).toHaveLength(1 + 3);
  });

  it("課題一覧の取得失敗は warning(issues_fetch_failed)にして空のダイジェストを返す。プロジェクトが取れなければツールエラー", async () => {
    const err = (status: number) =>
      new Response(JSON.stringify({ errors: [{ message: "x", code: 1 }] }), { status });
    const r = await run("daily", {}, { "GET /issues": err(500) });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.warnings[0]).toMatchObject({
      code: "issues_fetch_failed",
      component: "periodic_digest",
    });
    expect(r.json.analysis.summary.total_active_count).toBe(0);

    const nf = await run("daily", {}, { "GET /projects/P": err(404) });
    expect(nf.isError).toBe(true);
    expect(nf.json.error.code).toBe("not_found");
  });

  it("入力: 不正な日付と since > until は argument_error(Backlog を呼ばない)", async () => {
    for (const args of [
      { since: "2026/10/01" },
      { until: "2026-02-30" },
      { since: "2026-10-28", until: "2026-10-27" },
    ]) {
      const r = await run("weekly", args, {});
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.json.error.code).toBe("argument_error");
      expect(r.calls).toEqual([]);
    }
  });

  describe("API 呼び出し数(最悪ケース = 1 + 10)", () => {
    it("maxApiCalls は 11(daily / weekly とも)", () => {
      expect(digestDaily.maxApiCalls).toBe(11);
      expect(digestWeekly.maxApiCalls).toBe(11);
    });
    it("課題が上限まで続いても 11 回で止まり、truncated と警告が出る", async () => {
      const r = await run(
        "weekly",
        {},
        { "GET /issues": endless((n) => issue({ key: `P-${n}`, updated: ago(1) })) },
      );
      expect(r.calls).toHaveLength(11);
      expect(r.json.analysis.truncated).toBe(true);
      expect(r.json.warnings.map((w: { code: string }) => w.code)).toEqual(["issues_truncated"]);
    });
  });
});
