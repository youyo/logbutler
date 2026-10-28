import { describe, expect, it } from "vitest";
import { projectBlockers } from "../../src/mcp/tools/analysis";
import { ago, endless, issue, NOW, paged, USER_A } from "../helpers/analysis-fixtures";
import { callTool } from "../helpers/tool-call";

const TOOL = "logbutler_project_blockers";
const run = (args: Record<string, unknown>, respond: Parameters<typeof callTool>[2]) =>
  callTool(
    TOOL,
    args,
    { "GET /projects/P": { id: 10 }, ...respond },
    { now: NOW, timezone: "Asia/Tokyo" },
  );
const withIssues = (issues: unknown[], extra: Parameters<typeof callTool>[2] = {}) => ({
  "GET /issues": paged(issues),
  ...extra,
});
const keysOf = (r: { json: { analysis: { issues: { issue_key: string }[] } } }) =>
  r.json.analysis.issues.map((i) => i.issue_key);
const signalsOf = (
  r: { json: { analysis: { issues: { signals: { code: string }[] }[] } } },
  n = 0,
) => r.json.analysis.issues[n]?.signals.map((s) => s.code);

describe("project_blockers: シグナル", () => {
  it("high_priority_unassigned: 優先度「高」「最高」かつ担当なし。担当がいれば出ない", async () => {
    const r = await run(
      { project_keys: "P" },
      withIssues([
        issue({ key: "P-1", priority: "高" }),
        issue({ key: "P-2", priority: "最高" }),
        issue({ key: "P-3", priority: "高", assignee: USER_A }),
        issue({ key: "P-4", priority: "中" }),
      ]),
    );
    expect(keysOf(r)).toEqual(["P-1", "P-2"]);
    expect(r.json.analysis.issues[0].signals).toEqual([
      { code: "high_priority_unassigned", message: "優先度「高」で担当者未設定" },
    ]);
    expect(r.json.analysis.issues[1].signals[0].message).toBe("優先度「最高」で担当者未設定");
  });

  it("long_in_progress: 「処理中」のまま days(既定 14)日以上。境界は 14 日ちょうどを含み、13 日 23 時間は含まない", async () => {
    const r = await run(
      { project_keys: "P" },
      withIssues([
        issue({ key: "P-1", status: "処理中", assignee: USER_A, updated: ago(14) }),
        issue({ key: "P-2", status: "処理中", assignee: USER_A, updated: ago(13, 23) }),
        issue({ key: "P-3", status: "未対応", assignee: USER_A, updated: ago(40) }),
      ]),
    );
    expect(keysOf(r)).toEqual(["P-1"]);
    expect(r.json.analysis.issues[0].signals).toEqual([
      { code: "long_in_progress", message: "「処理中」のまま14日経過" },
    ]);
  });

  it("days を指定すると long_in_progress の閾値になる(0 以下は既定の 14)", async () => {
    const issues = [issue({ key: "P-1", status: "処理中", assignee: USER_A, updated: ago(5) })];
    expect(keysOf(await run({ project_keys: "P", days: 5 }, withIssues(issues)))).toEqual(["P-1"]);
    expect(keysOf(await run({ project_keys: "P", days: 6 }, withIssues(issues)))).toEqual([]);
    expect(keysOf(await run({ project_keys: "P", days: 0 }, withIssues(issues)))).toEqual([]);
  });

  it("overdue_open: 期限超過。message は超過日数(切り捨て)。期限が未来なら出ない", async () => {
    const r = await run(
      { project_keys: "P" },
      withIssues([
        issue({ key: "P-1", assignee: USER_A, dueDate: "2026-10-25T00:00:00Z" }), // 3 日 3 時間
        issue({ key: "P-2", assignee: USER_A, dueDate: "2026-10-29T00:00:00Z" }),
      ]),
    );
    expect(keysOf(r)).toEqual(["P-1"]);
    expect(r.json.analysis.issues[0].signals).toEqual([
      { code: "overdue_open", message: "期限を3日超過" },
    ]);
    expect(r.json.analysis.issues[0].due_date).toBe("2026-10-25T00:00:00Z");
  });

  it("severity: high_priority_unassigned か overdue_open があれば HIGH、long_in_progress だけなら MEDIUM", async () => {
    const r = await run(
      { project_keys: "P" },
      withIssues([
        issue({ key: "P-1", status: "処理中", assignee: USER_A, updated: ago(20) }),
        issue({ key: "P-2", priority: "高" }),
        issue({ key: "P-3", assignee: USER_A, dueDate: "2026-10-01T00:00:00Z" }),
        issue({
          key: "P-4",
          status: "処理中",
          assignee: USER_A,
          updated: ago(20),
          dueDate: "2026-10-01T00:00:00Z",
        }),
      ]),
    );
    const sev = Object.fromEntries(
      r.json.analysis.issues.map((i: { issue_key: string; severity: string }) => [
        i.issue_key,
        i.severity,
      ]),
    );
    expect(sev).toEqual({ "P-1": "MEDIUM", "P-2": "HIGH", "P-3": "HIGH", "P-4": "HIGH" });
    expect(signalsOf(r, 2)).toEqual(["long_in_progress", "overdue_open"]); // P-4(HIGH の 3 番目)
  });

  it("ソートは severity(HIGH → MEDIUM)、同じ severity は issue_key の昇順。by_severity は両方のキーを常に出す", async () => {
    const r = await run(
      { project_keys: "P" },
      withIssues([
        issue({ key: "P-9", status: "処理中", assignee: USER_A, updated: ago(20) }),
        issue({ key: "P-3", priority: "高" }),
        issue({ key: "P-2", priority: "高" }),
        issue({ key: "P-1", status: "処理中", assignee: USER_A, updated: ago(20) }),
      ]),
    );
    expect(keysOf(r)).toEqual(["P-2", "P-3", "P-1", "P-9"]);
    expect(r.json.analysis.by_severity).toEqual({ HIGH: 2, MEDIUM: 2 });
    expect(r.json.analysis.total_count).toBe(4);

    const none = await run({ project_keys: "P" }, withIssues([]));
    expect(none.json.analysis).toMatchObject({
      issues: [],
      total_count: 0,
      by_severity: { HIGH: 0, MEDIUM: 0 },
      truncated: false,
    });
  });

  it("項目: priority は空なら出さない。assignee は {id,name}。resource は project_blockers", async () => {
    const r = await run(
      { project_keys: "P" },
      withIssues([
        issue({ key: "P-1", priority: null, assignee: USER_A, dueDate: "2026-10-01T00:00:00Z" }),
        issue({ key: "P-2", priority: "高" }),
      ]),
    );
    expect(r.json.resource).toBe("project_blockers");
    const [p1, p2] = r.json.analysis.issues;
    // HIGH 同士なので P-1, P-2 の順
    expect(p1).toEqual({
      issue_key: "P-1",
      summary: "summary P-1",
      status: "未対応",
      assignee: { id: 1, name: "Alice" },
      due_date: "2026-10-01T00:00:00Z",
      signals: [{ code: "overdue_open", message: "期限を27日超過" }],
      severity: "HIGH",
    });
    expect(p2.priority).toBe("高");
    expect(Object.keys(p2)).not.toContain("assignee");
  });

  it("llm_hints: ブロッカー件数と HIGH 件数", async () => {
    const r = await run(
      { project_keys: "P" },
      withIssues([
        issue({ key: "P-1", priority: "高" }),
        issue({ key: "P-2", status: "処理中", assignee: USER_A, updated: ago(20) }),
      ]),
    );
    expect(r.json.analysis.llm_hints).toEqual({
      primary_entities: ["project:P"],
      open_questions: [
        "2件のブロッカー課題があります。対応を優先してください",
        "1件が HIGH severity です",
      ],
      suggested_next_actions: [],
    });
  });
});

