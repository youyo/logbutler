/**
 * M05B の代表ツール(digest_unified、search、user_activity)を、OAuth 済みトークンの /mcp 経由でモック Backlog に対して実行する。
 * 認可フロー全体は他の E2E が固定しているので、ここではツールの振る舞いと API 呼び出しを固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearJwksCache } from "../../src/auth/access-jwt";
import {
  activitiesDesc,
  activity,
  endlessActivities,
  iso,
  issue,
  NOW,
  paged,
  USER_A,
  USER_B,
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

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const res = await mcpRequest(token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const rpc = await readRpc(res);
  // ツール未登録などの JSON-RPC エラーは、理由が読めるように投げる
  if (rpc.error) throw new Error(`JSON-RPC error ${rpc.error.code}: ${rpc.error.message}`);
  return { isError: rpc.result?.isError === true, json: JSON.parse(firstText(rpc)) };
}

const pathOf = (url: string) => new URL(url).pathname.replace("/api/v2", "");
const q = (url: string, key: string) => new URL(url).searchParams.get(key);
const codes = (warnings: { code: string }[]) => warnings.map((w) => w.code);

/** id が大きいほど新しい。id 250 が NOW の 1 時間前、id 1 が 250 時間前。 */
const hourly = (id: number) =>
  activity({
    id,
    type: 3,
    created: iso(new Date(NOW.getTime() - (251 - id) * 3600_000)),
    user: id % 2 === 0 ? USER_A : USER_B,
    content: { id: 9000 + id, key: "PROJ-1", comment: { id, content: `c${id}` } },
  });

