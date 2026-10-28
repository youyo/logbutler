/** activity_digest / user_activity(logvalet `internal/digest/activity_test.go`、`internal/backlog/fetch_activities.go` から書き起こし + M05B の意図した変更)。 */
import { describe, expect, it } from "vitest";
import { activityDigest, userActivity } from "../../src/mcp/tools/digest";
import {
  activitiesDesc,
  activity,
  endlessActivities,
  iso,
  NOW,
  USER_A,
  USER_B,
} from "../helpers/analysis-fixtures";
import { jsonResponse, type RecordedCall } from "../helpers/mock-fetch";
import { callTool } from "../helpers/tool-call";

const codes = (r: { json: { warnings: { code: string }[] } }) => r.json.warnings.map((w) => w.code);
const err503 = () => jsonResponse({}, 503);
const hoursAgo = (h: number) => iso(new Date(NOW.getTime() - h * 3600_000));

describe("activity_digest", () => {
  const run = (
    args: Record<string, unknown>,
    respond: Parameters<typeof callTool>[2],
    tz = "Asia/Tokyo",
  ) => callTool("logbutler_activity_digest", args, respond, { now: NOW, timezone: tz });

  const sample = [
    activity({
      id: 3,
      type: 3,
      created: hoursAgo(1),
      user: USER_A,
      content: {
        id: 101,
        key: "PROJ-2",
        summary: "コメント付き課題",
        comment: { id: 999, content: "テストコメント" },
      },
    }),
    activity({
      id: 2,
      type: 1,
      created: hoursAgo(2),
      user: USER_B,
      content: { id: 100, key: "ABC-1", summary: "テスト課題" },
    }),
    activity({ id: 1, type: 5, created: hoursAgo(3), user: null, content: { name: "wiki page" } }),
  ];

  it("スペース全体: 1 回取得して type を名前にし、コメントを抽出し、プロジェクト別に集計する(Go の map と同じくキー昇順)", async () => {
    const r = await run({ limit: 10 }, { "GET /space/activities": sample });
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toEqual(["GET /space/activities?count=10"]);
    expect(r.json.resource).toBe("activity");
    expect(r.json.digest).toEqual({
      scope: { limit: 10 },
      activities: [
        {
          id: 3,
          type: "issue_commented",
          created: hoursAgo(1),
          actor: { id: 1, name: "Alice" },
          issue: { id: 101, key: "PROJ-2", summary: "コメント付き課題" },
          comment: { id: 999, content: "テストコメント" },
        },
        {
          id: 2,
          type: "issue_created",
          created: hoursAgo(2),
          actor: { id: 2, name: "Bob" },
          issue: { id: 100, key: "ABC-1", summary: "テスト課題" },
        },
        { id: 1, type: "wiki_created", created: hoursAgo(3) },
      ],
      comments: [
        {
          id: 999,
          content: "テストコメント",
          author: { id: 1, name: "Alice" },
          created: hoursAgo(1),
        },
      ],
      projects: {
        ABC: { activity_count: 1, comment_count: 0 },
        PROJ: { activity_count: 1, comment_count: 1 },
      },
      summary: {
        headline: "activity digest (3 items)",
        total_activity: 3,
        comment_count: 1,
        types: { issue_commented: 1, issue_created: 1, wiki_created: 1 },
        related_issue_keys: ["ABC-1", "PROJ-2"],
        related_project_keys: ["ABC", "PROJ"],
      },
      llm_hints: {
        primary_entities: ["ABC-1", "PROJ-2", "ABC", "PROJ"],
        open_questions: [],
        suggested_next_actions: [],
      },
      truncated: false,
    });
  });

  it("related_* の並びは API の返す順に依存せず昇順(logvalet は map の順で非決定的だった)", async () => {
    const a = (id: number, key: string) => activity({ id, type: 2, content: { id, key } });
    const r1 = await run({}, { "GET /space/activities": [a(3, "C-1"), a(2, "A-2"), a(1, "B-3")] });
    const r2 = await run({}, { "GET /space/activities": [a(1, "B-3"), a(3, "C-1"), a(2, "A-2")] });
    expect(r1.json.digest.summary.related_issue_keys).toEqual(["A-2", "B-3", "C-1"]);
    expect(r1.json.digest.summary.related_issue_keys).toEqual(
      r2.json.digest.summary.related_issue_keys,
    );
    expect(r1.json.digest.summary.related_project_keys).toEqual(["A", "B", "C"]);
  });

  it("project 指定: /projects/{key}/activities。headline にプロジェクトキー。scope.project を返す。既定の limit は 20", async () => {
    const r = await run({ project: "PROJ" }, { "GET /projects/PROJ/activities": [] });
    expect(r.calls).toEqual(["GET /projects/PROJ/activities?count=20"]);
    expect(r.json.digest.scope).toEqual({ project: "PROJ", limit: 20 });
    expect(r.json.digest.summary.headline).toBe("activity digest for project PROJ (0 items)");
    expect(r.json.digest).toMatchObject({ activities: [], comments: [], projects: {} });
  });

  it("project のパスをエスケープする", async () => {
    const r = await run({ project: "A/B" }, { "GET /projects/A%2FB/activities": [] });
    expect(r.calls).toEqual(["GET /projects/A%2FB/activities?count=20"]);
  });

  it("since / until を実際に絞り込みに使う(logvalet はエコーするだけだった)。until は当日を含む(JST 23:59:59.999 まで)", async () => {
    // NOW = 2026-10-28 12:00 JST。JST の 10/27 00:00 = 10/26 15:00Z、10/27 の終わり = 10/27 14:59:59.999Z
    const acts = [
      activity({ id: 5, created: "2026-10-27T15:00:00Z" }), // JST 10/28 00:00 → until より後
      activity({ id: 4, created: "2026-10-27T14:59:59Z" }), // 10/27 23:59:59 → 含む
      activity({ id: 3, created: "2026-10-26T15:00:00Z" }), // JST 10/27 00:00 → 含む(since 当日 00:00)
      activity({ id: 2, created: "2026-10-26T14:59:59Z" }), // since より前
    ];
    const r = await run(
      { since: "2026-10-27", until: "2026-10-27", limit: 100 },
      { "GET /space/activities": acts },
    );
    expect(r.json.digest.activities.map((a: { id: number }) => a.id)).toEqual([4, 3]);
    expect(r.json.digest.scope).toEqual({
      since: "2026-10-27T00:00:00+09:00",
      until: "2026-10-27T23:59:59.999+09:00",
      limit: 100,
    });
    expect(r.json.digest.summary.total_activity).toBe(2);
    // 取得は 1 回のまま(期間は取得後に絞る)
    expect(r.calls).toEqual(["GET /space/activities?count=100"]);
  });

  it("timezone 引数で期間の境界が変わる(UTC なら 10/27 00:00Z〜)", async () => {
    const acts = [
      activity({ id: 2, created: "2026-10-26T20:00:00Z" }),
      activity({ id: 1, created: "2026-10-27T01:00:00Z" }),
    ];
    const jst = await callTool(
      "logbutler_activity_digest",
      { since: "2026-10-27" },
      { "GET /space/activities": acts },
      { now: NOW },
    );
    expect(jst.json.digest.activities.map((a: { id: number }) => a.id)).toEqual([2, 1]);
    const utc = await callTool(
      "logbutler_activity_digest",
      { since: "2026-10-27", timezone: "UTC" },
      { "GET /space/activities": acts },
      { now: NOW },
    );
    expect(utc.json.digest.activities.map((a: { id: number }) => a.id)).toEqual([1]);
    expect(utc.json.digest.scope.since).toBe("2026-10-27T00:00:00Z");
  });

  it("truncated: 取得件数が limit に達したら true(古い活動が limit の外にある可能性)、満たなければ false。期間の since に届いていれば false", async () => {
    const acts = (n: number, base = 1) =>
      Array.from({ length: n }, (_, i) => activity({ id: 100 - i, created: hoursAgo(base + i) }));
    const full = await run({ limit: 3 }, { "GET /space/activities": acts(3) });
    expect(full.json.digest.truncated).toBe(true);
    const part = await run({ limit: 3 }, { "GET /space/activities": acts(2) });
    expect(part.json.digest.truncated).toBe(false);
    // limit 件取れたが、最も古いものが since より前なら期間の端まで届いているので false
    const reached = await run(
      { limit: 3, since: "2026-10-28" },
      { "GET /space/activities": acts(3, 12) },
    );
    expect(reached.json.digest.truncated).toBe(false);
    // 最も古いものがまだ since の内側なら true
    const inside = await run(
      { limit: 3, since: "2026-10-01" },
      { "GET /space/activities": acts(3) },
    );
    expect(inside.json.digest.truncated).toBe(true);
    // 警告は出さない(limit は呼び出し側の指定)
    expect(full.json.warnings).toEqual([]);
  });

  it("取得に失敗しても空の digest と warning を返す(部分成功)。401 は投げ直す", async () => {
    const r = await run({}, { "GET /space/activities": err503 });
    expect(r.isError, r.text).toBe(false);
    expect(codes(r)).toEqual(["activities_fetch_failed"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "activities", retryable: true });
    expect(r.json.digest.activities).toEqual([]);
    expect(r.json.digest.truncated).toBe(false);
    const auth = await run({}, { "GET /space/activities": () => jsonResponse({}, 401) });
    expect(auth.isError).toBe(true);
    expect(auth.json.error.code).toBe("authentication_error");
  });

  it("入力: limit は 1〜100、日付は YYYY-MM-DD、since > until は argument_error(Backlog を呼ばない)", async () => {
    for (const args of [
      { limit: 0 },
      { limit: 101 },
      { since: "2026/10/01" },
      { until: "2026-02-30" },
      { since: "2026-10-28", until: "2026-10-27" },
      { timezone: "Mars/Base" },
    ]) {
      const r = await run(args, {});
      expect(r.json.error.code, JSON.stringify(args)).toBe("argument_error");
      expect(r.calls).toEqual([]);
    }
  });

  it("API 呼び出しは 1 回(maxApiCalls=1)", () => {
    expect(activityDigest.maxApiCalls).toBe(1);
  });
});