describe("project_blockers: 完了集合・全件取得", () => {
  it("完了集合の課題は期限超過でもブロッカーにしない(Closed / Done / Resolved / 対応済み / 完了)", async () => {
    const statuses = ["完了", "対応済み", "Closed", "Done", "Resolved"];
    const r = await run(
      { project_keys: "P" },
      withIssues([
        ...statuses.map((s, i) =>
          issue({ key: `P-${i + 1}`, status: s, dueDate: "2026-10-01T00:00:00Z", priority: "高" }),
        ),
        issue({ key: "P-9", status: "未対応", dueDate: "2026-10-01T00:00:00Z" }),
      ]),
    );
    expect(keysOf(r)).toEqual(["P-9"]);
  });

  it("exclude_status を指定したらそれを優先する(既定の完了集合は足さない)", async () => {
    const r = await run(
      { project_keys: "P", exclude_status: "保留" },
      withIssues([
        issue({ key: "P-1", status: "保留", dueDate: "2026-10-01T00:00:00Z" }),
        issue({ key: "P-2", status: "Closed", dueDate: "2026-10-01T00:00:00Z" }),
      ]),
    );
    expect(keysOf(r)).toEqual(["P-2"]);
  });

  it("20 件より多い課題がある場合も全件を分析する(再現: logvalet は 20 件で打ち切り)", async () => {
    const all = Array.from({ length: 130 }, (_, i) => issue({ key: `P-${i + 1}`, priority: "高" }));
    const r = await run({ project_keys: "P" }, withIssues(all));
    expect(r.json.analysis.total_count).toBe(130);
    expect(r.calls).toEqual([
      "GET /projects/P",
      "GET /issues?count=100&projectId[]=10",
      "GET /issues?count=100&offset=100&projectId[]=10",
    ]);
  });
});

