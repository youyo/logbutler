import { describe, expect, it } from "vitest";
import { calcHealthLevel, calcHealthScore } from "../../src/analysis/health";
import { projectHealth } from "../../src/mcp/tools/analysis";
import { ago, endless, issue, NOW, paged, USER_A } from "../helpers/analysis-fixtures";
import type { RecordedCall } from "../helpers/mock-fetch";
import { callTool } from "../helpers/tool-call";

const run = (args: Record<string, unknown>, respond: Parameters<typeof callTool>[2]) =>
  callTool("logbutler_project_health", args, respond, { now: NOW, timezone: "Asia/Tokyo" });

const RULE_YAML = `schema_version: 1
project:
  key: P
close_policy:
  low_untouched_days: 90
initiatives:
  - name: 運用保守
engagements:
  - name: 案件A
    lead: x
    initiative: 運用保守
`;
const ruleIssue = {
  id: 900,
  issueKey: "P-900",
  summary: "[規約] 運用規約",
  issueType: { id: 10, name: "規約" },
  description: `規約\n\n\`\`\`yaml\n${RULE_YAML}\`\`\`\n`,
};
const parentIssue = {
  id: 901,
  issueKey: "P-901",
  summary: "[案件] 案件A",
  issueType: { id: 11, name: "案件" },
  assignee: USER_A,
  dueDate: "2026-12-01T00:00:00Z",
};

/** 規約なしのプロジェクト。課題一覧は 1 つの配列からページングで返す。 */
const plain = (issues: unknown[]) => ({
  "GET /projects/P": { id: 10 },
  "GET /projects/P/issueTypes": [{ id: 11, name: "案件" }],
  "GET /issues": paged(issues),
});

/** 規約ありのプロジェクト。issueTypeId[] つきの問い合わせには規約課題 / 案件親課題を返す。 */
const adopted = (issues: unknown[], rule: unknown[] = [ruleIssue]) => ({
  "GET /projects/P": { id: 10 },
  "GET /projects/P/issueTypes": [
    { id: 10, name: "規約" },
    { id: 11, name: "案件" },
  ],
  "GET /issues": (call: { url: string }) => {
    const q = new URL(call.url).searchParams;
    if (q.get("issueTypeId[]") === "10") return rule;
    return paged(issues)(call as never);
  },
});

describe("calcHealthScore / calcHealthLevel", () => {
  const score = (o: Partial<Record<string, number>> = {}) =>
    calcHealthScore({
      stale: 0,
      blockerHigh: 0,
      blockerMedium: 0,
      overloaded: 0,
      unassigned: 0,
      total: 0,
      ambiguity: 0,
      ...o,
    });

  it("減点: stale×5 / HIGH×10 / MEDIUM×5 / overloaded×8", () => {
    expect(score()).toBe(100);
    expect(score({ stale: 2 })).toBe(90);
    expect(score({ blockerHigh: 1, blockerMedium: 2 })).toBe(80);
    expect(score({ overloaded: 1 })).toBe(92);
  });
  it("未割当率が 20% を超えたら -10。ちょうど 20% は減点しない。実数で比べる(logvalet は整数除算で 20.69% を見逃した)", () => {
    expect(score({ unassigned: 1, total: 5 })).toBe(100);
    expect(score({ unassigned: 2, total: 9 })).toBe(90);
    expect(score({ unassigned: 6, total: 29 })).toBe(90); // 20.69%。整数除算だと 20 で減点されない
    expect(score({ unassigned: 0, total: 0 })).toBe(100);
  });
  it("曖昧さは 1 件 -2、減点の上限は -20。下限は 0", () => {
    expect(score({ ambiguity: 3 })).toBe(94);
    expect(score({ ambiguity: 10 })).toBe(80);
    expect(score({ ambiguity: 50 })).toBe(80);
    expect(score({ stale: 30 })).toBe(0);
  });
  it("level: 80 以上 healthy / 60 以上 warning / それ未満 critical", () => {
    expect(calcHealthLevel(100)).toBe("healthy");
    expect(calcHealthLevel(80)).toBe("healthy");
    expect(calcHealthLevel(79)).toBe("warning");
    expect(calcHealthLevel(60)).toBe("warning");
    expect(calcHealthLevel(59)).toBe("critical");
    expect(calcHealthLevel(0)).toBe("critical");
  });
});

