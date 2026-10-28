import { afterEach, describe, expect, it, vi } from "vitest";
import { analysisEnvelope, llmHints, warningFromError } from "../../src/analysis/envelope";
import { fetchProjectIssues, ISSUE_CAP, PROJECT_ISSUE_CALLS } from "../../src/analysis/issues";
import { DONE_STATUSES, excludeSetFrom } from "../../src/analysis/statuses";
import { BacklogUnauthorizedError, createBacklogClient } from "../../src/backlog/client";
import { BacklogApiError } from "../../src/backlog/errors";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";
import { describeCall } from "../helpers/tool-call";

afterEach(() => vi.restoreAllMocks());

describe("analysis/envelope", () => {
  const ctx = { now: () => new Date("2026-10-28T03:04:05Z"), spaceHost: "example.backlog.com" };

  it("AnalysisEnvelope: schema_version / resource / generated_at(ctx.now) / profile / space / base_url / warnings / analysis", () => {
    const env = analysisEnvelope(ctx, "stale_issues", { total_count: 0 });
    expect(Object.keys(env)).toEqual([
      "schema_version",
      "resource",
      "generated_at",
      "profile",
      "space",
      "base_url",
      "warnings",
      "analysis",
    ]);
    expect(env).toMatchObject({
      schema_version: "1",
      resource: "stale_issues",
      generated_at: "2026-10-28T03:04:05.000Z",
      profile: "",
      space: "example",
      base_url: "https://example.backlog.com",
      warnings: [],
      analysis: { total_count: 0 },
    });
  });

  it("warnings は渡した順のまま入る", () => {
    const w = [
      { code: "a", message: "m", retryable: false },
      { code: "b", message: "n", component: "c", retryable: true },
    ];
    expect(analysisEnvelope(ctx, "x", {}, w).warnings).toEqual(w);
  });

  it("llmHints: 3 つの配列は空でも [] で出す", () => {
    expect(llmHints()).toEqual({
      primary_entities: [],
      open_questions: [],
      suggested_next_actions: [],
    });
    expect(llmHints(["project:P"], ["q"], ["a"])).toEqual({
      primary_entities: ["project:P"],
      open_questions: ["q"],
      suggested_next_actions: ["a"],
    });
  });

  describe("warningFromError", () => {
    it("Backlog のエラーは warning にする(message に Backlog のエラー文、retryable はエラーに従う)", () => {
      const w = warningFromError(
        new BacklogApiError(404, { backlogCode: 6, backlogMessage: "No such project." }),
        "project_fetch_failed",
        "failed to get project PROJ",
        "project",
      );
      expect(w).toEqual({
        code: "project_fetch_failed",
        message:
          "failed to get project PROJ: Backlog API error (HTTP 404, code=6): No such project.",
        component: "project",
        retryable: false,
      });
      expect(warningFromError(new BacklogApiError(503), "x", "p", "c").retryable).toBe(true);
    });
    it("401 と Backlog 以外の例外は握りつぶさず投げ直す", () => {
      expect(() => warningFromError(new BacklogUnauthorizedError(), "x", "p", "c")).toThrow(
        BacklogUnauthorizedError,
      );
      expect(() => warningFromError(new TypeError("bug"), "x", "p", "c")).toThrow(TypeError);
    });
  });
});

describe("analysis/statuses: 完了集合", () => {
  it("既定は {完了, 対応済み, Closed, Done, Resolved}", () => {
    expect([...DONE_STATUSES].sort()).toEqual(
      ["Closed", "Done", "Resolved", "完了", "対応済み"].sort(),
    );
    const set = excludeSetFrom(undefined);
    for (const s of ["完了", "対応済み", "Closed", "Done", "Resolved"])
      expect(set.has(s)).toBe(true);
    expect(set.has("処理中")).toBe(false);
  });
  it("exclude_status が指定されたらそれだけ(既定は足さない)。空要素は捨てる", () => {
    const set = excludeSetFrom("保留, 完了,,");
    expect([...set].sort()).toEqual(["保留", "完了"].sort());
    expect(set.has("Closed")).toBe(false);
    expect(excludeSetFrom("").has("Closed")).toBe(true);
    expect(excludeSetFrom(" , ").has("Closed")).toBe(true);
  });
});

