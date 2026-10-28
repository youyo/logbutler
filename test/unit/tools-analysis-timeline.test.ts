import { describe, expect, it } from "vitest";
import { issueTimeline } from "../../src/mcp/tools/analysis";
import {
  activitiesDesc,
  activity,
  ago,
  comment,
  commentsDesc,
  endlessActivities,
  endlessComments,
  iso,
  issue,
  NOW,
  USER_A,
  USER_B,
} from "../helpers/analysis-fixtures";
import { callTool } from "../helpers/tool-call";

const ISSUE_ID = 5000;
const target = issue({ key: "P-1", id: ISSUE_ID, summary: "対象の課題" });
const run = (args: Record<string, unknown>, respond: Parameters<typeof callTool>[2]) =>
  callTool(
    "logbutler_issue_timeline",
    { issue_key: "P-1", ...args },
    {
      "GET /issues/P-1": target,
      "GET /issues/P-1/comments": [],
      "GET /projects/P/activities": [],
      ...respond,
    },
    { now: NOW, timezone: "Asia/Tokyo" },
  );

const act = (
  id: number,
  type: number,
  created: string,
  extra: Record<string, unknown> = {},
  user = USER_A,
) => activity({ id, type, created, user, content: { id: ISSUE_ID, key_id: 1, ...extra } });
const events = (r: { json: { analysis: { events: { kind: string; id: number }[] } } }) =>
  r.json.analysis.events.map((e) => `${e.kind}:${e.id}`);