describe("project_health", () => {
  it("課題一覧は 1 回(ページ)だけ取得し、stale / blockers / workload / ambiguity で共有する(logvalet は 4 回取得)", async () => {
    const r = await run({ project_key: "P" }, plain([issue({ key: "P-1", assignee: USER_A })]));
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toEqual([
      "GET /projects/P",
      "GET /issues?count=100&projectId[]=10",
      "GET /projects/P/issueTypes",
    ]);
  });

  it("スコアと level: stale 2 件(-10)、HIGH 1 件(-10)、MEDIUM 1 件(-5)、未割当率 > 20%(-10) → 65 / warning", async () => {
    const r = await run(
      { project_key: "P" },
      plain([
        // 処理中 20 日: stale かつ long_in_progress(MEDIUM)
        issue({ key: "P-1", status: "処理中", assignee: USER_A, updated: ago(20) }),
        // 8 日更新なし: stale のみ(blockers の既定 14 日には届かない)
        issue({ key: "P-2", status: "未対応", assignee: USER_A, updated: ago(8) }),
        // 優先度高・担当なし: HIGH
        issue({ key: "P-3", priority: "高", updated: ago(1) }),
        issue({ key: "P-4", assignee: USER_A, updated: ago(1) }),
        issue({ key: "P-5", assignee: USER_A, updated: ago(1) }),
        // 完了集合は数えない
        issue({
          key: "P-6",
          status: "Closed",
          priority: "高",
          updated: ago(100),
          dueDate: "2026-01-01T00:00:00Z",
        }),
      ]),
    );
    expect(r.json.analysis).toMatchObject({
      project_key: "P",
      stale_summary: { total_count: 2, threshold_days: 7, overdue_count: 0 },
      blocker_summary: { total_count: 2, high_count: 1, medium_count: 1 },
      workload_summary: {
        total_issues: 5,
        unassigned_count: 1,
        overloaded_count: 0,
        high_load_count: 0,
      },
      ambiguities: { adopted: false, total_count: 0, ambiguities: [] },
      // 100 - 2×5 - 1×10 - 1×5 = 75。未割当 1/5 = 20% は減点しない。
      health_score: 75,
      health_level: "warning",
      truncated: false,
    });
    expect(r.json.resource).toBe("project_health");
    expect(r.json.analysis.llm_hints).toEqual({
      primary_entities: ["project:P"],
      open_questions: ["2件の停滞課題があります", "1件の HIGH ブロッカーがあります"],
      suggested_next_actions: [],
    });
  });

  it("days 未指定: stale 7 / long_in_progress 14 / workload 7。days を指定すると 3 つとも同じ値", async () => {
    const issues = [issue({ key: "P-1", status: "処理中", assignee: USER_A, updated: ago(10) })];
    const def = await run({ project_key: "P" }, plain(issues));
    expect(def.json.analysis.stale_summary.threshold_days).toBe(7);
    expect(def.json.analysis.stale_summary.total_count).toBe(1);
    expect(def.json.analysis.blocker_summary.total_count).toBe(0); // 10 日 < 14 日

    const d5 = await run({ project_key: "P", days: 5 }, plain(issues));
    expect(d5.json.analysis.stale_summary).toMatchObject({ threshold_days: 5, total_count: 1 });
    expect(d5.json.analysis.blocker_summary.total_count).toBe(1); // 10 日 >= 5 日

    const d11 = await run({ project_key: "P", days: 11 }, plain(issues));
    expect(d11.json.analysis.stale_summary.total_count).toBe(0);
    expect(d11.json.analysis.blocker_summary.total_count).toBe(0);
  });

  it("overdue_count は stale のうち期限超過のもの", async () => {
    const r = await run(
      { project_key: "P" },
      plain([
        issue({ key: "P-1", assignee: USER_A, updated: ago(10), dueDate: "2026-10-01T00:00:00Z" }),
        issue({ key: "P-2", assignee: USER_A, updated: ago(10) }),
      ]),
    );
    expect(r.json.analysis.stale_summary).toMatchObject({ total_count: 2, overdue_count: 1 });
  });

  it("overloaded / high_load_count: 20 件以上 / 10〜19 件の担当者", async () => {
    const mk = (n: number, user: { id: number; name: string }, from: number) =>
      Array.from({ length: n }, (_, i) => issue({ key: `P-${from + i}`, assignee: user }));
    const r = await run(
      { project_key: "P" },
      plain([...mk(20, USER_A, 1), ...mk(10, { id: 2, name: "Bob" }, 100)]),
    );
    expect(r.json.analysis.workload_summary).toEqual({
      total_issues: 30,
      unassigned_count: 0,
      overloaded_count: 1,
      high_load_count: 1,
    });
    expect(r.json.analysis.health_score).toBe(92);
    expect(r.json.analysis.llm_hints.open_questions).toEqual(["1人のメンバーが過負荷状態です"]);
  });

  it("規約が導入済みなら曖昧さを数える: 案件カテゴリのない課題 1 件 → -2", async () => {
    const r = await run(
      { project_key: "P" },
      adopted([
        issue({ key: "P-1", assignee: USER_A, category: [{ id: 1, name: "案件A" }] }),
        issue({ key: "P-2", assignee: USER_A, category: [] }),
        parentIssue,
      ]),
    );
    expect(r.json.analysis.ambiguities).toMatchObject({ adopted: true, total_count: 1 });
    expect(r.json.analysis.ambiguities.ambiguities[0]).toMatchObject({
      kind: "no_engagement",
      target: "P-2",
    });
    expect(r.json.analysis.health_score).toBe(98);
    expect(r.json.analysis.llm_hints.open_questions).toContain("1件の曖昧さがあります");
    // 規約の読み込みは issueTypes と、種別「規約」で絞った課題一覧。課題一覧そのものは共有。
    expect(r.calls).toEqual([
      "GET /projects/P",
      "GET /issues?count=100&projectId[]=10",
      "GET /projects/P/issueTypes",
      "GET /issues?count=100&issueTypeId[]=10&projectId[]=10",
    ]);
  });

  it("規約の読み込みに失敗しても致命にしない: ambiguity_detect_failed の warning で曖昧さは空", async () => {
    const r = await run(
      { project_key: "P" },
      adopted(
        [issue({ key: "P-1", assignee: USER_A })],
        [{ ...ruleIssue, description: "yaml なし" }],
      ),
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.json.analysis.ambiguities).toEqual({
      adopted: false,
      total_count: 0,
      ambiguities: [],
    });
    expect(r.json.analysis.health_score).toBe(100);
    expect(r.json.warnings).toHaveLength(1);
    expect(r.json.warnings[0]).toMatchObject({
      code: "ambiguity_detect_failed",
      component: "ambiguity",
      retryable: true,
    });
    expect(r.json.warnings[0].message).toContain("ambiguity detection failed");
  });

  it("プロジェクト / 課題の取得失敗: score 0・critical・集計はゼロ、warning は 1 件(logvalet は 3 重に出していた)", async () => {
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
    expect(r.json.analysis).toMatchObject({
      project_key: "P",
      stale_summary: { total_count: 0, threshold_days: 0, overdue_count: 0 },
      blocker_summary: { total_count: 0, high_count: 0, medium_count: 0 },
      workload_summary: {
        total_issues: 0,
        unassigned_count: 0,
        overloaded_count: 0,
        high_load_count: 0,
      },
      ambiguities: { adopted: false, total_count: 0, ambiguities: [] },
      health_score: 0,
      health_level: "critical",
    });
    expect(r.json.warnings.map((w: { code: string }) => w.code)).toEqual(["project_fetch_failed"]);
    expect(r.calls).toEqual(["GET /projects/P"]);
  });

  it("20 件より多い課題がある場合も全件を分析する(再現: logvalet は 20 件で打ち切り)", async () => {
    const all = Array.from({ length: 150 }, (_, i) =>
      issue({ key: `P-${i + 1}`, assignee: USER_A, updated: ago(10) }),
    );
    const r = await run({ project_key: "P" }, plain(all));
    expect(r.json.analysis.stale_summary.total_count).toBe(150);
    expect(r.json.analysis.workload_summary.total_issues).toBe(150);
  });

  it("include_comments: blocked_by_keyword を数える", async () => {
    const r = await run(
      { project_key: "P", include_comments: true },
      {
        ...plain([issue({ key: "P-1", assignee: USER_A })]),
        "GET /issues/P-1/comments": [
          { id: 1, content: "依存先待ち", createdUser: USER_A, created: ago(1) },
        ],
      },
    );
    expect(r.json.analysis.blocker_summary).toEqual({
      total_count: 1,
      high_count: 0,
      medium_count: 1,
    });
    expect(r.json.analysis.health_score).toBe(95);
  });

  describe("API 呼び出し数(最悪ケース)", () => {
    it("maxApiCalls は 課題 (1 + 10) + 規約 (1 + 10) + コメント確認 50 = 72", () => {
      expect(projectHealth.maxApiCalls).toBe(72);
    });

    it("課題・規約課題が上限まで続き、コメント確認も使い切っても 72 回ちょうどで終わる", async () => {
      const r = await run(
        { project_key: "P", include_comments: true },
        {
          "GET /projects/P": { id: 10 },
          "GET /projects/P/issueTypes": [{ id: 10, name: "規約" }],
          "GET /issues": (call: RecordedCall) => {
            const q = new URL(call.url).searchParams;
            if (q.get("issueTypeId[]") === "10") {
              return endless((n) => ({ ...ruleIssue, id: n, issueKey: `P-R${n}` }))(call);
            }
            return endless((n) =>
              issue({ key: `P-${String(n).padStart(4, "0")}`, assignee: USER_A }),
            )(call);
          },
          "GET /issues/*/comments": [],
        },
      );
      expect(r.isError, r.text).toBe(false);
      expect(r.calls).toHaveLength(72);
      expect(r.json.analysis.truncated).toBe(true);
      const codes = r.json.warnings.map((w: { code: string }) => w.code);
      expect(codes).toEqual([
        "issues_truncated",
        "comment_check_truncated",
        "ambiguity_detect_failed",
      ]);
    });
  });
});