describe("analysis/issues: 課題の全件取得", () => {
  const API = "https://example.backlog.com/api/v2";
  const client = () =>
    createBacklogClient({ spaceHost: "example.backlog.com", accessToken: "tok" });
  const issuesOf = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ id: from + i + 1, issueKey: `P-${from + i + 1}` }));

  it("20 件より多い課題を全件取る(logvalet は Backlog 既定の 20 件で打ち切っていた)", async () => {
    const m = mockOutboundFetch({
      [`GET ${API}/projects/P`]: () => jsonResponse({ id: 10 }),
      [`GET ${API}/issues`]: (call) => {
        const offset = Number(new URL(call.url).searchParams.get("offset") ?? 0);
        return jsonResponse(issuesOf(Math.min(100, 250 - offset), offset));
      },
    });
    const r = await fetchProjectIssues(client(), "P");
    expect(r.issues).toHaveLength(250);
    expect(r.issues[249]?.issueKey).toBe("P-250");
    expect(r).toMatchObject({ truncated: false, failed: false, warnings: [] });
    expect(m.calls.map(describeCall)).toEqual([
      "GET /projects/P",
      "GET /issues?count=100&projectId[]=10",
      "GET /issues?count=100&offset=100&projectId[]=10",
      "GET /issues?count=100&offset=200&projectId[]=10",
    ]);
  });

  it("ちょうど 100 件のページが続く場合は次のページも取る(100 件で止めない)", async () => {
    const m = mockOutboundFetch({
      [`GET ${API}/projects/P`]: () => jsonResponse({ id: 10 }),
      [`GET ${API}/issues`]: (call) => {
        const offset = Number(new URL(call.url).searchParams.get("offset") ?? 0);
        return jsonResponse(offset < 200 ? issuesOf(100, offset) : []);
      },
    });
    const r = await fetchProjectIssues(client(), "P");
    expect(r.issues).toHaveLength(200);
    expect(r.truncated).toBe(false);
    expect(m.calls).toHaveLength(1 + 3);
  });

  it("上限(10 ページ = 1,000 件)で止め、truncated と issues_truncated の warning を返す。呼び出しは 11 回", async () => {
    expect(ISSUE_CAP).toBe(1000);
    expect(PROJECT_ISSUE_CALLS).toBe(11);
    const m = mockOutboundFetch({
      [`GET ${API}/projects/P`]: () => jsonResponse({ id: 10 }),
      [`GET ${API}/issues`]: (call) => {
        const offset = Number(new URL(call.url).searchParams.get("offset") ?? 0);
        return jsonResponse(issuesOf(100, offset));
      },
    });
    const r = await fetchProjectIssues(client(), "P");
    expect(r.issues).toHaveLength(1000);
    expect(r.truncated).toBe(true);
    expect(r.warnings).toEqual([
      {
        code: "issues_truncated",
        message:
          "Only the first 1000 issues of project P were analyzed (page limit reached). The result may be incomplete.",
        component: "issues",
        retryable: false,
      },
    ]);
    expect(m.calls).toHaveLength(PROJECT_ISSUE_CALLS);
  });

  it("sort / order を指定できる", async () => {
    const m = mockOutboundFetch({
      [`GET ${API}/projects/P`]: () => jsonResponse({ id: 10 }),
      [`GET ${API}/issues`]: () => jsonResponse([]),
    });
    await fetchProjectIssues(client(), "P", { sort: "updated", order: "asc" });
    expect(m.calls.map(describeCall)[1]).toBe(
      "GET /issues?count=100&order=asc&projectId[]=10&sort=updated",
    );
  });

  it("プロジェクトの取得に失敗したら project_fetch_failed の warning(課題は取りに行かない)", async () => {
    const m = mockOutboundFetch({
      [`GET ${API}/projects/P`]: () =>
        jsonResponse({ errors: [{ message: "No such project.", code: 6 }] }, 404),
    });
    const r = await fetchProjectIssues(client(), "P");
    expect(r).toMatchObject({ issues: [], truncated: false, failed: true });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({
      code: "project_fetch_failed",
      component: "project",
      retryable: false,
    });
    expect(r.warnings[0]?.message).toContain("failed to get project P");
    expect(m.calls).toHaveLength(1);
  });

  it("課題一覧の取得に失敗したら issues_fetch_failed の warning", async () => {
    mockOutboundFetch({
      [`GET ${API}/projects/P`]: () => jsonResponse({ id: 10 }),
      [`GET ${API}/issues`]: () => jsonResponse({ errors: [{ message: "boom", code: 1 }] }, 500),
    });
    const r = await fetchProjectIssues(client(), "P");
    expect(r).toMatchObject({ issues: [], failed: true });
    expect(r.warnings[0]).toMatchObject({
      code: "issues_fetch_failed",
      component: "issues",
      retryable: true,
    });
  });

  it("Backlog が 401 を返したら握りつぶさず投げる(トークン更新のため)", async () => {
    mockOutboundFetch({
      [`GET ${API}/projects/P`]: () => jsonResponse({ errors: [{ message: "x", code: 11 }] }, 401),
    });
    await expect(fetchProjectIssues(client(), "P")).rejects.toThrow(BacklogUnauthorizedError);
  });
});
