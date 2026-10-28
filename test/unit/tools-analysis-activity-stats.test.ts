import { describe, expect, it } from "vitest";
import { activityStats } from "../../src/mcp/tools/analysis";
import {
  activitiesDesc,
  activity,
  ago,
  endlessActivities,
  iso,
  NOW,
  USER_A,
  USER_B,
} from "../helpers/analysis-fixtures";
import { callTool } from "../helpers/tool-call";

const run = (
  args: Record<string, unknown>,
  respond: Parameters<typeof callTool>[2],
  timezone = "Asia/Tokyo",
) => callTool("logbutler_activity_stats", args, respond, { now: NOW, timezone });
const at = (hoursFromNow: number) => iso(new Date(NOW.getTime() + hoursFromNow * 3600_000));
const act = (
  id: number,
  type: number,
  created: string,
  user: { id: number; userId?: string; name: string } | null = USER_A,
) => activity({ id, type, created, user });

describe("activity_stats: 取得", () => {
  it("scope 未指定は space。API は count=100 の 1 ページ(100 件未満なら終わり)", async () => {
    const r = await run({}, { "GET /space/activities": [act(1, 2, ago(1))] });
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toEqual(["GET /space/activities?count=100"]);
    expect(r.json.resource).toBe("activity_stats");
    expect(r.json.analysis).toMatchObject({ scope: "space", total_count: 1, truncated: false });
    expect(Object.keys(r.json.analysis)).not.toContain("scope_key");
  });

  it('scope=project は project_key、scope=user は user_id("me" は GetMyself で解決、数値はそのまま)', async () => {
    const p = await run(
      { scope: "project", project_key: "P" },
      { "GET /projects/P/activities": [] },
    );
    expect(p.calls).toEqual(["GET /projects/P/activities?count=100"]);
    expect(p.json.analysis.scope_key).toBe("P");

    const me = await run(
      { scope: "user", user_id: "me" },
      { "GET /users/myself": { id: 7, name: "Me" }, "GET /users/7/activities": [] },
    );
    expect(me.calls).toEqual(["GET /users/myself", "GET /users/7/activities?count=100"]);
    expect(me.json.analysis).toMatchObject({ scope: "user", scope_key: "me" });

    const n = await run({ scope: "user", user_id: "5" }, { "GET /users/5/activities": [] });
    expect(n.calls).toEqual(["GET /users/5/activities?count=100"]);
  });

  it("入力: 未知の scope、project で project_key なし、user で user_id なし・不正は argument_error(Backlog を呼ばない)", async () => {
    for (const args of [
      { scope: "team" },
      { scope: "project" },
      { scope: "user" },
      { scope: "user", user_id: "alice" },
      { since: "2026-13-01" },
      { since: "2026-10-28", until: "2026-10-27" },
    ]) {
      const r = await run(args, {});
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.json.error.code).toBe("argument_error");
      expect(r.calls).toEqual([]);
    }
  });

  it("maxId のカーソルで全件取る(250 件 = 3 ページ)。100 件ちょうどのページが続いても止まらない", async () => {
    const mk = (id: number) => act(id, 2, ago(1));
    const r = await run({}, { "GET /space/activities": activitiesDesc(250, mk) });
    expect(r.json.analysis.total_count).toBe(250);
    expect(r.calls).toEqual([
      "GET /space/activities?count=100",
      "GET /space/activities?count=100&maxId=150",
      "GET /space/activities?count=100&maxId=50",
    ]);
    const exact = await run({}, { "GET /space/activities": activitiesDesc(200, mk) });
    expect(exact.json.analysis.total_count).toBe(200);
    // 2 ページ目の最後の id が 1 なので、これより古いものはなく 3 ページ目は取らない。
    expect(exact.calls).toHaveLength(2);
  });

  it("期間: 既定は 7 日前〜今。since より古いアクティビティに届いたら止め、until より新しいものは数えない", async () => {
    const r = await run(
      {},
      {
        "GET /space/activities": [
          act(5, 2, at(1)), // 未来(until=now より新しい)
          act(4, 2, ago(1)),
          act(3, 2, ago(6, 23)),
          act(2, 2, ago(7, 1)), // since より古い
          act(1, 2, ago(8)),
        ],
      },
    );
    expect(r.json.analysis.total_count).toBe(2);
    expect(r.json.analysis).toMatchObject({
      since: "2026-10-21T12:00:00+09:00",
      until: "2026-10-28T12:00:00+09:00",
      date_range: { since: "2026-10-21T12:00:00+09:00", until: "2026-10-28T12:00:00+09:00" },
    });
  });

  it("日付指定: since は当日 00:00、until は当日 23:59:59.999(JST)。再現: logvalet は until の当日を落としていた", async () => {
    const r = await run(
      { since: "2026-10-20", until: "2026-10-27" },
      {
        "GET /space/activities": [
          act(5, 2, "2026-10-27T15:00:00Z"), // JST 10/28 00:00 → 除く
          act(4, 2, "2026-10-27T14:59:59Z"), // JST 10/27 23:59:59 → 含む
          act(3, 2, "2026-10-19T15:00:00Z"), // JST 10/20 00:00 → 含む
          act(2, 2, "2026-10-19T14:59:59Z"), // 除く(ここで止める)
          act(1, 2, "2026-10-01T00:00:00Z"),
        ],
      },
    );
    expect(r.json.analysis.total_count).toBe(2);
    expect(r.json.analysis.until).toBe("2026-10-27T23:59:59.999+09:00");
  });

  it("since に届いたらそれ以上ページを取らない", async () => {
    const mk = (id: number) => act(id, 2, iso(new Date(Date.UTC(2026, 9, 1) + id * 3600_000)));
    const r = await run(
      { since: "2026-10-06" },
      { "GET /space/activities": activitiesDesc(250, mk) },
    );
    expect(r.json.analysis.total_count).toBe(140);
    expect(r.calls).toHaveLength(2);
  });

  it("取得失敗は warning(activities_fetch_failed)にして空の統計を返す", async () => {
    const r = await run(
      { scope: "project", project_key: "P" },
      { "GET /projects/P/activities": new Response("{}", { status: 500 }) },
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.json.warnings[0]).toMatchObject({
      code: "activities_fetch_failed",
      component: "activities",
    });
    expect(r.json.analysis).toMatchObject({ total_count: 0, by_type: {}, top_active_actors: [] });
  });

  describe("API 呼び出し数(最悪ケース = 1 + 10)", () => {
    it("maxApiCalls は 11", () => {
      expect(activityStats.maxApiCalls).toBe(11);
    });
    it("space は上限 10 ページで止まり、truncated と activities_truncated の警告が出る", async () => {
      const r = await run(
        {},
        { "GET /space/activities": endlessActivities((id) => act(id, 2, ago(1))) },
      );
      expect(r.calls).toHaveLength(10);
      expect(r.json.analysis.truncated).toBe(true);
      expect(r.json.analysis.total_count).toBe(1000);
      expect(r.json.warnings).toEqual([
        {
          code: "activities_truncated",
          message:
            "Only the latest 1000 activities were aggregated (page limit reached). The statistics may be incomplete.",
          component: "activities",
          retryable: false,
        },
      ]);
    });
    it("user=me でも GetMyself を含めて 11 回で止まる", async () => {
      const r = await run(
        { scope: "user", user_id: "me" },
        {
          "GET /users/myself": { id: 7, name: "Me" },
          "GET /users/7/activities": endlessActivities((id) => act(id, 2, ago(1))),
        },
      );
      expect(r.calls).toHaveLength(11);
    });
  });
});

