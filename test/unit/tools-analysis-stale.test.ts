import { describe, expect, it } from "vitest";
import { issueStale } from "../../src/mcp/tools/analysis";
import { ago, endless, issue, NOW, paged, USER_A } from "../helpers/analysis-fixtures";
import { callTool } from "../helpers/tool-call";

const TOOL = "logbutler_issue_stale";
const run = (args: Record<string, unknown>, respond: Parameters<typeof callTool>[2]) =>
  callTool(TOOL, args, respond, { now: NOW, timezone: "Asia/Tokyo" });

const project = (id = 10) => ({ id, projectKey: "P" });
const listing = (issues: unknown[]) => ({
  "GET /projects/P": project(),
  "GET /issues": paged(issues),
});

describe("issue_stale", () => {
  it("閾値の境界: days=7 で ちょうど 7 日前は含め、6 日 23 時間は含めない。days_since_update の降順", async () => {
    const r = await run(
      { project_keys: "P", days: 7 },
      listing([
        issue({ key: "P-1", updated: ago(7) }),
        issue({ key: "P-2", updated: ago(6, 23) }),
        issue({ key: "P-3", updated: ago(30) }),
      ]),
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.json.analysis.issues.map((i: { issue_key: string }) => i.issue_key)).toEqual([
      "P-3",
      "P-1",
    ]);
    expect(
      r.json.analysis.issues.map((i: { days_since_update: number }) => i.days_since_update),
    ).toEqual([30, 7]);
    expect(r.json.analysis).toMatchObject({ total_count: 2, threshold_days: 7 });
  });

  it("days 未指定・0 以下は 7 日", async () => {
    const issues = [issue({ key: "P-1", updated: ago(7) }), issue({ key: "P-2", updated: ago(6) })];
    for (const days of [undefined, 0, -3]) {
      const r = await run(
        { project_keys: "P", ...(days === undefined ? {} : { days }) },
        listing(issues),
      );
      expect(r.json.analysis.threshold_days).toBe(7);
      expect(r.json.analysis.total_count).toBe(1);
    }
  });

  it("updated のない課題は除外する", async () => {
    const r = await run(
      { project_keys: "P" },
      listing([issue({ key: "P-1", updated: null }), issue({ key: "P-2", updated: ago(10) })]),
    );
    expect(r.json.analysis.issues.map((i: { issue_key: string }) => i.issue_key)).toEqual(["P-2"]);
  });

  it("完了集合 {完了, 対応済み, Closed, Done, Resolved} は既定で除外(logvalet は「完了」しか除外しなかった)", async () => {
    const statuses = ["完了", "対応済み", "Closed", "Done", "Resolved", "処理中", "未対応"];
    const r = await run(
      { project_keys: "P" },
      listing(statuses.map((s, i) => issue({ key: `P-${i + 1}`, status: s, updated: ago(20) }))),
    );
    expect(r.json.analysis.issues.map((i: { status: string }) => i.status).sort()).toEqual(
      ["処理中", "未対応"].sort(),
    );
  });

  it("exclude_status を指定したらそれを優先し、既定の完了集合は足さない", async () => {
    const r = await run(
      { project_keys: "P", exclude_status: "処理中, 保留" },
      listing([
        issue({ key: "P-1", status: "処理中", updated: ago(20) }),
        issue({ key: "P-2", status: "Closed", updated: ago(20) }),
        issue({ key: "P-3", status: "保留", updated: ago(20) }),
      ]),
    );
    expect(r.json.analysis.issues.map((i: { issue_key: string }) => i.issue_key)).toEqual(["P-2"]);
  });

  it("status のない課題は除外されない", async () => {
    const r = await run(
      { project_keys: "P" },
      listing([issue({ key: "P-1", status: null, updated: ago(20) })]),
    );
    expect(r.json.analysis.issues[0]).toMatchObject({ issue_key: "P-1", status: "" });
  });

  it("同順位(同じ日数)は issue_key 昇順で安定させる", async () => {
    const r = await run(
      { project_keys: "P" },
      listing([
        issue({ key: "P-3", updated: ago(10) }),
        issue({ key: "P-1", updated: ago(10) }),
        issue({ key: "P-2", updated: ago(10) }),
      ]),
    );
    expect(r.json.analysis.issues.map((i: { issue_key: string }) => i.issue_key)).toEqual([
      "P-1",
      "P-2",
      "P-3",
    ]);
  });

  it("項目: assignee は {id,name}、last_updated / due_date は元の文字列、is_overdue は due_date < now。assignee と due_date がなければキーを出さない", async () => {
    const r = await run(
      { project_keys: "P" },
      listing([
        issue({
          key: "P-1",
          status: "処理中",
          assignee: USER_A,
          updated: ago(10),
          dueDate: "2026-10-20T00:00:00Z",
        }),
        issue({ key: "P-2", updated: ago(9), dueDate: "2026-11-20T00:00:00Z" }),
        issue({ key: "P-3", updated: ago(8) }),
      ]),
    );
    const [a, b, c] = r.json.analysis.issues;
    expect(a).toEqual({
      issue_key: "P-1",
      summary: "summary P-1",
      status: "処理中",
      assignee: { id: 1, name: "Alice" },
      days_since_update: 10,
      last_updated: ago(10),
      due_date: "2026-10-20T00:00:00Z",
      is_overdue: true,
    });
    expect(b.is_overdue).toBe(false);
    expect(Object.keys(c)).not.toContain("assignee");
    expect(Object.keys(c)).not.toContain("due_date");
    expect(c.is_overdue).toBe(false);
  });

  it("エンベロープ: resource / generated_at(ctx.now) / llm_hints / warnings", async () => {
    const r = await run(
      { project_keys: "P" },
      listing([
        issue({ key: "P-1", updated: ago(10), dueDate: "2026-10-01T00:00:00Z" }),
        issue({ key: "P-2", updated: ago(9) }),
      ]),
    );
    expect(r.json).toMatchObject({
      schema_version: "1",
      resource: "stale_issues",
      generated_at: NOW.toISOString(),
      space: "example",
      base_url: "https://example.backlog.com",
      warnings: [],
    });
    expect(r.json.analysis.truncated).toBe(false);
    expect(r.json.analysis.llm_hints).toEqual({
      primary_entities: ["project:P"],
      open_questions: [
        "2件の停滞課題があります。対応状況を確認してください",
        "1件の停滞課題が期限超過しています",
      ],
      suggested_next_actions: [],
    });
  });

  it("20 件より多い課題がある場合も全件を分析する(再現: logvalet は 20 件で打ち切り)", async () => {
    const all = Array.from({ length: 250 }, (_, i) =>
      issue({ key: `P-${i + 1}`, updated: ago(10) }),
    );
    const r = await run({ project_keys: "P" }, listing(all));
    expect(r.json.analysis.total_count).toBe(250);
    expect(r.calls).toEqual([
      "GET /projects/P",
      "GET /issues?count=100&order=asc&projectId[]=10&sort=updated",
      "GET /issues?count=100&offset=100&order=asc&projectId[]=10&sort=updated",
      "GET /issues?count=100&offset=200&order=asc&projectId[]=10&sort=updated",
    ]);
    expect(r.json.analysis.truncated).toBe(false);
  });

  it("複数プロジェクトは直列に取り、結果をまとめて並べる。1 つの取得失敗は warning にして残りを返す", async () => {
    const r = await run(
      { project_keys: "P,Q,P" },
      {
        "GET /projects/P": project(10),
        "GET /projects/Q": new Response(
          JSON.stringify({ errors: [{ message: "No such project.", code: 6 }] }),
          { status: 404 },
        ),
        "GET /issues": paged([issue({ key: "P-1", updated: ago(10) })]),
      },
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toEqual([
      "GET /projects/P",
      "GET /issues?count=100&order=asc&projectId[]=10&sort=updated",
      "GET /projects/Q",
    ]);
    expect(r.json.analysis.total_count).toBe(1);
    expect(r.json.warnings).toHaveLength(1);
    expect(r.json.warnings[0]).toMatchObject({
      code: "project_fetch_failed",
      component: "project",
    });
    expect(r.json.analysis.llm_hints.primary_entities).toEqual(["project:P", "project:Q"]);
  });

  it("入力: project_keys が空・6 個以上は argument_error(Backlog を呼ばない)", async () => {
    for (const keys of ["", " , ", "A,B,C,D,E,F"]) {
      const r = await run({ project_keys: keys }, {});
      expect(r.isError).toBe(true);
      expect(r.json.error.code).toBe("argument_error");
      expect(r.calls).toEqual([]);
    }
  });

  describe("API 呼び出し数(最悪ケース = プロジェクト数 × (1 + 10 ページ))", () => {
    it("maxApiCalls は 5 × 11 = 55", () => {
      expect(issueStale.maxApiCalls).toBe(55);
    });

    it("5 プロジェクトすべてが上限(1,000 件)まで続いても 55 回ちょうどで終わり、truncated と警告が出る", async () => {
      const respond: Parameters<typeof callTool>[2] = {
        "GET /issues": endless((n) => issue({ key: `P-${n}`, updated: ago(10) })),
      };
      for (const k of ["A", "B", "C", "D", "E"]) respond[`GET /projects/${k}`] = project();
      const r = await run({ project_keys: "A,B,C,D,E" }, respond);
      expect(r.isError, r.text).toBe(false);
      expect(r.calls).toHaveLength(55);
      expect(r.json.analysis.truncated).toBe(true);
      expect(
        r.json.warnings.filter((w: { code: string }) => w.code === "issues_truncated"),
      ).toHaveLength(5);
      expect(r.json.analysis.total_count).toBe(5000);
    });
  });
});
