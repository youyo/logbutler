import { describe, expect, it } from "vitest";
import { userWorkload } from "../../src/mcp/tools/analysis";
import { ago, endless, issue, NOW, paged, USER_A, USER_B } from "../helpers/analysis-fixtures";
import { callTool } from "../helpers/tool-call";

const run = (args: Record<string, unknown>, respond: Parameters<typeof callTool>[2]) =>
  callTool("logbutler_user_workload", args, respond, { now: NOW, timezone: "Asia/Tokyo" });
const list = (issues: unknown[]) => ({
  "GET /projects/P": { id: 10 },
  "GET /issues": paged(issues),
});
const many = (n: number, user = USER_A, from = 1) =>
  Array.from({ length: n }, (_, i) => issue({ key: `P-${from + i}`, assignee: user }));

describe("user_workload", () => {
  it("load_level の境界: 4 low / 5 medium / 9 medium / 10 high / 19 high / 20 overloaded", async () => {
    const levels: Record<number, string> = {
      4: "low",
      5: "medium",
      9: "medium",
      10: "high",
      19: "high",
      20: "overloaded",
    };
    for (const [n, level] of Object.entries(levels)) {
      const r = await run({ project_key: "P" }, list(many(Number(n))));
      expect(r.json.analysis.members[0], `${n} 件`).toMatchObject({
        total: Number(n),
        load_level: level,
      });
    }
  });

  it("メンバー別に by_status / by_priority / overdue / stale を数える。未割当は members に入れず unassigned_count に数える", async () => {
    const r = await run(
      { project_key: "P" },
      list([
        issue({
          key: "P-1",
          assignee: USER_B,
          status: "処理中",
          priority: "高",
          updated: ago(10),
          dueDate: "2026-10-01T00:00:00Z",
        }),
        issue({ key: "P-2", assignee: USER_B, status: "未対応", priority: "高", updated: ago(7) }),
        issue({ key: "P-3", assignee: USER_B, status: "未対応", priority: "中", updated: ago(6) }),
        issue({ key: "P-4", assignee: USER_B, status: null, priority: null, updated: null }),
        issue({ key: "P-5", assignee: USER_A }),
        issue({ key: "P-6" }),
        issue({ key: "P-7" }),
      ]),
    );
    expect(r.json.analysis).toMatchObject({
      project_key: "P",
      total_issues: 7,
      unassigned_count: 2,
      stale_threshold_days: 7,
    });
    // user_id 昇順
    expect(r.json.analysis.members.map((m: { user_id: number }) => m.user_id)).toEqual([1, 2]);
    expect(r.json.analysis.members[1]).toEqual({
      user_id: 2,
      name: "Bob",
      total: 4,
      by_status: { 処理中: 1, 未対応: 2 },
      by_priority: { 高: 2, 中: 1 },
      overdue: 1,
      stale: 2,
      load_level: "low",
    });
  });

  it("days で stale の閾値を変える(echo は stale_threshold_days)", async () => {
    const r = await run(
      { project_key: "P", days: 3 },
      list([issue({ key: "P-1", assignee: USER_A, updated: ago(4) })]),
    );
    expect(r.json.analysis.stale_threshold_days).toBe(3);
    expect(r.json.analysis.members[0].stale).toBe(1);
  });

  it("完了集合は数えない(total_issues にも入れない)。exclude_status を指定したらそれを優先", async () => {
    const issues = [
      issue({ key: "P-1", assignee: USER_A, status: "Closed" }),
      issue({ key: "P-2", assignee: USER_A, status: "Done" }),
      issue({ key: "P-3", assignee: USER_A, status: "保留" }),
      issue({ key: "P-4", assignee: USER_A, status: "未対応" }),
    ];
    const def = await run({ project_key: "P" }, list(issues));
    expect(def.json.analysis.total_issues).toBe(2);
    const custom = await run({ project_key: "P", exclude_status: "保留" }, list(issues));
    expect(custom.json.analysis.total_issues).toBe(3);
  });

  it("20 件より多い課題がある場合も全件を数える(再現: logvalet は 20 件で打ち切り)", async () => {
    const r = await run({ project_key: "P" }, list(many(230)));
    expect(r.json.analysis.members[0].total).toBe(230);
    expect(r.json.analysis.members[0].load_level).toBe("overloaded");
    expect(r.calls).toHaveLength(1 + 3);
  });

  it("llm_hints: overloaded と high の人数", async () => {
    const r = await run(
      { project_key: "P" },
      list([...many(20, USER_A), ...many(10, USER_B, 100)]),
    );
    expect(r.json.analysis.llm_hints).toEqual({
      primary_entities: ["project:P"],
      open_questions: [
        "1人のメンバーがoverloadedです。タスクの再配分を検討してください",
        "1人のメンバーが高負荷（high）です",
      ],
      suggested_next_actions: [],
    });
  });

  it("プロジェクト取得の失敗は warning にして、空の結果を返す", async () => {
    const r = await run(
      { project_key: "P" },
      {
        "GET /projects/P": new Response(
          JSON.stringify({ errors: [{ message: "No such project.", code: 6 }] }),
          { status: 404 },
        ),
      },
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.json.warnings[0]).toMatchObject({ code: "project_fetch_failed" });
    expect(r.json.analysis).toMatchObject({
      project_key: "P",
      total_issues: 0,
      unassigned_count: 0,
      members: [],
      truncated: false,
    });
  });

  it("入力: project_key が空は argument_error", async () => {
    const r = await run({ project_key: " " }, {});
    expect(r.json.error.code).toBe("argument_error");
  });

  it("resource は user_workload", async () => {
    const r = await run({ project_key: "P" }, list([]));
    expect(r.json.resource).toBe("user_workload");
  });

  describe("API 呼び出し数(最悪ケース = 1 + 10)", () => {
    it("maxApiCalls は 11", () => {
      expect(userWorkload.maxApiCalls).toBe(11);
    });
    it("課題が上限まで続いても 11 回で止まり、truncated と警告が出る", async () => {
      const r = await run(
        { project_key: "P" },
        {
          "GET /projects/P": { id: 10 },
          "GET /issues": endless((n) => issue({ key: `P-${n}`, assignee: USER_A })),
        },
      );
      expect(r.calls).toHaveLength(11);
      expect(r.json.analysis.truncated).toBe(true);
      expect(r.json.analysis.total_issues).toBe(1000);
      expect(r.json.warnings.map((w: { code: string }) => w.code)).toEqual(["issues_truncated"]);
    });
  });
});