describe("activity_stats: 集計", () => {
  const sample = [
    // JST: 10/28 09:00(水)Alice type 3
    act(10, 3, "2026-10-28T00:00:00Z", USER_A),
    act(9, 3, "2026-10-28T00:30:00Z", USER_A),
    // JST: 10/27 01:30(火) Bob type 2。UTC では 10/26 16:30(月)
    act(8, 2, "2026-10-26T16:30:00Z", USER_B),
    act(7, 1, "2026-10-26T16:40:00Z", USER_B),
    // 投稿者なし
    act(6, 3, "2026-10-26T16:50:00Z", null),
  ];

  it("by_type(名前)/ by_actor(なければ unknown)/ by_date / by_hour は LOGBUTLER_TIMEZONE で集計する", async () => {
    const r = await run({}, { "GET /space/activities": sample });
    const a = r.json.analysis;
    expect(a.total_count).toBe(5);
    expect(a.by_type).toEqual({ issue_commented: 3, issue_updated: 1, issue_created: 1 });
    expect(a.by_actor).toEqual({ Alice: 2, Bob: 2, unknown: 1 });
    expect(a.by_date).toEqual({ "2026-10-28": 2, "2026-10-27": 3 });
    expect(a.by_hour).toEqual({ "9": 2, "1": 3 });
    expect(a.patterns.peak_hour).toBe(1);
    expect(a.patterns.peak_day_of_week).toBe("Tue"); // JST では火曜が 3 件
  });

  it("UTC では日付・時・曜日が変わる(UTC: 10/28 水 2 件、10/26 月 3 件)", async () => {
    const r = await run({}, { "GET /space/activities": sample }, "UTC");
    const a = r.json.analysis;
    expect(a.by_date).toEqual({ "2026-10-28": 2, "2026-10-26": 3 });
    expect(a.by_hour).toEqual({ "0": 2, "16": 3 });
    expect(a.patterns.peak_hour).toBe(16);
    expect(a.patterns.peak_day_of_week).toBe("Mon");
  });

  it("未知の type は unknown_<番号>", async () => {
    const r = await run({}, { "GET /space/activities": [act(1, 99, ago(1))] });
    expect(r.json.analysis.by_type).toEqual({ unknown_99: 1 });
  });

  it("top_active_actors / top_active_types: count 降順 → 名前昇順、ratio = count / total、top_n(既定 5)で切る", async () => {
    const users = ["Eve", "Dan", "Cat", "Bob", "Ann", "Zed", "Yan"].map((name, i) => ({
      id: i + 10,
      name,
    }));
    const acts = [
      ...users.map((u, i) => act(100 + i, 2, ago(1), u)), // 各 1 件
      act(200, 3, ago(1), users[0]), // Eve だけ 2 件
    ];
    const r = await run({}, { "GET /space/activities": acts });
    expect(r.json.analysis.top_active_actors).toEqual([
      { name: "Eve", count: 2, ratio: 2 / 8 },
      { name: "Ann", count: 1, ratio: 1 / 8 },
      { name: "Bob", count: 1, ratio: 1 / 8 },
      { name: "Cat", count: 1, ratio: 1 / 8 },
      { name: "Dan", count: 1, ratio: 1 / 8 },
    ]);
    expect(r.json.analysis.top_active_types).toEqual([
      { type: "issue_updated", count: 7, ratio: 7 / 8 },
      { type: "issue_commented", count: 1, ratio: 1 / 8 },
    ]);
    const two = await run({ top_n: 2 }, { "GET /space/activities": acts });
    expect(two.json.analysis.top_active_actors).toHaveLength(2);
    const zero = await run({ top_n: 0 }, { "GET /space/activities": acts });
    expect(zero.json.analysis.top_active_actors).toHaveLength(5);
  });

  it("concentration は上位 3 件の合計 / 全体", async () => {
    const acts = [
      ...Array.from({ length: 4 }, (_, i) => act(10 + i, 2, ago(1), { id: 1, name: "A" })),
      ...Array.from({ length: 3 }, (_, i) => act(20 + i, 3, ago(1), { id: 2, name: "B" })),
      ...Array.from({ length: 2 }, (_, i) => act(30 + i, 3, ago(1), { id: 3, name: "C" })),
      act(40, 3, ago(1), { id: 4, name: "D" }),
    ];
    const r = await run({}, { "GET /space/activities": acts });
    expect(r.json.analysis.patterns.actor_concentration).toBeCloseTo(9 / 10);
    expect(r.json.analysis.patterns.type_concentration).toBe(1); // 2 種類のみ → 全部
  });

  it("peak_hour の同数は小さい時間、peak_day_of_week の同数は日曜 → 土曜の若い方", async () => {
    // JST 10/27(火) 10:00 と 10/26(月) 08:00 が 1 件ずつ → peak_hour 8、曜日は Mon(1) < Tue(2)
    const r = await run(
      {},
      {
        "GET /space/activities": [
          act(2, 2, "2026-10-27T01:00:00Z"),
          act(1, 2, "2026-10-25T23:00:00Z"),
        ],
      },
    );
    expect(r.json.analysis.patterns).toMatchObject({ peak_hour: 8, peak_day_of_week: "Mon" });
  });

  it("0 件: patterns はゼロ値、top は空", async () => {
    const r = await run({}, { "GET /space/activities": [] });
    expect(r.json.analysis).toMatchObject({
      total_count: 0,
      by_type: {},
      by_actor: {},
      by_date: {},
      by_hour: {},
      top_active_actors: [],
      top_active_types: [],
      patterns: {
        peak_hour: 0,
        peak_day_of_week: "",
        actor_concentration: 0,
        type_concentration: 0,
      },
    });
  });
});
