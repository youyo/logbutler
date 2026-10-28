/** digest_unified(logvalet `internal/digest/unified_test.go` から書き起こし + M05B の意図した変更)。 */
import { describe, expect, it } from "vitest";
import { digestUnified } from "../../src/mcp/tools/digest";
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
import { jsonResponse, type RecordedCall } from "../helpers/mock-fetch";
import { callTool, type Respond } from "../helpers/tool-call";

const run = (
  args: Record<string, unknown>,
  respond: Parameters<typeof callTool>[2],
  tz = "Asia/Tokyo",
) =>
  callTool("logbutler_digest_unified", { since: "2026-10-20", ...args }, respond, {
    now: NOW,
    timezone: tz,
  });
const codes = (r: { json: { warnings: { code: string }[] } }) => r.json.warnings.map((w) => w.code);
const err404 = () => jsonResponse({ errors: [{ message: "Not found.", code: 6 }] }, 404);
const err503 = () => jsonResponse({}, 503);
const hoursAgo = (h: number) => iso(new Date(NOW.getTime() - h * 3600_000));
const recent = (id: number) => activity({ id, created: hoursAgo(1) });
const proj = (id: number, key: string, name = `Project ${key}`) => ({ id, projectKey: key, name });
const user = (id: number, name: string) => ({ id, userId: name.toLowerCase(), name });

