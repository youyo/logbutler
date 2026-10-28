import { describe, expect, it } from "vitest";
import { issueTriageMaterials } from "../../src/mcp/tools/analysis";
import {
  ago,
  commentsDesc,
  endless,
  endlessComments,
  issue,
  NOW,
  paged,
  USER_A,
  USER_B,
} from "../helpers/analysis-fixtures";
import { callTool } from "../helpers/tool-call";

const run = (args: Record<string, unknown>, respond: Parameters<typeof callTool>[2]) =>
  callTool("logbutler_issue_triage_materials", { issue_key: "P-1", ...args }, respond, {
    now: NOW,
    timezone: "Asia/Tokyo",
  });

const cat = (id: number) => [{ id, name: `cat${id}` }];
const target = issue({
  key: "P-1",
  status: "未対応",
  priority: "高",
  assignee: USER_A,
  created: ago(40),
  updated: ago(10),
  dueDate: "2026-10-20T00:00:00Z",
  category: cat(7),
  milestone: [{ id: 8, name: "v1" }],
  issueType: { id: 5, name: "バグ" },
  createdUser: USER_B,
});
const ok = (
  projectIssues: unknown[] = [],
  over: Parameters<typeof callTool>[2] = {},
): Parameters<typeof callTool>[2] => ({
  "GET /issues/P-1": target,
  "GET /projects/P": { id: 10 },
  "GET /issues": paged(projectIssues),
  "GET /issues/P-1/comments": commentsDesc(4),
  "GET /issues/P-1/relatedIssues": [],
  ...over,
});