describe("project_blockers: include_comments(blocked_by_keyword)", () => {
  const commentsOf = (content: string) => [
    { id: 2, content, createdUser: USER_A, created: ago(1) },
    { id: 1, content: "古いコメント: 待ち", createdUser: USER_A, created: ago(5) },
  ];

  it("既定ではコメントを取りに行かない", async () => {
    const r = await run(
      { project_keys: "P" },
      withIssues([issue({ key: "P-1", assignee: USER_A })]),
    );
    expect(r.calls.some((c) => c.includes("/comments"))).toBe(false);
  });

  it("最新コメントだけを見る(count=1, order=desc)。キーワードは大文字小文字を区別せず、リストの順で最初の一致を使う", async () => {
    const r = await run(
      { project_keys: "P", include_comments: true },
      withIssues(
        [issue({ key: "P-1", assignee: USER_A }), issue({ key: "P-2", assignee: USER_A })],
        {
          "GET /issues/P-1/comments": commentsOf("This is BLOCKED by infra"),
          "GET /issues/P-2/comments": [
            { id: 9, content: "もう解消しました", createdUser: USER_A, created: ago(1) },
            { id: 8, content: "ブロックされている", createdUser: USER_A, created: ago(3) },
          ],
        },
      ),
    );
    expect(r.calls).toContain("GET /issues/P-1/comments?count=1&order=desc");
    expect(keysOf(r)).toEqual(["P-1"]);
    expect(r.json.analysis.issues[0]).toMatchObject({
      severity: "MEDIUM",
      signals: [{ code: "blocked_by_keyword", message: "コメントに阻害キーワード: 「blocked」" }],
    });
  });

  it("キーワードの表(ブロック / 待ち / blocked / pending / 依存 / 待機 / 対応待ち)", async () => {
    for (const [text, kw] of [
      ["ブロック中", "ブロック"],
      ["返信待ちです", "待ち"],
      ["Pending review", "pending"],
      ["他チームに依存", "依存"],
      ["待機中", "待機"],
    ] as const) {
      const r = await run(
        { project_keys: "P", include_comments: true },
        withIssues([issue({ key: "P-1", assignee: USER_A })], {
          "GET /issues/P-1/comments": commentsOf(text),
        }),
      );
      expect(r.json.analysis.issues[0].signals[0].message, text).toBe(
        `コメントに阻害キーワード: 「${kw}」`,
      );
    }
  });

  it("完了集合の課題のコメントは取りに行かない", async () => {
    const r = await run(
      { project_keys: "P", include_comments: true },
      withIssues([issue({ key: "P-1", status: "Closed" })]),
    );
    expect(r.calls.some((c) => c.includes("/comments"))).toBe(false);
  });

  it("コメント確認は 1 回の呼び出しで 50 件まで。超えた分は確認せず、warning と truncated を出す", async () => {
    const all = Array.from({ length: 60 }, (_, i) =>
      issue({ key: `P-${String(i + 1).padStart(3, "0")}`, assignee: USER_A }),
    );
    const r = await run(
      { project_keys: "P", include_comments: true },
      withIssues(all, { "GET /issues/*/comments": [] }),
    );
    expect(r.calls.filter((c) => c.includes("/comments"))).toHaveLength(50);
    expect(r.json.analysis.truncated).toBe(true);
    expect(r.json.warnings).toEqual([
      {
        code: "comment_check_truncated",
        message:
          "Checked the latest comment of only the first 50 of 60 open issues (API call budget). blocked_by_keyword may be incomplete.",
        component: "comments",
        retryable: false,
      },
    ]);
  });

  it("コメント取得の失敗は握りつぶさず 1 件の warning にまとめ、他の課題の検出は続ける", async () => {
    const r = await run(
      { project_keys: "P", include_comments: true },
      withIssues(
        [issue({ key: "P-1", assignee: USER_A }), issue({ key: "P-2", assignee: USER_A })],
        {
          "GET /issues/P-1/comments": new Response("{}", { status: 500 }),
          "GET /issues/P-2/comments": commentsOf("待ち"),
        },
      ),
    );
    expect(keysOf(r)).toEqual(["P-2"]);
    expect(r.json.warnings).toHaveLength(1);
    expect(r.json.warnings[0]).toMatchObject({
      code: "comments_fetch_failed",
      component: "comments",
    });
    expect(r.json.warnings[0].message).toContain("1 issue");
  });
});

describe("project_blockers: API 呼び出し数(最悪ケース)", () => {
  it("maxApiCalls は 5 プロジェクト × (1 + 10) + コメント確認 50 = 105", () => {
    expect(projectBlockers.maxApiCalls).toBe(105);
  });

  it("5 プロジェクトが上限まで続き、include_comments でも 105 回ちょうどで終わる", async () => {
    const respond: Parameters<typeof callTool>[2] = {
      "GET /issues": endless((n) =>
        issue({ key: `P-${String(n).padStart(4, "0")}`, assignee: USER_A }),
      ),
      "GET /issues/*/comments": [],
    };
    for (const k of ["A", "B", "C", "D", "E"]) respond[`GET /projects/${k}`] = { id: 10 };
    const r = await run({ project_keys: "A,B,C,D,E", include_comments: true }, respond);
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toHaveLength(105);
    expect(r.json.analysis.truncated).toBe(true);
  });
});