describe("digest_unified: スペース全体 / スコープなし", () => {
  it("TestBuild_spaceWide: スコープなしは課題一覧とスペースのアクティビティ。エンベロープは resource=digest", async () => {
    const r = await run(
      {},
      {
        "GET /issues": paged([issue({ key: "P-1", assignee: USER_A, status: "未対応" })]),
        "GET /space/activities": [recent(1)],
      },
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toEqual([
      "GET /issues?count=100&updatedSince=2026-10-20",
      "GET /space/activities?count=100",
    ]);
    expect(r.json).toMatchObject({ schema_version: "1", resource: "digest", warnings: [] });
    expect(r.json.digest.scope).toEqual({
      projects: [],
      users: [],
      teams: [],
      issues: [],
      since: "2026-10-20",
    });
    expect(r.json.digest.summary).toEqual({
      issue_count: 1,
      activity_count: 1,
      by_status: { 未対応: 1 },
      by_user: { "1": { issues: 1, activities: 1 } },
      period: { since: "2026-10-20", until: "" },
    });
    expect(r.json.digest.llm_hints).toEqual({
      primary_entities: [],
      open_questions: [],
      suggested_next_actions: [],
    });
  });

  it("課題はそのまま(Backlog の camelCase)で返す", async () => {
    const i = issue({ key: "P-1", assignee: USER_A });
    const r = await run({}, { "GET /issues": [i], "GET /space/activities": [] });
    expect(r.json.digest.issues).toEqual([i]);
  });
});

describe("digest_unified: プロジェクト", () => {
  const base = {
    "GET /projects/PROJ": proj(10, "PROJ", "Project X"),
    "GET /projects/OTH": proj(11, "OTH", "Other"),
    "GET /issues": paged([]),
    "GET /projects/PROJ/activities": [] as unknown[],
    "GET /projects/OTH/activities": [] as unknown[],
  };

  it("TestBuild_projectAndUser 相当: GetProject は各キー 1 回、projectId[] は重複なし。アクティビティはプロジェクトごとに直列", async () => {
    const r = await run({ project_keys: "PROJ, OTH ,PROJ" }, base);
    expect(r.calls).toEqual([
      "GET /projects/PROJ",
      "GET /projects/OTH",
      "GET /issues?count=100&projectId[]=10&projectId[]=11&updatedSince=2026-10-20",
      "GET /projects/PROJ/activities?count=100",
      "GET /projects/OTH/activities?count=100",
    ]);
    expect(r.json.digest.scope.projects).toEqual([
      { id: 10, key: "PROJ", name: "Project X" },
      { id: 11, key: "OTH", name: "Other" },
    ]);
    expect(r.json.digest.llm_hints.primary_entities).toEqual(["PROJ", "OTH"]);
  });

  it("別の綴りのキーが同じプロジェクトを指しても、projectId[] は重複しない", async () => {
    const r = await run(
      { project_keys: "PROJ,proj" },
      {
        "GET /projects/PROJ": proj(10, "PROJ"),
        "GET /projects/proj": proj(10, "PROJ"),
        "GET /issues": [],
        "GET /projects/PROJ/activities": [],
        "GET /projects/proj/activities": [],
      },
    );
    expect(r.calls[2]).toBe("GET /issues?count=100&projectId[]=10&updatedSince=2026-10-20");
  });

  it("プロジェクトが 1 つでも引ければ、引けたものだけで進める(warning: project_fetch_failed)", async () => {
    const r = await run({ project_keys: "BAD,PROJ" }, { ...base, "GET /projects/BAD": err404 });
    expect(codes(r)).toEqual(["project_fetch_failed"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "scope.projects.BAD", retryable: false });
    expect(r.calls[2]).toContain("projectId[]=10");
  });

  it("指定したプロジェクトが全部引けなければ、絞り込みを失ってスペース全体を返さない(課題もアクティビティも取らない)", async () => {
    const r = await run({ project_keys: "BAD" }, { "GET /projects/BAD": err503 });
    expect(r.calls).toEqual(["GET /projects/BAD"]);
    expect(codes(r)).toEqual(["project_fetch_failed"]);
    expect(r.json.warnings[0].retryable).toBe(true);
    expect(r.json.digest).toMatchObject({ issues: [], activities: [], truncated: false });
  });

  it("プロジェクトは引けたが user_ids が引けない、のような一部の絞り込みの喪失もスペース/プロジェクト全体に広げない", async () => {
    const r = await run(
      { project_keys: "PROJ", team_ids: "9" },
      { "GET /projects/PROJ": proj(10, "PROJ"), "GET /teams/9": err404 },
    );
    expect(r.calls).toEqual(["GET /teams/9", "GET /projects/PROJ"]);
    expect(codes(r)).toEqual(["team_fetch_failed"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "scope.teams.9" });
  });

  it("チームは引けたがメンバーが 0 人なら、全員の課題・スペース全体に広げず、team_has_no_members の warning で理由を伝える", async () => {
    const r = await run(
      { team_ids: "9" },
      { "GET /teams/9": { id: 9, name: "Empty", members: [] } },
    );
    expect(r.calls).toEqual(["GET /teams/9"]);
    expect(codes(r)).toEqual(["team_has_no_members"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "scope.teams.9", retryable: false });
    expect(r.json.digest.scope.teams).toEqual([{ id: 9, name: "Empty" }]);
    expect(r.json.digest).toMatchObject({ issues: [], activities: [] });
  });

  it("401 は warning にせず投げ直す", async () => {
    const r = await run(
      { project_keys: "PROJ" },
      { "GET /projects/PROJ": () => jsonResponse({}, 401) },
    );
    expect(r.isError).toBe(true);
    expect(r.json.error.code).toBe("authentication_error");
  });
});

describe("digest_unified: ユーザー / チーム", () => {
  it("TestBuild_teamScope 相当: チームのメンバーを展開し、重複を除いて assigneeId[] にする。ユーザーごとに直列でアクティビティを取る", async () => {
    const r = await run(
      { team_ids: "7", user_ids: "2" },
      {
        "GET /teams/7": { id: 7, name: "Team", members: [user(1, "Alice"), user(2, "Bob")] },
        "GET /issues": [],
        "GET /users/2/activities": [],
        "GET /users/1/activities": [],
      },
    );
    expect(r.calls).toEqual([
      "GET /teams/7",
      "GET /issues?assigneeId[]=2&assigneeId[]=1&count=100&updatedSince=2026-10-20",
      "GET /users/2/activities?count=100",
      "GET /users/1/activities?count=100",
    ]);
    expect(r.json.digest.scope.users).toEqual([
      { id: 2, name: "Bob" },
      { id: 1, name: "Alice" },
    ]);
    expect(r.json.digest.scope.teams).toEqual([{ id: 7, name: "Team" }]);
    expect(r.json.digest.llm_hints.primary_entities).toEqual(["Bob", "Alice"]);
  });

  it("GetUser の失敗は user_fetch_failed の warning で、名前は user:<ID>。ID は分かっているので続行する", async () => {
    const r = await run(
      { user_ids: "5" },
      { "GET /users/5": err404, "GET /issues": [], "GET /users/5/activities": [] },
    );
    expect(codes(r)).toEqual(["user_fetch_failed"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "scope.users.5" });
    expect(r.json.digest.scope.users).toEqual([{ id: 5, name: "user:5" }]);
    expect(r.calls).toContain("GET /users/5/activities?count=100");
  });

  it("by_user: 課題の担当者と活動の実行者を ID ごとに数える。scope のユーザーは 0 件でも載せる(logvalet は常に空)", async () => {
    const r = await run(
      { user_ids: "1,2,3" },
      {
        "GET /users/1": user(1, "Alice"),
        "GET /users/2": user(2, "Bob"),
        "GET /users/3": user(3, "Carol"),
        "GET /issues": [
          issue({ key: "P-1", assignee: USER_A }),
          issue({ key: "P-2", assignee: USER_A }),
          issue({ key: "P-3", assignee: USER_B }),
          issue({ key: "P-4", assignee: null }),
        ],
        "GET /users/1/activities": [activity({ id: 9, created: hoursAgo(1), user: USER_A })],
        "GET /users/2/activities": [
          activity({ id: 8, created: hoursAgo(1), user: USER_B }),
          activity({ id: 7, created: hoursAgo(1), user: USER_B }),
        ],
        "GET /users/3/activities": [],
      },
    );
    expect(r.json.digest.summary.by_user).toEqual({
      "1": { issues: 2, activities: 1 },
      "2": { issues: 1, activities: 2 },
      "3": { issues: 0, activities: 0 },
    });
  });

  it("上限: user_ids 11 個以上 / team_ids 4 個以上 / project_keys 6 個以上 / issue_keys 21 個以上は argument_error(Backlog を呼ばない)", async () => {
    const csv = (n: number, f: (i: number) => string) =>
      Array.from({ length: n }, (_, i) => f(i + 1)).join(",");
    for (const args of [
      { user_ids: csv(11, String) },
      { team_ids: csv(4, String) },
      { project_keys: csv(6, (i) => `P${i}`) },
      { issue_keys: csv(21, (i) => `P-${i}`) },
    ]) {
      const r = await run(args, {});
      expect(r.json.error.code, JSON.stringify(args)).toBe("argument_error");
      expect(r.calls).toEqual([]);
    }
  });

  it("チーム展開後のユーザーが 10 人を超えたら、先頭 10 人だけにして users_truncated と truncated", async () => {
    const members = Array.from({ length: 12 }, (_, i) => user(i + 1, `U${i + 1}`));
    const respond: Record<string, unknown> = {
      "GET /teams/1": { id: 1, name: "Big", members },
      "GET /issues": [],
    };
    for (let i = 1; i <= 10; i++) respond[`GET /users/${i}/activities`] = [];
    const r = await run({ team_ids: "1" }, respond as Parameters<typeof callTool>[2]);
    expect(codes(r)).toEqual(["users_truncated"]);
    expect(r.json.digest.truncated).toBe(true);
    expect(r.json.digest.scope.users).toHaveLength(10);
    expect(r.calls.filter((c) => c.includes("/activities"))).toHaveLength(10);
  });

  it("user_ids は整数の CSV(数値以外は argument_error)", async () => {
    const r = await run({ user_ids: "1,a" }, {});
    expect(r.json.error.code).toBe("argument_error");
    expect(r.calls).toEqual([]);
  });
});

describe("digest_unified: 課題キー", () => {
  it("TestBuild_issueScope 相当: GetIssue を個別に呼び、アクティビティは課題キーのプロジェクト(重複なし)の分を取る。since / due の絞り込みは課題一覧に使わない", async () => {
    const r = await run(
      { issue_keys: "PROJ-1, OTH-2,PROJ-3" },
      {
        "GET /issues/PROJ-1": issue({ key: "PROJ-1" }),
        "GET /issues/OTH-2": issue({ key: "OTH-2" }),
        "GET /issues/PROJ-3": issue({ key: "PROJ-3", status: "完了" }),
        "GET /projects/PROJ/activities": [],
        "GET /projects/OTH/activities": [],
      },
    );
    expect(r.calls).toEqual([
      "GET /issues/PROJ-1",
      "GET /issues/OTH-2",
      "GET /issues/PROJ-3",
      "GET /projects/PROJ/activities?count=100",
      "GET /projects/OTH/activities?count=100",
    ]);
    expect(r.json.digest.scope.issues).toEqual(["PROJ-1", "OTH-2", "PROJ-3"]);
    expect(r.json.digest.summary.issue_count).toBe(3);
    expect(r.json.digest.summary.by_status).toEqual({ 未対応: 2, 完了: 1 });
  });

  it("GetIssue の失敗は issue_fetch_failed の warning で、取れた課題だけ返す", async () => {
    const r = await run(
      { issue_keys: "PROJ-1,PROJ-2" },
      {
        "GET /issues/PROJ-1": err404,
        "GET /issues/PROJ-2": issue({ key: "PROJ-2" }),
        "GET /projects/PROJ/activities": [],
      },
    );
    expect(codes(r)).toEqual(["issue_fetch_failed"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "issues.PROJ-1" });
    expect(r.json.digest.issues).toHaveLength(1);
  });

  it("優先順位: ユーザーが指定されていればアクティビティはユーザー単位(logvalet と同じ)", async () => {
    const r = await run(
      { issue_keys: "PROJ-1", user_ids: "1" },
      {
        "GET /users/1": user(1, "Alice"),
        "GET /issues/PROJ-1": issue({ key: "PROJ-1" }),
        "GET /users/1/activities": [],
      },
    );
    expect(r.calls.filter((c) => c.includes("/activities"))).toEqual([
      "GET /users/1/activities?count=100",
    ]);
  });
});

describe("digest_unified: 日付", () => {
  it("since は必須。形式と since > until は argument_error", async () => {
    for (const args of [
      { since: "" },
      { since: "2026/10/01" },
      { since: "2026-10-28", until: "2026-10-27" },
      { until: "2026-02-30" },
    ]) {
      const r = await callTool("logbutler_digest_unified", args, {}, { now: NOW });
      expect(r.json.error.code, JSON.stringify(args)).toBe("argument_error");
      expect(r.calls).toEqual([]);
    }
    const missing = await callTool("logbutler_digest_unified", {}, {}, { now: NOW });
    expect(missing.json.error.code).toBe("argument_error");
  });

  it("再現(until 指定): 期間内に入る前の新しい活動を飛ばして遡り、since に届いたら止まる。タイムゾーン引数で境界が変わる", async () => {
    // id 250 が 1 時間前 … id 1 が 250 時間前
    const stamped = (id: number) => activity({ id, created: hoursAgo(251 - id) });
    const respond = { "GET /issues": [], "GET /space/activities": activitiesDesc(250, stamped) };
    const jst = await run({ since: "2026-10-20", until: "2026-10-27" }, respond);
    expect(jst.json.digest.summary.activity_count).toBe(192);
    // UTC の 10/20 00:00 = 8 日 3 時間前(=195 時間前)→ id 56。UTC の 10/27 の終わり = 10/27T23:59:59.999Z → NOW の 3 時間 0 分前より古い = 251 - id ≥ 4 → id 247
    const utc = await run({ since: "2026-10-20", until: "2026-10-27", timezone: "UTC" }, respond);
    const ids = utc.json.digest.activities.map((a: { id: number }) => a.id);
    expect(ids[0]).toBe(247);
    expect(ids.at(-1)).toBe(56);
  });

  it("issue_list と同じ解釈の due_date / start_date(today / overdue / this-week / this-month / 日付 / 範囲)を課題一覧に渡す", async () => {
    const respond = { "GET /issues": [], "GET /space/activities": [] };
    const a = await run({ due_date: "overdue", start_date: "today" }, respond);
    expect(a.calls[0]).toBe(
      "GET /issues?count=100&dueDateUntil=2026-10-27&startDateSince=2026-10-28&startDateUntil=2026-10-28&updatedSince=2026-10-20",
    );
    const b = await run({ due_date: "2026-10-30", start_date: ":2026-10-31" }, respond);
    expect(b.calls[0]).toBe(
      "GET /issues?count=100&dueDateSince=2026-10-30&dueDateUntil=2026-10-30&startDateUntil=2026-10-31&updatedSince=2026-10-20",
    );
    const c = await run({ due_date: "this-month" }, respond);
    expect(c.calls[0]).toContain("dueDateSince=2026-10-01&dueDateUntil=2026-10-31");
  });

  it("due_date の不正な値は argument_error(Backlog を呼ばない)", async () => {
    const r = await run({ due_date: "next-year" }, {});
    expect(r.json.error.code).toBe("argument_error");
    expect(r.calls).toEqual([]);
  });
});

describe("digest_unified: ページングと部分失敗", () => {
  it("TestBuild_partialSuccess: 課題の取得に失敗しても warning で、アクティビティは返す", async () => {
    const r = await run({}, { "GET /issues": err503, "GET /space/activities": [recent(1)] });
    expect(r.isError, r.text).toBe(false);
    expect(codes(r)).toEqual(["issues_fetch_failed"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "issues", retryable: true });
    expect(r.json.digest.issues).toEqual([]);
    expect(r.json.digest.activities).toHaveLength(1);
  });

  it("アクティビティの取得失敗は warning(activities_fetch_failed)。取れた他のソースの分は残す", async () => {
    const r = await run(
      { user_ids: "1,2" },
      {
        "GET /users/1": user(1, "A"),
        "GET /users/2": user(2, "B"),
        "GET /issues": [],
        "GET /users/1/activities": err503,
        "GET /users/2/activities": [recent(5)],
      },
    );
    expect(codes(r)).toEqual(["activities_fetch_failed"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "activities", retryable: true });
    expect(r.json.warnings[0].message).toContain("user 1");
    expect(r.json.digest.activities.map((a: { id: number }) => a.id)).toEqual([5]);
  });

  it("課題が上限(10 ページ = 1,000 件)まで続いたら issues_truncated と truncated", async () => {
    const r = await run(
      {},
      {
        "GET /issues": (call: RecordedCall) =>
          jsonResponse(
            Array.from({ length: 100 }, (_, i) =>
              issue({
                key: `P-${Number(new URL(call.url).searchParams.get("offset") ?? 0) + i + 1}`,
              }),
            ),
          ),
        "GET /space/activities": [],
      },
    );
    expect(r.calls.filter((c) => c.startsWith("GET /issues"))).toHaveLength(10);
    expect(codes(r)).toEqual(["issues_truncated"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "issues", retryable: false });
    expect(r.json.digest.truncated).toBe(true);
    expect(r.json.digest.summary.issue_count).toBe(1000);
  });

  it("アクティビティが 1 ソースあたり 5 ページ(500 件)まで続いたら activities_truncated と truncated", async () => {
    const r = await run(
      {},
      {
        "GET /issues": [],
        "GET /space/activities": (call: RecordedCall) =>
          jsonResponse(endlessActivities((id) => activity({ id, created: hoursAgo(1) }))(call)),
      },
    );
    expect(r.calls.filter((c) => c.includes("/activities"))).toHaveLength(5);
    expect(codes(r)).toEqual(["activities_truncated"]);
    expect(r.json.digest.truncated).toBe(true);
    expect(r.json.digest.summary.activity_count).toBe(500);
  });

  it("再現: 100 件ちょうどのページの次へ maxId を進める(同じページを繰り返さない)。重複なしで 150 件", async () => {
    const r = await run(
      {},
      {
        "GET /issues": [],
        "GET /space/activities": activitiesDesc(150, (id) =>
          activity({ id, created: hoursAgo(1) }),
        ),
      },
    );
    expect(r.calls.filter((c) => c.includes("/activities"))).toEqual([
      "GET /space/activities?count=100",
      "GET /space/activities?count=100&maxId=50",
    ]);
    const ids = r.json.digest.activities.map((a: { id: number }) => a.id);
    expect(new Set(ids).size).toBe(150);
    expect(ids[0]).toBe(150);
  });
});

describe("digest_unified: API 呼び出しの最悪ケース", () => {
  it("maxApiCalls は 88 = チーム 3 + プロジェクト 5 + ユーザー 10 + max(課題 10 ページ, 課題キー 20) + アクティビティ 10 ソース × 5 ページ", () => {
    expect(digestUnified.maxApiCalls).toBe(88);
  });

  it("上限いっぱいの入力でも、アクティビティが尽きない状況で 88 回ちょうどで終わる(エラーにならない)", async () => {
    const endless = (call: RecordedCall) =>
      jsonResponse(endlessActivities((id) => activity({ id, created: hoursAgo(1) }))(call));
    const respond: Record<string, Respond> = {};
    const issueKeys: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const key = `K${(i % 5) + 1}-${i}`;
      issueKeys.push(key);
      respond[`GET /issues/${key}`] = issue({ key });
    }
    const projects = ["A", "B", "C", "D", "E"];
    projects.forEach((k, i) => {
      respond[`GET /projects/${k}`] = proj(i + 1, k);
    });
    for (let t = 1; t <= 3; t++) respond[`GET /teams/${t}`] = { id: t, name: `T${t}`, members: [] };
    const userIds: number[] = [];
    for (let u = 101; u <= 110; u++) {
      userIds.push(u);
      respond[`GET /users/${u}`] = user(u, `U${u}`);
      respond[`GET /users/${u}/activities`] = endless;
    }
    const r = await run(
      {
        team_ids: "1,2,3",
        project_keys: projects.join(","),
        user_ids: userIds.join(","),
        issue_keys: issueKeys.join(","),
      },
      respond,
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toHaveLength(3 + 5 + 10 + 20 + 10 * 5);
    expect(r.calls).toHaveLength(digestUnified.maxApiCalls as number);
    expect(r.json.digest.truncated).toBe(true);
  });
});
