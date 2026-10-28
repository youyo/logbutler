import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearJwksCache } from "../../src/auth/access-jwt";
import {
  activity,
  ago,
  endless,
  endlessActivities,
  endlessComments,
  issue,
  NOW,
  paged,
  USER_A,
} from "../helpers/analysis-fixtures";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";
import {
  accessHeaders,
  BACKLOG_HOST,
  firstText,
  mcpRequest,
  readRpc,
  runAuthorizationFlow,
  setupMocks,
  type TokenSet,
} from "../helpers/oauth-flow";

// 「今日」を固定する(2026-10-28 水曜 12:00 JST)。Date だけ差し替え、タイマーは本物のまま。
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearJwksCache();
});

const API = `${BACKLOG_HOST}/api/v2`;

async function loggedIn(handlers: Parameters<typeof mockOutboundFetch>[0]) {
  const { accessKey } = await setupMocks();
  const flow = await runAuthorizationFlow(await accessHeaders(accessKey));
  const { access_token } = (await flow.tokenResponse.json()) as TokenSet;
  vi.restoreAllMocks();
  return { token: access_token, ...mockOutboundFetch(handlers) };
}

async function callAnalysis(token: string, name: string, args: Record<string, unknown>) {
  const res = await mcpRequest(token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const rpc = await readRpc(res);
  return { isError: rpc.result?.isError === true, json: JSON.parse(firstText(rpc)) };
}

const pathOf = (url: string) => new URL(url).pathname.replace("/api/v2", "");

describe("E2E 11: 分析ツール(M05A)が OAuth 済みトークンの /mcp で動く", () => {
  it("project_health: 課題一覧を 1 回だけ取得し、スコア・level・summary をエンベロープで返す", async () => {
    const issues = [
      issue({ key: "PROJ-1", status: "処理中", assignee: USER_A, updated: ago(20) }), // stale + long_in_progress(MEDIUM)
      issue({ key: "PROJ-2", priority: "高", updated: ago(1) }), // HIGH
      issue({ key: "PROJ-3", assignee: USER_A, updated: ago(1) }),
      issue({ key: "PROJ-4", status: "Closed", assignee: USER_A, updated: ago(90) }), // 完了集合
    ];
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects/PROJ`]: () => jsonResponse({ id: 10, projectKey: "PROJ" }),
      [`GET ${API}/issues`]: (call) => jsonResponse(paged(issues)(call)),
      [`GET ${API}/projects/PROJ/issueTypes`]: () => jsonResponse([{ id: 11, name: "案件" }]),
    });
    const { isError, json } = await callAnalysis(token, "logbutler_project_health", {
      project_key: "PROJ",
    });
    expect(isError).toBe(false);
    expect(json).toMatchObject({
      schema_version: "1",
      resource: "project_health",
      generated_at: NOW.toISOString(),
      space: "example",
      base_url: "https://example.backlog.com",
      warnings: [],
    });
    expect(json.analysis).toMatchObject({
      project_key: "PROJ",
      stale_summary: { total_count: 1, threshold_days: 7 },
      blocker_summary: { total_count: 2, high_count: 1, medium_count: 1 },
      workload_summary: { total_issues: 3, unassigned_count: 1 },
      // 100 - stale 1×5 - HIGH 1×10 - MEDIUM 1×5 - 未割当 1/3 > 20% の 10 = 70
      health_score: 70,
      health_level: "warning",
      truncated: false,
    });
    // 課題一覧は 1 回、Backlog のトークンは grant の props から
    expect(calls.map((c) => pathOf(c.url))).toEqual([
      "/projects/PROJ",
      "/issues",
      "/projects/PROJ/issueTypes",
    ]);
    expect(calls[0]?.headers.get("authorization")).toMatch(/^Bearer backlog-at-/);
  });

  it("my_tasks: GetMyself → overdue → upcoming → watching。重複は overdue 優先、日付は timezone 引数(既定 Asia/Tokyo)の暦日", async () => {
    const overdueOnly = issue({ key: "PROJ-1", dueDate: "2026-10-25T00:00:00Z" });
    const both = issue({ key: "PROJ-2", dueDate: "2026-10-27T00:00:00Z" });
    const upcomingOnly = issue({ key: "PROJ-3", dueDate: "2026-10-30T00:00:00Z" });
    let issueCalls = 0;
    const { token, calls } = await loggedIn({
      [`GET ${API}/users/myself`]: () => jsonResponse({ id: 1, userId: "a", name: "Alice" }),
      [`GET ${API}/issues`]: () =>
        jsonResponse(issueCalls++ === 0 ? [overdueOnly, both] : [both, upcomingOnly]),
      [`GET ${API}/users/1/watchings`]: () =>
        jsonResponse([
          { id: 1, issue: issue({ key: "PROJ-2" }), lastContentUpdated: null },
          { id: 2, issue: issue({ key: "PROJ-9", updated: ago(9) }), lastContentUpdated: null },
        ]),
    });
    const { isError, json } = await callAnalysis(token, "logbutler_my_tasks", {});
    expect(isError).toBe(false);
    expect(json.analysis.overdue.map((i: { issue_key: string }) => i.issue_key)).toEqual([
      "PROJ-1",
      "PROJ-2",
    ]);
    expect(json.analysis.upcoming.map((i: { issue_key: string }) => i.issue_key)).toEqual([
      "PROJ-3",
    ]);
    expect(json.analysis.watching.map((i: { issue_key: string }) => i.issue_key)).toEqual([
      "PROJ-9",
    ]);
    expect(json.analysis.watching[0]).toMatchObject({ is_stale: true, days_since_update: 9 });
    expect(json.analysis.date_range).toEqual({
      since: "2026-10-26T00:00:00+09:00",
      until: "2026-11-01T00:00:00+09:00",
    });
    expect(calls.map((c) => pathOf(c.url))).toEqual([
      "/users/myself",
      "/issues",
      "/issues",
      "/users/1/watchings",
    ]);
    expect(new URL(calls[1]?.url ?? "").searchParams.get("dueDateUntil")).toBe("2026-10-27");
  });

  it("ツールごとの maxApiCalls が実際の /mcp で効く: issue_stale は 5 プロジェクトが上限まで続いても 55 回で止まる", async () => {
    const handlers: Parameters<typeof mockOutboundFetch>[0] = {
      [`GET ${API}/issues`]: (call) =>
        jsonResponse(endless((n) => issue({ key: `X-${n}`, updated: ago(10) }))(call)),
    };
    for (const k of ["A", "B", "C", "D", "E"]) {
      handlers[`GET ${API}/projects/${k}`] = () => jsonResponse({ id: 10 });
    }
    const { token, calls } = await loggedIn(handlers);
    const { isError, json } = await callAnalysis(token, "logbutler_issue_stale", {
      project_keys: "A,B,C,D,E",
    });
    expect(isError).toBe(false);
    expect(calls).toHaveLength(55);
    expect(json.analysis.truncated).toBe(true);
    expect(
      json.warnings.filter((w: { code: string }) => w.code === "issues_truncated"),
    ).toHaveLength(5);
  });

  it("入力が不正なら Backlog を呼ばずに argument_error(プロジェクトが 6 個)", async () => {
    const { token, calls } = await loggedIn({});
    const { isError, json } = await callAnalysis(token, "logbutler_issue_stale", {
      project_keys: "A,B,C,D,E,F",
    });
    expect(isError).toBe(true);
    expect(json.error.code).toBe("argument_error");
    expect(calls).toHaveLength(0);
  });

  it("digest_weekly: until の当日を含めて集計する", async () => {
    const issues = [
      issue({ key: "PROJ-1", status: "完了", updated: "2026-10-27T14:00:00Z" }), // JST 10/27 23:00
      issue({ key: "PROJ-2", status: "完了", updated: "2026-10-27T15:00:00Z" }), // JST 10/28 00:00
    ];
    const { token } = await loggedIn({
      [`GET ${API}/projects/PROJ`]: () => jsonResponse({ id: 10 }),
      [`GET ${API}/issues`]: (call) => jsonResponse(paged(issues)(call)),
    });
    const { json } = await callAnalysis(token, "logbutler_digest_weekly", {
      project_key: "PROJ",
      since: "2026-10-20",
      until: "2026-10-27",
    });
    expect(json.analysis.completed.map((i: { issue_key: string }) => i.issue_key)).toEqual([
      "PROJ-1",
    ]);
  });

  it("project_blockers(include_comments): 5 プロジェクトが上限まで続いても、コメント確認 50 件を含めて 105 回で止まる(maxApiCalls と最新コメントの取得が /mcp で効く)", async () => {
    const handlers: Parameters<typeof mockOutboundFetch>[0] = {
      [`GET ${API}/issues`]: (call) =>
        jsonResponse(
          endless((n) => issue({ key: `X-${n}`, assignee: USER_A, updated: ago(1) }))(call),
        ),
      [`GET ${API}/issues/*/comments`]: () => jsonResponse([]),
    };
    for (const k of ["A", "B", "C", "D", "E"]) {
      handlers[`GET ${API}/projects/${k}`] = () => jsonResponse({ id: 10 });
    }
    const { token, calls } = await loggedIn(handlers);
    const { isError, json } = await callAnalysis(token, "logbutler_project_blockers", {
      project_keys: "A,B,C,D,E",
      include_comments: true,
    });
    expect(isError).toBe(false);
    const commentCalls = calls.filter((c) => pathOf(c.url).endsWith("/comments"));
    expect(commentCalls).toHaveLength(50);
    // 最新 1 件だけを見る
    const q = new URL(commentCalls[0]?.url ?? "").searchParams;
    expect([q.get("count"), q.get("order")]).toEqual(["1", "desc"]);
    expect(calls).toHaveLength(5 * 11 + 50);
    expect(json.analysis.truncated).toBe(true);
    expect(json.warnings.map((w: { code: string }) => w.code)).toContain("comment_check_truncated");
  });

  it("issue_timeline: コメントとアクティビティを maxId のカーソルで辿り、1 + 10 + 10 = 21 回で止まる", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/issues/P-1`]: () => jsonResponse(issue({ key: "P-1", id: 5000 })),
      [`GET ${API}/issues/P-1/comments`]: (call) => jsonResponse(endlessComments()(call)),
      [`GET ${API}/projects/P/activities`]: (call) =>
        jsonResponse(
          endlessActivities((id) => activity({ id, type: 2, content: { id: 5000, key_id: 1 } }))(
            call,
          ),
        ),
    });
    const { isError, json } = await callAnalysis(token, "logbutler_issue_timeline", {
      issue_key: "P-1",
      max_activity_pages: 10,
    });
    expect(isError).toBe(false);
    expect(calls).toHaveLength(21);
    // 2 ページ目以降は直前のページの最小 id を maxId に渡す(カーソル)
    const commentCalls = calls.filter((c) => pathOf(c.url) === "/issues/P-1/comments");
    expect(new URL(commentCalls[0]?.url ?? "").searchParams.get("maxId")).toBeNull();
    expect(new URL(commentCalls[1]?.url ?? "").searchParams.get("maxId")).not.toBeNull();
    expect(json.analysis.truncated).toBe(true);
    expect(json.warnings.map((w: { code: string }) => w.code)).toEqual([
      "comments_truncated",
      "activity_pagination_truncated",
    ]);
  });
});
