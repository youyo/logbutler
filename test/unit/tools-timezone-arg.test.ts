/**
 * `timezone` 引数(M05.5): 日付を解釈するツールだけに付く。IANA 名で、省略時は Asia/Tokyo(コード内の定数)。
 * 不正な名前はクライアント由来なので generic_error ではなく argument_error。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEZONE } from "../../src/mcp/registry";
import { ALL_TOOLS } from "../../src/mcp/tools";
import { activity, comment, NOW } from "../helpers/analysis-fixtures";
import { callTool } from "../helpers/tool-call";

/** timezone 引数を持つべきツールと、呼ぶのに最低限必要な引数・モック。 */
const TZ_TOOLS: Record<
  string,
  { args: Record<string, unknown>; respond: Record<string, unknown> }
> = {
  logbutler_issue_list: { args: { due_date: "today" }, respond: { "GET /issues": [] } },
  logbutler_my_tasks: {
    args: {},
    respond: {
      "GET /users/myself": { id: 1, userId: "a", name: "A" },
      "GET /issues": [],
      "GET /users/1/watchings": [],
    },
  },
  logbutler_digest_daily: {
    args: { project_key: "P" },
    respond: { "GET /projects/P": { id: 10 }, "GET /issues": [] },
  },
  logbutler_digest_weekly: {
    args: { project_key: "P" },
    respond: { "GET /projects/P": { id: 10 }, "GET /issues": [] },
  },
  logbutler_activity_stats: { args: {}, respond: { "GET /space/activities": [] } },
  logbutler_issue_timeline: {
    args: { issue_key: "P-1" },
    respond: {
      "GET /issues/P-1": { id: 5000, issueKey: "P-1", summary: "s" },
      "GET /issues/P-1/comments": [],
      "GET /projects/P/activities": [],
    },
  },
};