describe("E2E 14: digest_unified(M05B)が /mcp で動く", () => {
  it("project_keys + since/until: GetProject は 1 回、課題は 100 件ちょうどのページの次も取り、アクティビティは maxId で辿って since で止まる", async () => {
    // 101 件 = 1 ページ目が 100 件ちょうどで満杯 → 2 ページ目に 1 件
    const issues = Array.from({ length: 101 }, (_, i) =>
      issue({
        key: `PROJ-${i + 1}`,
        status: i % 2 === 0 ? "処理中" : "完了",
        assignee: i < 60 ? USER_A : i < 100 ? USER_B : null,
      }),
    );
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects/PROJ`]: () =>
        jsonResponse({ id: 10, projectKey: "PROJ", name: "Project X" }),
      [`GET ${API}/issues`]: (call) => jsonResponse(paged(issues)(call)),
      [`GET ${API}/projects/PROJ/activities`]: (call) =>
        jsonResponse(activitiesDesc(250, hourly)(call)),
    });
    const { isError, json } = await callTool(token, "logbutler_digest_unified", {
      since: "2026-10-20",
      until: "2026-10-27",
      project_keys: "PROJ,PROJ",
    });
    expect(isError, JSON.stringify(json)).toBe(false);
    expect(json).toMatchObject({
      schema_version: "1",
      resource: "digest",
      generated_at: NOW.toISOString(),
      space: "example",
      base_url: "https://example.backlog.com",
      warnings: [],
    });
    const d = json.digest;
    expect(d.scope).toEqual({
      projects: [{ id: 10, key: "PROJ", name: "Project X" }],
      users: [],
      teams: [],
      issues: [],
      since: "2026-10-20",
      until: "2026-10-27",
    });
    expect(d.truncated).toBe(false);
    expect(d.summary.issue_count).toBe(101);
    // JST の 10/20 00:00 以降 10/27 23:59:59.999 まで = id 47..238
    expect(d.summary.activity_count).toBe(192);
    expect(d.summary.by_status).toEqual({ 処理中: 51, 完了: 50 });
    // by_user は課題の担当者と活動の実行者を数える(logvalet は常に空)
    expect(d.summary.by_user).toEqual({
      "1": { issues: 60, activities: 96 },
      "2": { issues: 40, activities: 96 },
    });
    expect(d.summary.period).toEqual({ since: "2026-10-20", until: "2026-10-27" });

    const paths = calls.map((c) => pathOf(c.url));
    // GetProject は 1 回だけ(logvalet は呼び出し側と Builder の 2 回)
    expect(paths.filter((p) => p === "/projects/PROJ")).toHaveLength(1);
    const issueCalls = calls.filter((c) => pathOf(c.url) === "/issues");
    expect(issueCalls).toHaveLength(2);
    expect(new URL(issueCalls[0]?.url ?? "").searchParams.getAll("projectId[]")).toEqual(["10"]);
    expect(q(issueCalls[0]?.url ?? "", "updatedSince")).toBe("2026-10-20");
    expect(q(issueCalls[0]?.url ?? "", "updatedUntil")).toBe("2026-10-27");
    expect(q(issueCalls[1]?.url ?? "", "offset")).toBe("100");
    // アクティビティ: 250..151 → maxId=150 で 150..51 → maxId=50 で 50..(since で切る)。3 回で止まる
    const actCalls = calls.filter((c) => pathOf(c.url) === "/projects/PROJ/activities");
    expect(actCalls.map((c) => q(c.url, "maxId"))).toEqual([null, "150", "50"]);
    expect(calls).toHaveLength(1 + 2 + 3);
  });

  it("until より新しい活動ばかりが続いても、maxId を進めて 5 ページ(1 ソースの上限)で止まる(logvalet は同じページを繰り返し、until 指定で止まらなかった)", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects/PROJ`]: () => jsonResponse({ id: 10, projectKey: "PROJ", name: "X" }),
      [`GET ${API}/issues`]: () => jsonResponse([]),
      // すべて NOW 付近(until=2026-10-01 より新しい)で、永遠に満杯のページを返す
      [`GET ${API}/projects/PROJ/activities`]: (call) =>
        jsonResponse(endlessActivities((id) => activity({ id, created: iso(NOW) }))(call)),
    });
    const { isError, json } = await callTool(token, "logbutler_digest_unified", {
      since: "2026-09-01",
      until: "2026-10-01",
      project_keys: "PROJ",
    });
    expect(isError).toBe(false);
    const actCalls = calls.filter((c) => pathOf(c.url) === "/projects/PROJ/activities");
    expect(actCalls).toHaveLength(5);
    // 2 ページ目以降は、直前のページの最後の id - 1 を渡す(同じページを繰り返さない)
    expect(actCalls.slice(0, 3).map((c) => q(c.url, "maxId"))).toEqual([null, "99900", "99800"]);
    expect(calls).toHaveLength(1 + 1 + 5);
    expect(json.digest.truncated).toBe(true);
    expect(json.digest.summary.activity_count).toBe(0);
    expect(codes(json.warnings)).toEqual(["activities_truncated"]);
  });

  it("user_ids + team_ids: チームのメンバーを展開して重複を除き、ユーザーごとにアクティビティを直列で取る。名前はチームから分かる分は GetUser しない", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/teams/7`]: () =>
        jsonResponse({
          id: 7,
          name: "Team",
          members: [
            { id: 1, name: "Alice" },
            { id: 2, name: "Bob" },
          ],
        }),
      [`GET ${API}/users/3`]: () => jsonResponse({ id: 3, userId: "c", name: "Carol" }),
      [`GET ${API}/issues`]: (call) =>
        jsonResponse(
          paged([issue({ key: "P-1", assignee: USER_A }), issue({ key: "P-2", assignee: USER_B })])(
            call,
          ),
        ),
      [`GET ${API}/users/1/activities`]: () =>
        jsonResponse([activity({ id: 20, created: iso(NOW), user: USER_A })]),
      [`GET ${API}/users/2/activities`]: () =>
        jsonResponse([activity({ id: 10, created: iso(NOW), user: USER_B })]),
      [`GET ${API}/users/3/activities`]: () => jsonResponse([]),
    });
    const { isError, json } = await callTool(token, "logbutler_digest_unified", {
      since: "2026-10-27",
      user_ids: "3,1",
      team_ids: "7",
    });
    expect(isError, JSON.stringify(json)).toBe(false);
    expect(json.digest.scope.teams).toEqual([{ id: 7, name: "Team" }]);
    expect(json.digest.scope.users).toEqual([
      { id: 3, name: "Carol" },
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    expect(calls.map((c) => pathOf(c.url))).toEqual([
      "/teams/7",
      "/users/3",
      "/issues",
      "/users/3/activities",
      "/users/1/activities",
      "/users/2/activities",
    ]);
    expect(new URL(calls[2]?.url ?? "").searchParams.getAll("assigneeId[]")).toEqual([
      "3",
      "1",
      "2",
    ]);
    // 活動は新しい順(id 降順)にまとめる
    expect(json.digest.activities.map((a: { id: number }) => a.id)).toEqual([20, 10]);
  });

  it("due_date / start_date は issue_list と同じ解釈で課題一覧に渡す(logvalet はスキーマにあるのに使っていなかった)", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/issues`]: () => jsonResponse([]),
      [`GET ${API}/space/activities`]: () => jsonResponse([]),
    });
    const { isError } = await callTool(token, "logbutler_digest_unified", {
      since: "2026-10-01",
      due_date: "this-week",
      start_date: "2026-10-01:2026-10-15",
    });
    expect(isError).toBe(false);
    const url = calls.find((c) => pathOf(c.url) === "/issues")?.url ?? "";
    // 2026-10-28(水) の週 = 10/26(月)〜11/1(日)
    expect(q(url, "dueDateSince")).toBe("2026-10-26");
    expect(q(url, "dueDateUntil")).toBe("2026-11-01");
    expect(q(url, "startDateSince")).toBe("2026-10-01");
    expect(q(url, "startDateUntil")).toBe("2026-10-15");
  });

  it("プロジェクトが引けないときは警告にするが、絞り込みを失ってスペース全体を返さない", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects/NOPE`]: () =>
        jsonResponse({ errors: [{ message: "No project." }] }, 404),
    });
    const { isError, json } = await callTool(token, "logbutler_digest_unified", {
      since: "2026-10-01",
      project_keys: "NOPE",
    });
    expect(isError).toBe(false);
    expect(codes(json.warnings)).toEqual(["project_fetch_failed"]);
    expect(json.digest.issues).toEqual([]);
    expect(json.digest.activities).toEqual([]);
    expect(calls.map((c) => pathOf(c.url))).toEqual(["/projects/NOPE"]);
  });

  it("入力が不正なら Backlog を呼ばずに argument_error(since が日付でない)", async () => {
    const { token, calls } = await loggedIn({});
    const { isError, json } = await callTool(token, "logbutler_digest_unified", {
      since: "2026/10/01",
    });
    expect(isError).toBe(true);
    expect(json.error.code).toBe("argument_error");
    expect(calls).toHaveLength(0);
  });
});

describe("E2E 15: search(M05B)が /mcp で動く", () => {
  it("issues / documents / wikis を統合し、URL はパスをエスケープする。wiki 検索のプロジェクト数も上限(10)に含め、超えたら警告と truncated", async () => {
    const projects = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      projectKey: `P${i + 1}`,
      name: `Project ${i + 1}`,
    }));
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects`]: () => jsonResponse(projects),
      [`GET ${API}/issues`]: () =>
        jsonResponse([
          issue({
            key: "P1-7",
            projectId: 1,
            summary: "認証の不具合",
            description: "OAuth のトークンが切れる",
            assignee: USER_A,
          }),
        ]),
      [`GET ${API}/documents`]: () =>
        jsonResponse([
          {
            id: "doc/1 a",
            projectId: 2,
            title: "OAuth ガイド",
            plain: "OAuth の使い方",
            created: "2026-10-01T00:00:00Z",
            updated: "2026-10-02T00:00:00Z",
          },
        ]),
      [`GET ${API}/wikis`]: (call) => {
        const key = q(call.url, "projectIdOrKey");
        return jsonResponse(
          key === "P3"
            ? [{ id: 5, projectId: 3, name: "Home/OAuth 設定", content: "OAuth 設定メモ" }]
            : [],
        );
      },
    });
    const { isError, json } = await callTool(token, "logbutler_search", { keyword: "OAuth" });
    expect(isError, JSON.stringify(json)).toBe(false);
    expect(json.resource).toBe("search");
    // GetProject なし: ListProjects 1 + issues 1 + documents 1 + wiki 10 プロジェクト = 13(maxApiCalls と同じ)
    expect(calls).toHaveLength(13);
    expect(
      calls.filter((c) => pathOf(c.url) === "/wikis").map((c) => q(c.url, "projectIdOrKey")),
    ).toEqual(projects.slice(0, 10).map((p) => p.projectKey));
    expect(codes(json.warnings)).toEqual(["wiki_search_truncated"]);
    const d = json.digest;
    expect(d.truncated).toBe(true);
    expect(d.returned_by_type).toEqual({ issues: 1, documents: 1, wikis: 1 });
    expect(d.total_returned).toBe(3);
    expect(d.items.map((i: { resource_type: string }) => i.resource_type)).toEqual([
      "issue",
      "document",
      "wiki",
    ]);
    expect(d.items[0]).toMatchObject({
      key: "P1-7",
      project_key: "P1",
      url: "https://example.backlog.com/view/P1-7",
      snippet: "OAuth のトークンが切れる",
      assignee: { id: 1, name: "Alice" },
    });
    expect(d.items[1]).toMatchObject({
      id: "doc/1 a",
      project_key: "P2",
      url: "https://example.backlog.com/document/P2/doc%2F1%20a",
    });
    expect(d.items[2]).toMatchObject({
      resource_type: "wiki",
      project_key: "P3",
      url: "https://example.backlog.com/wiki/P3/Home%2FOAuth%20%E8%A8%AD%E5%AE%9A",
    });
  });

  it("project_keys の GetProject が失敗しても全体は失敗にせず警告にする(logvalet は全体エラー)。残りのプロジェクトで検索する", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects/GOOD`]: () => jsonResponse({ id: 10, projectKey: "GOOD", name: "G" }),
      [`GET ${API}/projects/BAD`]: () =>
        jsonResponse({ errors: [{ message: "No project." }] }, 404),
      [`GET ${API}/issues`]: () => jsonResponse([]),
      [`GET ${API}/documents`]: () => jsonResponse([]),
      [`GET ${API}/wikis`]: () => jsonResponse([]),
    });
    const { isError, json } = await callTool(token, "logbutler_search", {
      keyword: "x",
      project_keys: "BAD,GOOD",
    });
    expect(isError, JSON.stringify(json)).toBe(false);
    expect(codes(json.warnings)).toEqual(["project_fetch_failed"]);
    expect(json.warnings[0].retryable).toBe(false); // 404 は再試行しても直らない
    expect(json.digest.truncated).toBe(false);
    const issueCall = calls.find((c) => pathOf(c.url) === "/issues");
    expect(new URL(issueCall?.url ?? "").searchParams.getAll("projectId[]")).toEqual(["10"]);
    // 解決できたプロジェクトだけで wiki を検索する
    expect(calls.filter((c) => pathOf(c.url) === "/wikis")).toHaveLength(1);
  });

  it("project_keys が全部引けないときは、絞り込みを失ってスペース全体を検索しない", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects/BAD`]: () =>
        jsonResponse({ errors: [{ message: "No project." }] }, 404),
    });
    const { isError, json } = await callTool(token, "logbutler_search", {
      keyword: "x",
      project_keys: "BAD",
    });
    expect(isError).toBe(false);
    expect(json.digest.items).toEqual([]);
    expect(codes(json.warnings)).toEqual(["project_fetch_failed"]);
    expect(calls.map((c) => pathOf(c.url))).toEqual(["/projects/BAD"]);
  });
});

describe("E2E 16: user_activity(M05B)が /mcp で動く", () => {
  it("'me' を解決し、期間指定ではページ上限(10 ページ)で止まって truncated と警告を出す(エンベロープ化)", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/users/myself`]: () => jsonResponse({ id: 42, userId: "me", name: "Me" }),
      [`GET ${API}/users/42/activities`]: (call) =>
        jsonResponse(endlessActivities((id) => activity({ id, created: iso(NOW) }))(call)),
    });
    const { isError, json } = await callTool(token, "logbutler_user_activity", {
      user_id: "me",
      since: "2026-10-01",
    });
    expect(isError).toBe(false);
    expect(json.resource).toBe("user_activity");
    expect(json.digest.user_id).toBe(42);
    expect(json.digest.truncated).toBe(true);
    expect(json.digest.total_count).toBe(1000);
    expect(json.digest.activities).toHaveLength(1000);
    expect(codes(json.warnings)).toEqual(["activities_truncated"]);
    expect(calls).toHaveLength(1 + 10);
  });
});