describe("user_activity", () => {
  const run = (
    args: Record<string, unknown>,
    respond: Parameters<typeof callTool>[2],
    tz = "Asia/Tokyo",
  ) => callTool("logbutler_user_activity", args, respond, { now: NOW, timezone: tz });

  const stamped = (id: number) => activity({ id, created: hoursAgo(251 - id) });

  it("数値 ID・期間なし: limit(既定 20)だけを 1 回で取る。エンベロープ化して truncated を載せる(logvalet は配列だった)", async () => {
    const r = await run(
      { user_id: "5" },
      { "GET /users/5/activities": activitiesDesc(250, stamped) },
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toEqual(["GET /users/5/activities?count=20"]);
    expect(r.json).toMatchObject({
      schema_version: "1",
      resource: "user_activity",
      generated_at: NOW.toISOString(),
      warnings: [],
    });
    const d = r.json.digest;
    expect(d.user_id).toBe(5);
    expect(d.limit).toBe(20);
    expect(d.total_count).toBe(20);
    expect(d.activities).toHaveLength(20);
    // 活動は Backlog の生データのまま(camelCase)
    expect(d.activities[0]).toEqual(stamped(250));
    // limit に達した(続きがある可能性)ので true。ユーザー自身の limit なので警告は出さない
    expect(d.truncated).toBe(true);
    expect(r.json.warnings).toEqual([]);
  });

  it("limit に届かなければ truncated=false", async () => {
    const r = await run(
      { user_id: "5", limit: 30 },
      { "GET /users/5/activities": activitiesDesc(7, stamped) },
    );
    expect(r.json.digest.total_count).toBe(7);
    expect(r.json.digest.truncated).toBe(false);
  });

  it("limit が 100 を超えるときはページを重ねる(100 + 50)。maxId は直前のページの最後の id - 1", async () => {
    const r = await run(
      { user_id: "5", limit: 150 },
      { "GET /users/5/activities": activitiesDesc(250, stamped) },
    );
    expect(r.calls).toEqual([
      "GET /users/5/activities?count=100",
      "GET /users/5/activities?count=50&maxId=150",
    ]);
    expect(r.json.digest.total_count).toBe(150);
  });

  it("'me' は GetMyself で解決し、数値以外は argument_error(Backlog を呼ばない)", async () => {
    const me = await run(
      { user_id: "me", limit: 5 },
      { "GET /users/myself": { id: 42, userId: "me", name: "Me" }, "GET /users/42/activities": [] },
    );
    expect(me.calls).toEqual(["GET /users/myself", "GET /users/42/activities?count=5"]);
    expect(me.json.digest.user_id).toBe(42);
    const bad = await run({ user_id: "alice" }, {});
    expect(bad.json.error.code).toBe("argument_error");
    expect(bad.calls).toEqual([]);
  });

  it("activity_type_ids を activityTypeId[] で渡す。数値以外は argument_error", async () => {
    const r = await run(
      { user_id: "5", activity_type_ids: "1,3", limit: 5 },
      { "GET /users/5/activities": [] },
    );
    expect(r.calls).toEqual([
      "GET /users/5/activities?activityTypeId[]=1&activityTypeId[]=3&count=5",
    ]);
    const bad = await run({ user_id: "5", activity_type_ids: "a" }, {});
    expect(bad.json.error.code).toBe("argument_error");
  });

  it("期間指定: since に届くまで maxId で遡る。since は当日 00:00、until は当日 23:59:59.999(タイムゾーン基準)で、limit は適用しない(logvalet と同じ)", async () => {
    // id 250 が NOW の 1 時間前 … id 1 が 250 時間前。JST の 10/20 00:00 = 204 時間前 = id 47、10/27 の終わり = 13 時間前 = id 238
    const r = await run(
      { user_id: "5", since: "2026-10-20", until: "2026-10-27", limit: 5 },
      { "GET /users/5/activities": activitiesDesc(250, stamped) },
    );
    const ids = r.json.digest.activities.map((a: { id: number }) => a.id);
    expect(ids[0]).toBe(238);
    expect(ids.at(-1)).toBe(47);
    expect(ids).toHaveLength(192);
    expect(r.calls).toEqual([
      "GET /users/5/activities?count=100",
      "GET /users/5/activities?count=100&maxId=150",
      "GET /users/5/activities?count=100&maxId=50",
    ]);
    expect(r.json.digest).toMatchObject({
      since: "2026-10-20T00:00:00+09:00",
      until: "2026-10-27T23:59:59.999+09:00",
      truncated: false,
    });
    expect(r.json.digest.limit).toBeUndefined();
  });

  it("再現: 100 件ちょうどのページが続いても、同じページを繰り返さず次のページへ進む(カーソルは id - 1)。ちょうど 200 件で終わる", async () => {
    const r = await run(
      { user_id: "5", since: "2026-01-01" },
      {
        "GET /users/5/activities": activitiesDesc(200, (id) =>
          activity({ id, created: hoursAgo(1) }),
        ),
      },
    );
    // 1 ページ目が満杯(200..101)→ maxId=100 の 2 ページ目も満杯(100..1)→ カーソルが 0 になって終わる(3 回目は取りに行かない)
    expect(r.calls).toEqual([
      "GET /users/5/activities?count=100",
      "GET /users/5/activities?count=100&maxId=100",
    ]);
    expect(r.json.digest.total_count).toBe(200);
    expect(r.json.digest.truncated).toBe(false);
  });

  it("期間指定でもページ数に上限がある(10 ページ = 1,000 件)。超えたら truncated と activities_truncated(logvalet は上限なし)", async () => {
    const r = await run(
      { user_id: "5", since: "2026-01-01" },
      {
        "GET /users/5/activities": (call: RecordedCall) =>
          jsonResponse(endlessActivities((id) => activity({ id, created: hoursAgo(1) }))(call)),
      },
    );
    expect(r.calls).toHaveLength(10);
    expect(r.json.digest.total_count).toBe(1000);
    expect(r.json.digest.truncated).toBe(true);
    expect(codes(r)).toEqual(["activities_truncated"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "activities", retryable: false });
  });

  it("until より新しい活動ばかりが続いても 10 ページで止まる(無限ループしない)", async () => {
    const r = await run(
      { user_id: "5", since: "2026-09-01", until: "2026-09-15" },
      {
        "GET /users/5/activities": (call: RecordedCall) =>
          jsonResponse(endlessActivities((id) => activity({ id, created: hoursAgo(1) }))(call)),
      },
    );
    expect(r.calls).toHaveLength(10);
    expect(r.json.digest.total_count).toBe(0);
    expect(r.json.digest.truncated).toBe(true);
  });

  it("created のない活動は除く(logvalet と同じ)", async () => {
    const noCreated = { id: 3, type: 2, createdUser: USER_A, content: {} };
    const r = await run(
      { user_id: "5" },
      { "GET /users/5/activities": [noCreated, activity({ id: 2, created: hoursAgo(1) })] },
    );
    expect(r.json.digest.activities.map((a: { id: number }) => a.id)).toEqual([2]);
  });

  it("project は logvalet 同様に絞り込みに使わない。指定されたら project_filter_ignored の警告で知らせる(黙って無視しない)", async () => {
    const r = await run(
      { user_id: "5", project: "PROJ", limit: 5 },
      { "GET /users/5/activities": [] },
    );
    expect(codes(r)).toEqual(["project_filter_ignored"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "project", retryable: false });
  });

  it("取得に失敗したらツールエラー(必須の取得)", async () => {
    const r = await run({ user_id: "5" }, { "GET /users/5/activities": err503 });
    expect(r.isError).toBe(true);
    expect(r.json.error.code).toBe("api_error");
  });

  it("入力: user_id 必須、日付の形式、since > until、不正な timezone は argument_error", async () => {
    for (const args of [
      { user_id: "" },
      { user_id: "5", since: "10/01" },
      { user_id: "5", since: "2026-10-28", until: "2026-10-27" },
      { user_id: "5", timezone: "Mars/Base" },
    ]) {
      const r = await run(args, {});
      expect(r.json.error.code, JSON.stringify(args)).toBe("argument_error");
      expect(r.calls).toEqual([]);
    }
  });

  describe("API 呼び出しの最悪ケース", () => {
    it("maxApiCalls は 11(GetMyself 1 + アクティビティ 10 ページ)", () => {
      expect(userActivity.maxApiCalls).toBe(11);
    });
    it("'me' + 期間指定でページが上限まで続いても 11 回で止まる", async () => {
      const r = await run(
        { user_id: "me", since: "2026-01-01" },
        {
          "GET /users/myself": { id: 42, userId: "me", name: "Me" },
          "GET /users/42/activities": (call: RecordedCall) =>
            jsonResponse(endlessActivities((id) => activity({ id, created: hoursAgo(1) }))(call)),
        },
      );
      expect(r.calls).toHaveLength(11);
    });
  });
});