describe("issue_triage_materials", () => {
  it("API は GetIssue → GetProject → 課題一覧(ページング)→ コメント → 関連課題の順に直列", async () => {
    const r = await run({}, ok([target]));
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toEqual([
      "GET /issues/P-1",
      "GET /projects/P",
      "GET /issues?count=100&projectId[]=10",
      "GET /issues/P-1/comments?count=100",
      "GET /issues/P-1/relatedIssues",
    ]);
    expect(r.json.resource).toBe("issue_triage_materials");
    expect(Object.keys(r.json.analysis)).toEqual([
      "issue",
      "history",
      "project_stats",
      "similar_issues",
      "related_issues",
      "truncated",
    ]);
  });

  it("issue と history", async () => {
    const r = await run({}, ok([target]));
    expect(r.json.analysis.issue).toEqual({
      issue_key: "P-1",
      summary: "summary P-1",
      status: { id: 1, name: "未対応" },
      priority: { id: 3, name: "高" },
      issue_type: { id: 5, name: "バグ" },
      assignee: { id: 1, name: "Alice" },
      reporter: { id: 2, name: "Bob" },
      categories: [{ id: 7, name: "cat7" }],
      milestones: [{ id: 8, name: "v1" }],
      due_date: "2026-10-20T00:00:00Z",
      created: ago(40),
      updated: ago(10),
    });
    expect(r.json.analysis.history).toEqual({
      comment_count: 4,
      days_since_created: 40,
      days_since_updated: 10,
      is_overdue: true,
      is_stale: true,
    });
  });

  it("project_stats: by_status / by_priority / by_assignee(担当なしは「未割当」)/ 全件数。avg_close_days は完了集合の (updated - created) の平均(日)", async () => {
    const r = await run(
      {},
      ok([
        issue({ key: "P-1", status: "未対応", priority: "高", assignee: USER_A }),
        issue({
          key: "P-2",
          status: "Closed",
          priority: "中",
          assignee: USER_A,
          created: ago(30),
          updated: ago(20),
        }),
        issue({
          key: "P-3",
          status: "完了",
          priority: "中",
          assignee: USER_B,
          created: ago(40),
          updated: ago(20),
        }),
        issue({ key: "P-4", status: "処理中", priority: null, assignee: null }),
        issue({ key: "P-5", status: "完了", created: ago(5), updated: ago(10) }), // 負の日数は平均に入れない
        issue({ key: "P-6", status: null }),
      ]),
    );
    expect(r.json.analysis.project_stats).toEqual({
      total_issues: 6,
      by_status: { 未対応: 1, Closed: 1, 完了: 2, 処理中: 1 },
      by_priority: { 高: 1, 中: 4 },
      by_assignee: { Alice: 2, Bob: 1, 未割当: 3 },
      avg_close_days: 15,
    });
  });

  it("closed が 1 件もなければ avg_close_days は 0", async () => {
    const r = await run({}, ok([issue({ key: "P-2", status: "未対応" })]));
    expect(r.json.analysis.project_stats.avg_close_days).toBe(0);
  });

  it("similar_issues: 対象自身を除き、同カテゴリ・同マイルストーンの件数と、同カテゴリの優先度 / 担当者の分布", async () => {
    const r = await run(
      {},
      ok([
        target,
        issue({ key: "P-2", category: cat(7), priority: "高", assignee: USER_A }),
        issue({
          key: "P-3",
          category: [...cat(7), ...cat(9)],
          priority: "中",
          assignee: USER_B,
          milestone: [{ id: 8, name: "v1" }],
        }),
        issue({ key: "P-4", category: cat(9), priority: "高", milestone: [{ id: 8, name: "v1" }] }),
        issue({ key: "P-5", category: cat(9) }),
        issue({ key: "P-6", category: cat(7), priority: null, assignee: null }),
      ]),
    );
    expect(r.json.analysis.similar_issues).toEqual({
      same_category_count: 3,
      same_milestone_count: 2,
      priority_distribution: { 高: 1, 中: 1 },
      assignee_distribution: { Alice: 1, Bob: 1 },
    });
  });

  it("20 件より多い課題がある場合も全件で統計を取る(再現: logvalet は 20 件で打ち切り)", async () => {
    const all = Array.from({ length: 230 }, (_, i) =>
      issue({ key: `P-${i + 10}`, status: "未対応" }),
    );
    const r = await run({}, ok(all));
    expect(r.json.analysis.project_stats.total_issues).toBe(230);
    expect(r.json.analysis.truncated).toBe(false);
  });

  it("コメント件数も 100 件を超えてページングで数える", async () => {
    const r = await run({}, ok([], { "GET /issues/P-1/comments": commentsDesc(130) }));
    expect(r.json.analysis.history.comment_count).toBe(130);
  });

  it("include_related_issues=false なら関連課題を呼ばず空にする。関連課題は軽量参照にする", async () => {
    const off = await run({ include_related_issues: false }, ok());
    expect(off.calls.some((c) => c.includes("relatedIssues"))).toBe(false);
    expect(off.json.analysis.related_issues).toEqual([]);

    const on = await run(
      {},
      ok([], {
        "GET /issues/P-1/relatedIssues": [
          { ...issue({ key: "P-9", assignee: USER_B }), type: "RELATES" },
        ],
      }),
    );
    expect(on.json.analysis.related_issues[0]).toMatchObject({
      issue_key: "P-9",
      type: "RELATES",
      assignee: { id: 2, name: "Bob" },
    });
  });

  it("プロジェクト / コメントの取得失敗は warning(component は project_stats / history.comment_count)にして部分結果を返す", async () => {
    const err = (status: number) =>
      new Response(JSON.stringify({ errors: [{ message: "x", code: 1 }] }), { status });
    const r = await run(
      {},
      ok([], { "GET /projects/P": err(404), "GET /issues/P-1/comments": err(500) }),
    );
    expect(r.isError, r.text).toBe(false);
    expect(
      r.json.warnings.map((w: { code: string; component: string }) => [w.code, w.component]),
    ).toEqual([
      ["project_fetch_failed", "project_stats"],
      ["comments_fetch_failed", "history.comment_count"],
    ]);
    expect(r.json.analysis.project_stats).toEqual({
      total_issues: 0,
      by_status: {},
      by_priority: {},
      by_assignee: {},
      avg_close_days: 0,
    });
    expect(r.json.analysis.similar_issues).toEqual({
      same_category_count: 0,
      same_milestone_count: 0,
      priority_distribution: {},
      assignee_distribution: {},
    });
    expect(r.json.analysis.history.comment_count).toBe(0);
  });

  describe("API 呼び出し数(最悪ケース = 1 + (1 + 10) + 10 + 1)", () => {
    it("maxApiCalls は 23", () => {
      expect(issueTriageMaterials.maxApiCalls).toBe(23);
    });
    it("課題一覧もコメントも上限まで続いても 23 回で止まり、truncated と警告が出る", async () => {
      const r = await run(
        {},
        ok([], {
          "GET /issues": endless((n) => issue({ key: `P-${n + 100}` })),
          "GET /issues/P-1/comments": endlessComments(),
        }),
      );
      expect(r.isError, r.text).toBe(false);
      expect(r.calls).toHaveLength(23);
      expect(r.json.analysis.truncated).toBe(true);
      expect(r.json.warnings.map((w: { code: string }) => w.code)).toEqual([
        "issues_truncated",
        "comments_truncated",
      ]);
    });
  });
});
