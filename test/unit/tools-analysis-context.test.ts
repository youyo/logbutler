import { describe, expect, it } from "vitest";
import { issueContext } from "../../src/mcp/tools/analysis";
import {
  ago,
  commentsDesc,
  endlessComments,
  issue,
  NOW,
  USER_A,
  USER_B,
} from "../helpers/analysis-fixtures";
import { callTool } from "../helpers/tool-call";

const run = (args: Record<string, unknown>, respond: Parameters<typeof callTool>[2]) =>
  callTool("logbutler_issue_context", { issue_key: "P-1", ...args }, respond, {
    now: NOW,
    timezone: "Asia/Tokyo",
  });

const target = issue({
  key: "P-1",
  status: "処理中",
  statusId: 2,
  priority: "高",
  assignee: USER_A,
  updated: ago(3),
  created: ago(40),
  dueDate: "2026-10-30T00:00:00Z",
  startDate: "2026-10-01T00:00:00Z",
  description: "本文",
  issueType: { id: 5, name: "バグ", color: "#fff" },
  createdUser: USER_B,
  category: [{ id: 7, name: "案件A", displayOrder: 0 }],
  milestone: [{ id: 8, name: "v1", description: "x" }],
});
const statuses = [
  { id: 1, projectId: 10, name: "未対応", color: "#ed8077", displayOrder: 1000 },
  { id: 2, projectId: 10, name: "処理中", color: "#4488c5", displayOrder: 2000 },
];
const ok = (over: Parameters<typeof callTool>[2] = {}): Parameters<typeof callTool>[2] => ({
  "GET /issues/P-1": target,
  "GET /issues/P-1/comments": commentsDesc(3),
  "GET /projects/P/statuses": statuses,
  "GET /issues/P-1/relatedIssues": [],
  ...over,
});