describe("issue_timeline", () => {
  it("API は GetIssue → コメント → プロジェクトのアクティビティ(種別 1,2,14 に絞る)の順に直列", async () => {
    const r = await run({}, {});
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toEqual([
      "GET /issues/P-1",
      "GET /issues/P-1/comments?count=100",
      "GET /projects/P/activities?activityTypeId[]=1&activityTypeId[]=2&activityTypeId[]=14&count=100",
    ]);
    expect(r.json.resource).toBe("issue_timeline");
    expect(r.json.analysis).toMatchObject({
      issue_key: "P-1",
      issue_summary: "対象の課題",
      events: [],
      meta: { total_events: 0, comment_count: 0, update_count: 0, participant_count: 0 },
      truncated: false,
    });
  });

  it("コメント・作成・更新を時系列の昇順にまとめる。項目と changes", async () => {
    const r = await run(
      {},
      {
        "GET /issues/P-1/comments": [
          comment({
            id: 20,
            content: "後のコメント",
            user: USER_B,
            created: "2026-10-20T00:00:00Z",
          }),
          comment({ id: 10, content: "最初のコメント", created: "2026-10-10T00:00:00Z" }),
        ],
        "GET /projects/P/activities": [
          act(300, 2, "2026-10-15T00:00:00Z", {
            changes: [
              { field: "status", old_value: "1", new_value: "2", type: "standard" },
              { field: "assigner", new_value: "Bob" },
            ],
          }),
          act(200, 1, "2026-10-01T00:00:00Z"),
          act(400, 14, "2026-10-18T00:00:00Z"),
        ],
      },
    );
    expect(events(r)).toEqual([
      "created:200",
      "comment:10",
      "update:300",
      "update:400",
      "comment:20",
    ]);
    const [created, c10, u300, u400, c20] = r.json.analysis.events;
    expect(created).toEqual({
      id: 200,
      kind: "created",
      activity_type: "issue_created",
      timestamp: "2026-10-01T00:00:00Z",
      actor: { id: 1, name: "Alice" },
    });
    expect(c10).toEqual({
      id: 10,
      kind: "comment",
      timestamp: "2026-10-10T00:00:00Z",
      actor: { id: 1, name: "Alice" },
      content: "最初のコメント",
    });
    expect(u300).toMatchObject({
      activity_type: "issue_updated",
      changes: [
        { field: "status", old_value: "1", new_value: "2" },
        { field: "assigner", new_value: "Bob" },
      ],
    });
    expect(u400.activity_type).toBe("issue_multi_updated");
    expect(c20.actor).toEqual({ id: 2, name: "Bob" });
    expect(r.json.analysis.meta).toEqual({
      total_events: 5,
      comment_count: 2,
      update_count: 3,
      participant_count: 2,
    });
  });

  it("他の課題のアクティビティ(content.id が違う)と、種別 1,2,14 以外は含めない", async () => {
    const r = await run(
      {},
      {
        "GET /projects/P/activities": [
          act(1, 2, ago(3)),
          activity({ id: 2, type: 2, created: ago(3), content: { id: 9999 } }),
          activity({ id: 3, type: 2, created: ago(3), content: {} }),
          act(4, 3, ago(3)),
        ],
      },
    );
    expect(events(r)).toEqual(["update:1"]);
  });

  it("同時刻は created → update → comment の順、同じ種別は id の昇順", async () => {
    const t = "2026-10-10T00:00:00Z";
    const r = await run(
      {},
      {
        "GET /issues/P-1/comments": [
          comment({ id: 7, created: t }),
          comment({ id: 3, created: t }),
        ],
        "GET /projects/P/activities": [act(9, 2, t), act(8, 1, t), act(5, 2, t)],
      },
    );
    expect(events(r)).toEqual(["created:8", "update:5", "update:9", "comment:3", "comment:7"]);
  });

  it("changes が配列でなければ activity_changes_parse_failed の warning(イベントは残す)", async () => {
    const r = await run(
      {},
      { "GET /projects/P/activities": [act(1, 2, ago(2), { changes: "oops" })] },
    );
    expect(events(r)).toEqual(["update:1"]);
    expect(Object.keys(r.json.analysis.events[0])).not.toContain("changes");
    expect(r.json.warnings).toEqual([
      {
        code: "activity_changes_parse_failed",
        message: "failed to parse changes for activity id=1",
        component: "events",
        retryable: false,
      },
    ]);
  });

  it("include_updates=false ならアクティビティを呼ばない", async () => {
    const r = await run(
      { include_updates: false },
      { "GET /issues/P-1/comments": [comment({ id: 1 })] },
    );
    expect(r.calls.some((c) => c.includes("activities"))).toBe(false);
    expect(events(r)).toEqual(["comment:1"]);
  });

  describe("コメント", () => {
    it("max_comments=0(未指定)は上限まで全件(130 件すべて)。再現: logvalet は 20 件しか取っていなかった", async () => {
      const r = await run({}, { "GET /issues/P-1/comments": commentsDesc(130) });
      expect(r.json.analysis.meta.comment_count).toBe(130);
      expect(r.calls.filter((c) => c.includes("/comments"))).toEqual([
        "GET /issues/P-1/comments?count=100",
        "GET /issues/P-1/comments?count=100&maxId=30",
      ]);
      const zero = await run(
        { max_comments: 0 },
        { "GET /issues/P-1/comments": commentsDesc(130) },
      );
      expect(zero.json.analysis.meta.comment_count).toBe(130);
    });

    it("max_comments=N は新しい方から N 件(出力は時系列の昇順)", async () => {
      const make = (id: number) =>
        comment({ id, created: iso(new Date(Date.UTC(2026, 9, 1) + id * 3600_000)) });
      const r = await run(
        { max_comments: 3 },
        { "GET /issues/P-1/comments": commentsDesc(10, make) },
      );
      expect(events(r)).toEqual(["comment:8", "comment:9", "comment:10"]);
    });
  });

  describe("since / until(until は当日を含める)", () => {
    const make = (id: number) =>
      comment({ id, created: iso(new Date(Date.UTC(2026, 9, 1) + id * 3600_000)) });

    it("期間外のコメントとアクティビティを除く。until は JST の当日 23:59:59.999 まで", async () => {
      const r = await run(
        { since: "2026-10-10", until: "2026-10-12" },
        {
          "GET /issues/P-1/comments": [
            comment({ id: 4, created: "2026-10-12T14:59:59Z" }), // JST 10/12 23:59:59 → 含む
            comment({ id: 3, created: "2026-10-12T15:00:00Z" }), // JST 10/13 00:00 → 除く
            comment({ id: 2, created: "2026-10-09T15:00:00Z" }), // JST 10/10 00:00 → 含む
            comment({ id: 1, created: "2026-10-09T14:59:59Z" }), // 除く
          ],
          "GET /projects/P/activities": [
            act(30, 2, "2026-10-12T15:30:00Z"),
            act(20, 2, "2026-10-11T00:00:00Z"),
            act(10, 2, "2026-10-09T00:00:00Z"),
          ],
        },
      );
      expect(events(r)).toEqual(["comment:2", "update:20", "comment:4"]);
    });

    it("コメントは新しい順なので、since より古いものに届いたらそれ以上ページを取らない", async () => {
      // created = 2026-10-01T00:00Z + id 時間。since 10/06(JST)= 10/05T15:00Z → id >= 111 が対象。
      const r = await run(
        { since: "2026-10-06", include_updates: false },
        { "GET /issues/P-1/comments": commentsDesc(250, make) },
      );
      expect(r.json.analysis.meta.comment_count).toBe(140);
      expect(r.calls.filter((c) => c.includes("/comments"))).toHaveLength(2);
      expect(r.json.analysis.truncated).toBe(false);
    });

    it("アクティビティも since より古いものに届いたら止める", async () => {
      const mk = (id: number) => act(id, 2, iso(new Date(Date.UTC(2026, 9, 1) + id * 3600_000)));
      const r = await run(
        { since: "2026-10-06" },
        { "GET /projects/P/activities": activitiesDesc(250, mk) },
      );
      expect(r.json.analysis.meta.update_count).toBe(140);
      expect(r.calls.filter((c) => c.includes("/activities"))).toHaveLength(2);
    });

    it("不正な日付・since > until は argument_error", async () => {
      for (const args of [{ since: "10/01" }, { since: "2026-10-12", until: "2026-10-11" }]) {
        const r = await run(args, {});
        expect(r.json.error.code).toBe("argument_error");
        expect(r.calls).toEqual([]);
      }
    });
  });

  describe("アクティビティのページング", () => {
    const mk = (id: number) => act(id, 2, ago(2));

    it("max_activity_pages 既定は 5。続きがあれば truncated と activity_pagination_truncated を出す", async () => {
      const r = await run({}, { "GET /projects/P/activities": endlessActivities(mk) });
      expect(r.calls.filter((c) => c.includes("/activities"))).toHaveLength(5);
      expect(r.json.analysis.truncated).toBe(true);
      expect(r.json.warnings).toEqual([
        {
          code: "activity_pagination_truncated",
          message: "activity fetch truncated at 5 pages (500 activities)",
          component: "events",
          retryable: false,
        },
      ]);
    });

    it("max_activity_pages を指定できる(1〜10。0 以下は既定、11 以上は argument_error)", async () => {
      const three = await run(
        { max_activity_pages: 3 },
        { "GET /projects/P/activities": endlessActivities(mk) },
      );
      expect(three.calls.filter((c) => c.includes("/activities"))).toHaveLength(3);
      const def = await run(
        { max_activity_pages: 0 },
        { "GET /projects/P/activities": endlessActivities(mk) },
      );
      expect(def.calls.filter((c) => c.includes("/activities"))).toHaveLength(5);
      const over = await run({ max_activity_pages: 11 }, {});
      expect(over.json.error.code).toBe("argument_error");
    });

    it("ページがちょうど満杯で次が空なら truncated にしない", async () => {
      const r = await run({}, { "GET /projects/P/activities": activitiesDesc(100, mk) });
      expect(r.json.analysis.truncated).toBe(false);
    });
  });

  it("コメント・アクティビティの取得失敗は warning(comments_fetch_failed / activities_fetch_failed)。課題が取れなければツールエラー", async () => {
    const err = (status: number) =>
      new Response(JSON.stringify({ errors: [{ message: "x", code: 1 }] }), { status });
    const r = await run(
      {},
      { "GET /issues/P-1/comments": err(500), "GET /projects/P/activities": err(503) },
    );
    expect(r.isError, r.text).toBe(false);
    expect(
      r.json.warnings.map((w: { code: string; component: string }) => [w.code, w.component]),
    ).toEqual([
      ["comments_fetch_failed", "events"],
      ["activities_fetch_failed", "events"],
    ]);
    const nf = await run({}, { "GET /issues/P-1": err(404) });
    expect(nf.json.error.code).toBe("not_found");
  });

  describe("API 呼び出し数(最悪ケース = 1 + 10 + 10)", () => {
    it("maxApiCalls は 21", () => {
      expect(issueTimeline.maxApiCalls).toBe(21);
    });
    it("コメントが上限まで続き、max_activity_pages=10 でも 21 回で止まる", async () => {
      const r = await run(
        { max_activity_pages: 10, max_response_tokens: 0 }, // 呼び出し回数の上限を調べるテスト。応答サイズの安全網(M06)は別のテストで見るので外す
        {
          "GET /issues/P-1/comments": endlessComments(),
          "GET /projects/P/activities": endlessActivities((id) => act(id, 2, ago(2))),
        },
      );
      expect(r.isError, r.text).toBe(false);
      expect(r.calls).toHaveLength(21);
      expect(r.json.analysis.truncated).toBe(true);
      expect(r.json.warnings.map((w: { code: string }) => w.code)).toEqual([
        "comments_truncated",
        "activity_pagination_truncated",
      ]);
    });
  });
});