describe("timezone 引数", () => {
  it("既定値はコード内の定数 Asia/Tokyo", () => {
    expect(DEFAULT_TIMEZONE).toBe("Asia/Tokyo");
  });

  it("日付を解釈する 6 ツールだけが、任意の文字列引数 timezone を持つ", () => {
    const withTz = ALL_TOOLS.filter((t) => "timezone" in t.inputSchema.shape).map((t) => t.name);
    expect(withTz.sort()).toEqual(Object.keys(TZ_TOOLS).sort());
    for (const t of ALL_TOOLS.filter((t) => withTz.includes(t.name))) {
      const json = JSON.parse(JSON.stringify(t.inputSchema.toJSONSchema())) as {
        properties: { timezone: { type: string; description: string } };
        required?: string[];
      };
      expect(json.properties.timezone.type, t.name).toBe("string");
      expect(json.properties.timezone.description, t.name).toContain("Asia/Tokyo");
      expect(json.required ?? [], t.name).not.toContain("timezone");
    }
  });

  for (const [name, { args, respond }] of Object.entries(TZ_TOOLS)) {
    it(`${name}: 存在しない名前は argument_error で、Backlog は呼ばない`, async () => {
      const r = await callTool(name, { ...args, timezone: "Mars/Base" }, respond as never, {
        now: NOW,
      });
      expect(r.isError).toBe(true);
      expect(r.json.error.code).toBe("argument_error");
      expect(r.json.error.message).toContain("timezone");
      expect(r.json.error.message).toContain("Mars/Base");
      expect(r.calls).toEqual([]);
    });

    it(`${name}: 空文字・IANA 名でない値も argument_error`, async () => {
      for (const bad of ["", "JST+9", "not a zone"]) {
        const r = await callTool(name, { ...args, timezone: bad }, respond as never, { now: NOW });
        expect(r.json.error?.code, `${name} ${JSON.stringify(bad)}`).toBe("argument_error");
      }
    });
  }

  it("issue_list: 引数の timezone が「今日」を決める(15:30 UTC は東京では翌日)", async () => {
    const now = new Date("2026-10-28T15:30:00Z");
    const call = (tz?: string) =>
      callTool(
        "logbutler_issue_list",
        { due_date: "today", ...(tz ? { timezone: tz } : {}) },
        { "GET /issues": [] },
        { now },
      );
    expect((await call()).calls).toEqual([
      "GET /issues?dueDateSince=2026-10-29&dueDateUntil=2026-10-29",
    ]);
    expect((await call("UTC")).calls).toEqual([
      "GET /issues?dueDateSince=2026-10-28&dueDateUntil=2026-10-28",
    ]);
    expect((await call("America/Los_Angeles")).calls).toEqual([
      "GET /issues?dueDateSince=2026-10-28&dueDateUntil=2026-10-28",
    ]);
  });

  it("引数は deps の既定より優先する(deps は呼び出し側が与える既定)", async () => {
    const now = new Date("2026-10-28T15:30:00Z");
    const r = await callTool(
      "logbutler_issue_list",
      { due_date: "today", timezone: "Asia/Tokyo" },
      { "GET /issues": [] },
      { now, timezone: "UTC" },
    );
    expect(r.calls).toEqual(["GET /issues?dueDateSince=2026-10-29&dueDateUntil=2026-10-29"]);
  });

  it("my_tasks: 引数の timezone で週の境界と date_range のオフセットが変わる", async () => {
    const now = new Date("2026-10-28T16:30:00Z");
    const call = (tz?: string) =>
      callTool(
        "logbutler_my_tasks",
        tz ? { timezone: tz } : {},
        TZ_TOOLS.logbutler_my_tasks?.respond as never,
        { now },
      );
    expect((await call("UTC")).json.analysis.date_range.since).toBe("2026-10-26T00:00:00Z");
    expect((await call()).json.analysis.date_range.since).toBe("2026-10-26T00:00:00+09:00");
  });

  it("digest: 引数の timezone で既定の期間(updatedSince / updatedUntil)の暦日が変わる", async () => {
    const now = new Date("2026-10-28T15:30:00Z");
    const range = async (tool: string, tz?: string) => {
      const { args, respond } = TZ_TOOLS[tool] ?? { args: {}, respond: {} };
      const r = await callTool(
        tool,
        { ...args, ...(tz ? { timezone: tz } : {}) },
        respond as never,
        {
          now,
        },
      );
      const q = new URL(`https://x/${r.calls[1]}`.replace(" ", "")).searchParams;
      return [q.get("updatedSince"), q.get("updatedUntil")];
    };
    expect(await range("logbutler_digest_daily")).toEqual(["2026-10-28", "2026-10-29"]);
    expect(await range("logbutler_digest_daily", "UTC")).toEqual(["2026-10-27", "2026-10-28"]);
    expect(await range("logbutler_digest_weekly", "UTC")).toEqual(["2026-10-21", "2026-10-28"]);
  });

  it("activity_stats: 引数の timezone で by_hour の時刻が変わる(15:30 UTC は東京では 0 時台)", async () => {
    const now = new Date("2026-10-28T15:30:00Z");
    const created = "2026-10-28T15:10:00Z";
    const hours = async (tz?: string) => {
      const r = await callTool(
        "logbutler_activity_stats",
        tz ? { timezone: tz } : {},
        { "GET /space/activities": [activity({ id: 1, type: 2, created })] },
        { now },
      );
      return Object.keys(r.json.analysis.by_hour);
    };
    expect(await hours()).toEqual(["0"]);
    expect(await hours("UTC")).toEqual(["15"]);
  });

  it("issue_timeline: 引数の timezone で since の日付境界が変わる", async () => {
    const respond = {
      "GET /issues/P-1": { id: 5000, issueKey: "P-1", summary: "s" },
      "GET /issues/P-1/comments": [
        comment({ id: 1, created: "2026-10-28T16:00:00Z" }), // 東京では 10/29 01:00
      ],
      "GET /projects/P/activities": [],
    };
    const count = async (tz: string) =>
      (
        await callTool(
          "logbutler_issue_timeline",
          { issue_key: "P-1", since: "2026-10-29", timezone: tz },
          respond,
          { now: new Date("2026-10-30T00:00:00Z") },
        )
      ).json.analysis.events.length;
    expect(await count("Asia/Tokyo")).toBe(1);
    expect(await count("UTC")).toBe(0);
  });
});