describe("issue_context", () => {
  it("構成: issue / meta / recent_comments / signals / llm_hints / related_issues。API は GetIssue → コメント → ステータス → 関連課題の順に直列", async () => {
    const r = await run({}, ok());
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toEqual([
      "GET /issues/P-1",
      "GET /issues/P-1/comments?count=100",
      "GET /projects/P/statuses",
      "GET /issues/P-1/relatedIssues",
    ]);
    expect(r.json.resource).toBe("issue_context");
    expect(Object.keys(r.json.analysis)).toEqual([
      "issue",
      "meta",
      "recent_comments",
      "signals",
      "truncated",
      "llm_hints",
      "related_issues",
    ]);
  });

  it("issue: Backlog の生データを snake_case のスナップショットにする(id と name だけ残す)", async () => {
    const r = await run({}, ok());
    expect(r.json.analysis.issue).toEqual({
      issue_key: "P-1",
      summary: "summary P-1",
      description: "本文",
      status: { id: 2, name: "処理中" },
      priority: { id: 3, name: "高" },
      issue_type: { id: 5, name: "バグ" },
      assignee: { id: 1, name: "Alice" },
      reporter: { id: 2, name: "Bob" },
      categories: [{ id: 7, name: "案件A" }],
      milestones: [{ id: 8, name: "v1" }],
      due_date: "2026-10-30T00:00:00Z",
      start_date: "2026-10-01T00:00:00Z",
      created: ago(40),
      updated: ago(3),
    });
    expect(r.json.analysis.meta.statuses).toEqual(statuses);
  });

  it("recent_comments は新しい順の先頭 N 件(既定 10)。comment_count は全件を数えた数", async () => {
    const r = await run({}, ok({ "GET /issues/P-1/comments": commentsDesc(25) }));
    expect(r.json.analysis.recent_comments).toHaveLength(10);
    expect(r.json.analysis.recent_comments[0]).toEqual({
      id: 25,
      content: "comment 25",
      author: { id: 1, name: "Alice" },
      created: ago(1),
    });
    expect(r.json.analysis.recent_comments[9].id).toBe(16);
    expect(r.json.analysis.signals.comment_count).toBe(25);

    const three = await run({ comments: 3 }, ok({ "GET /issues/P-1/comments": commentsDesc(25) }));
    expect(three.json.analysis.recent_comments.map((c: { id: number }) => c.id)).toEqual([
      25, 24, 23,
    ]);
    const zero = await run({ comments: 0 }, ok({ "GET /issues/P-1/comments": commentsDesc(25) }));
    expect(zero.json.analysis.recent_comments).toHaveLength(10);
  });

  it("comment_count はページングで正確に数える(maxId のカーソル。100 件を超えても止まらない)", async () => {
    const r = await run({}, ok({ "GET /issues/P-1/comments": commentsDesc(250) }));
    expect(r.json.analysis.signals.comment_count).toBe(250);
    expect(r.json.analysis.truncated).toBe(false);
    expect(r.calls.filter((c) => c.includes("/comments"))).toEqual([
      "GET /issues/P-1/comments?count=100",
      "GET /issues/P-1/comments?count=100&maxId=150",
      "GET /issues/P-1/comments?count=100&maxId=50",
    ]);
  });

  it("compact: description を出さず、コメント本文は空文字にする", async () => {
    const r = await run({ compact: true }, ok());
    expect(Object.keys(r.json.analysis.issue)).not.toContain("description");
    expect(r.json.analysis.recent_comments[0]).toMatchObject({ id: 3, content: "" });
  });

  it("signals: is_overdue(期限 < now)/ days_since_update / is_stale(7 日以上)/ has_assignee", async () => {
    const at = async (over: Record<string, unknown>) =>
      (await run({}, ok({ "GET /issues/P-1": { ...target, ...over } }))).json.analysis;
    expect((await at({ updated: ago(7) })).signals).toMatchObject({
      days_since_update: 7,
      is_stale: true,
    });
    expect((await at({ updated: ago(6, 23) })).signals).toMatchObject({
      days_since_update: 6,
      is_stale: false,
    });
    expect((await at({ dueDate: "2026-10-27T00:00:00Z" })).signals.is_overdue).toBe(true);
    expect((await at({ dueDate: "2026-10-29T00:00:00Z" })).signals.is_overdue).toBe(false);
    expect((await at({ assignee: null })).signals.has_assignee).toBe(false);
    const stale = await at({ updated: ago(10), assignee: null, dueDate: "2026-10-01T00:00:00Z" });
    expect(stale.llm_hints).toEqual({
      primary_entities: ["issue:P-1"],
      open_questions: [
        "期限超過 — 対応状況を確認してください",
        "10日間更新なし — 停滞の原因を確認してください",
      ],
      suggested_next_actions: ["担当者を設定してください"],
    });
  });

  it("関連課題: フラット / ネストの両形状を {issue_key, summary, status, priority, issue_type, assignee, type, created, updated} にする", async () => {
    const flat = {
      ...issue({ key: "P-2", status: "未対応", assignee: USER_B }),
      issueType: { id: 5, name: "バグ" },
      type: "RELATES",
    };
    const nested = { relatedIssue: issue({ key: "P-3", status: "完了" }), type: "PRECEDES" };
    const r = await run({}, ok({ "GET /issues/P-1/relatedIssues": [flat, nested] }));
    const [a, b] = r.json.analysis.related_issues;
    expect(a).toEqual({
      issue_key: "P-2",
      summary: "summary P-2",
      status: { id: 1, name: "未対応" },
      priority: { id: 3, name: "中" },
      issue_type: { id: 5, name: "バグ" },
      assignee: { id: 2, name: "Bob" },
      type: "RELATES",
      created: ago(30),
      updated: ago(1),
    });
    expect(b).toMatchObject({
      issue_key: "P-3",
      type: "PRECEDES",
      status: { id: 1, name: "完了" },
    });
  });

  it("include_related_issues=false なら関連課題を呼ばない", async () => {
    const r = await run({ include_related_issues: false }, ok());
    expect(r.calls.some((c) => c.includes("relatedIssues"))).toBe(false);
    expect(r.json.analysis.related_issues).toEqual([]);
  });

  it("コメント・ステータス・関連課題の取得失敗は warning にして部分結果を返す", async () => {
    const err = (status: number) =>
      new Response(JSON.stringify({ errors: [{ message: "x", code: 1 }] }), { status });
    const r = await run(
      {},
      ok({
        "GET /issues/P-1/comments": err(500),
        "GET /projects/P/statuses": err(404),
        "GET /issues/P-1/relatedIssues": err(500),
      }),
    );
    expect(r.isError, r.text).toBe(false);
    expect(
      r.json.warnings.map((w: { code: string; component: string }) => [w.code, w.component]),
    ).toEqual([
      ["comments_fetch_failed", "recent_comments"],
      ["statuses_fetch_failed", "meta.statuses"],
      ["related_issues_fetch_failed", "related_issues"],
    ]);
    expect(r.json.analysis.recent_comments).toEqual([]);
    expect(r.json.analysis.meta.statuses).toEqual([]);
    expect(r.json.analysis.related_issues).toEqual([]);
  });

  it("課題が取れなければツールエラー(not_found)", async () => {
    const r = await run(
      {},
      {
        "GET /issues/P-1": new Response(
          JSON.stringify({ errors: [{ message: "No such issue.", code: 6 }] }),
          { status: 404 },
        ),
      },
    );
    expect(r.isError).toBe(true);
    expect(r.json.error.code).toBe("not_found");
  });

  describe("API 呼び出し数(最悪ケース = 1 + 10 + 1 + 1)", () => {
    it("maxApiCalls は 13", () => {
      expect(issueContext.maxApiCalls).toBe(13);
    });
    it("コメントが上限(1,000 件)まで続いても 13 回で止まり、comment_count は下限として truncated と警告を出す", async () => {
      const r = await run({}, ok({ "GET /issues/P-1/comments": endlessComments() }));
      expect(r.calls).toHaveLength(13);
      expect(r.json.analysis.signals.comment_count).toBe(1000);
      expect(r.json.analysis.truncated).toBe(true);
      expect(r.json.warnings).toEqual([
        {
          code: "comments_truncated",
          message:
            "Fetched only the latest 1000 comments of P-1 (page limit reached). comment_count is a lower bound.",
          component: "recent_comments",
          retryable: false,
        },
      ]);
    });
  });
});
