/** search(logvalet `internal/digest/search_test.go` から書き起こし + M05B の意図した変更)。 */
import { describe, expect, it } from "vitest";
import { search } from "../../src/mcp/tools/digest";
import { issue, NOW } from "../helpers/analysis-fixtures";
import { jsonResponse } from "../helpers/mock-fetch";
import { callTool } from "../helpers/tool-call";

const run = (args: Record<string, unknown>, respond: Parameters<typeof callTool>[2]) =>
  callTool("logbutler_search", args, respond, { now: NOW, timezone: "Asia/Tokyo" });
const codes = (r: { json: { warnings: { code: string }[] } }) => r.json.warnings.map((w) => w.code);
const err404 = () => jsonResponse({ errors: [{ message: "No such thing.", code: 6 }] }, 404);
const err503 = () => jsonResponse({}, 503);

const proj = (id: number, key: string) => ({ id, projectKey: key, name: `Project ${key}` });
const wiki = (id: number, projectId: number, name: string, content = "") => ({
  id,
  projectId,
  name,
  content,
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-02T00:00:00Z",
  createdUser: { id: 1, name: "Alice" },
});

describe("search", () => {
  it("AllResources: 空でないスペース全体の検索。ListProjects → issues → documents → wikis の順で、1 件ずつ", async () => {
    const r = await run(
      { keyword: "OAuth", count: 10 },
      {
        "GET /projects": [proj(1, "PROJ")],
        "GET /issues": [
          issue({
            key: "PROJ-10",
            projectId: 1,
            id: 10,
            summary: "OAuth issue",
            description: "OAuth error happens on callback",
            createdUser: { id: 5, name: "Reporter" },
            assignee: { id: 6, name: "Assignee" },
          }),
        ],
        "GET /documents": [
          { id: "doc-1", projectId: 1, title: "OAuth document", plain: "OAuth setup guide" },
        ],
        "GET /wikis": [wiki(20, 1, "OAuth Wiki", "OAuth wiki body")],
      },
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toEqual([
      "GET /projects",
      "GET /issues?count=10&keyword=OAuth&order=desc&sort=updated",
      "GET /documents?count=10&keyword=OAuth&offset=0&order=desc&sort=updated",
      "GET /wikis?keyword=OAuth&projectIdOrKey=PROJ",
    ]);
    expect(r.json.resource).toBe("search");
    const d = r.json.digest;
    expect(d).toMatchObject({
      keyword: "OAuth",
      detail: "snippet",
      count_per_resource: 10,
      offset: 0,
      total_returned: 3,
      returned_by_type: { issues: 1, documents: 1, wikis: 1 },
      possibly_more: false,
      possibly_more_by_type: { issues: 0, documents: 0, wikis: 0 },
      truncated: false,
    });
    expect(d.project_keys).toBeUndefined();
    expect(d.next_offset).toBeUndefined();
    expect(d.items).toEqual([
      {
        resource_type: "issue",
        id: "10",
        key: "PROJ-10",
        project_id: 1,
        project_key: "PROJ",
        title: "OAuth issue",
        url: "https://example.backlog.com/view/PROJ-10",
        snippet: "OAuth error happens on callback",
        created: expect.any(String),
        updated: expect.any(String),
        assignee: { id: 6, name: "Assignee" },
        reporter: { id: 5, name: "Reporter" },
      },
      {
        resource_type: "document",
        id: "doc-1",
        project_id: 1,
        project_key: "PROJ",
        title: "OAuth document",
        url: "https://example.backlog.com/document/PROJ/doc-1",
        snippet: "OAuth setup guide",
      },
      {
        resource_type: "wiki",
        id: "20",
        project_id: 1,
        project_key: "PROJ",
        title: "OAuth Wiki",
        url: "https://example.backlog.com/wiki/PROJ/OAuth%20Wiki",
        snippet: "OAuth wiki body",
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-02T00:00:00Z",
        created_user: { id: 1, name: "Alice" },
      },
    ]);
  });

  it("detail=meta は snippet を出さない。detail が snippet / meta 以外なら argument_error", async () => {
    const respond = {
      "GET /projects": [proj(1, "PROJ")],
      "GET /issues": [issue({ key: "PROJ-1", projectId: 1, description: "d" })],
      "GET /documents": [{ id: "d", projectId: 1, title: "t", plain: "p" }],
      "GET /wikis": [wiki(1, 1, "w", "c")],
    };
    const meta = await run({ keyword: "k", detail: "meta" }, respond);
    expect(meta.json.digest.items.map((i: { snippet?: string }) => i.snippet)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    const bad = await run({ keyword: "k", detail: "full" }, respond);
    expect(bad.json.error.code).toBe("argument_error");
    expect(bad.calls).toEqual([]);
  });

  it("project_keys: GetProject で ID にして issues / documents を絞る。wiki は解決したプロジェクトだけ。ListProjects は呼ばない", async () => {
    const r = await run(
      { keyword: "auth", project_keys: "PROJ, PROJ,B" },
      {
        "GET /projects/PROJ": proj(7, "PROJ"),
        "GET /projects/B": proj(8, "B"),
        "GET /issues": [],
        "GET /documents": [],
        "GET /wikis": [],
      },
    );
    expect(r.calls).toEqual([
      "GET /projects/PROJ",
      "GET /projects/B",
      "GET /issues?count=20&keyword=auth&order=desc&projectId[]=7&projectId[]=8&sort=updated",
      "GET /documents?count=20&keyword=auth&offset=0&order=desc&projectId[]=7&projectId[]=8&sort=updated",
      "GET /wikis?keyword=auth&projectIdOrKey=PROJ",
      "GET /wikis?keyword=auth&projectIdOrKey=B",
    ]);
    expect(r.json.digest.project_keys).toEqual(["PROJ", "B"]);
  });

  it("空白だけの project_keys は未指定として全プロジェクトを対象にする(GetProject は呼ばない)", async () => {
    const r = await run(
      { keyword: "auth", project_keys: " , \t" },
      {
        "GET /projects": [proj(1, "PROJ")],
        "GET /issues": [],
        "GET /documents": [],
        "GET /wikis": [],
      },
    );
    expect(r.calls[0]).toBe("GET /projects");
    expect(r.calls.some((c) => c.startsWith("GET /wikis"))).toBe(true);
  });

  it("project_keys の GetProject が失敗しても全体は失敗にしない(logvalet は全体エラー)。warning にして残りで検索し、検索は成功したプロジェクトに絞る", async () => {
    const r = await run(
      { keyword: "x", project_keys: "BAD,GOOD" },
      {
        "GET /projects/BAD": err404,
        "GET /projects/GOOD": proj(10, "GOOD"),
        "GET /issues": [],
        "GET /documents": [],
        "GET /wikis": [],
      },
    );
    expect(r.isError, r.text).toBe(false);
    expect(codes(r)).toEqual(["project_fetch_failed"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "scope.projects.BAD", retryable: false });
    expect(r.calls[2]).toContain("projectId[]=10");
  });

  it("GetProject の 5xx は retryable=true の warning", async () => {
    const r = await run(
      { keyword: "x", project_keys: "A,B" },
      {
        "GET /projects/A": err503,
        "GET /projects/B": proj(2, "B"),
        "GET /issues": [],
        "GET /documents": [],
        "GET /wikis": [],
      },
    );
    expect(r.json.warnings[0].retryable).toBe(true);
  });

  it("project_keys が全部引けなければ、絞り込みを失ってスペース全体を検索せず、空の結果と warning を返す", async () => {
    const r = await run(
      { keyword: "x", project_keys: "A,B" },
      { "GET /projects/A": err404, "GET /projects/B": err404 },
    );
    expect(r.isError).toBe(false);
    expect(r.calls).toEqual(["GET /projects/A", "GET /projects/B"]);
    expect(codes(r)).toEqual(["project_fetch_failed", "project_fetch_failed"]);
    expect(r.json.digest).toMatchObject({
      total_returned: 0,
      items: [],
      possibly_more: false,
      truncated: false,
    });
  });

  it("401 は warning にせず投げ直す(トークン更新の合図)", async () => {
    const r = await run(
      { keyword: "x", project_keys: "A" },
      { "GET /projects/A": () => jsonResponse({}, 401) },
    );
    expect(r.isError).toBe(true);
    expect(r.json.error.code).toBe("authentication_error");
  });

  it("ListProjects の失敗は project_list_failed。wiki 検索と URL 構築を諦め、issues / documents は検索する", async () => {
    const r = await run(
      { keyword: "x" },
      {
        "GET /projects": err503,
        "GET /issues": [issue({ key: "P-1" })],
        "GET /documents": [],
      },
    );
    expect(r.isError, r.text).toBe(false);
    expect(codes(r)).toEqual(["project_list_failed"]);
    expect(r.calls.some((c) => c.startsWith("GET /wikis"))).toBe(false);
    expect(r.json.digest.returned_by_type).toEqual({ issues: 1, documents: 0, wikis: 0 });
  });

  it("issues / documents / wikis の個別の検索失敗は warning(issue_search_failed など)で、他は返す", async () => {
    const r = await run(
      { keyword: "x" },
      {
        "GET /projects": [proj(1, "P")],
        "GET /issues": err503,
        "GET /documents": err404,
        "GET /wikis": err503,
      },
    );
    expect(r.isError, r.text).toBe(false);
    expect(codes(r)).toEqual([
      "issue_search_failed",
      "document_search_failed",
      "wiki_search_failed",
    ]);
    expect(r.json.warnings.map((w: { retryable: boolean }) => w.retryable)).toEqual([
      true,
      false,
      true,
    ]);
    expect(r.json.digest.total_returned).toBe(0);
  });

  it("WikiSearchStopsAfterEnoughResults: count+1 件集まったらそれ以降のプロジェクトは検索しない(2 回で止まる)", async () => {
    let n = 0;
    const r = await run(
      { keyword: "auth", count: 2 },
      {
        "GET /projects": [proj(1, "P1"), proj(2, "P2"), proj(3, "P3")],
        "GET /issues": [],
        "GET /documents": [],
        "GET /wikis": () => {
          n++;
          return jsonResponse([wiki(n * 10 + 1, n, `P${n}-1`), wiki(n * 10 + 2, n, `P${n}-2`)]);
        },
      },
    );
    expect(r.calls.filter((c) => c.startsWith("GET /wikis"))).toHaveLength(2);
    const d = r.json.digest;
    expect(d.returned_by_type.wikis).toBe(2);
    expect(d.possibly_more).toBe(true);
    expect(d.possibly_more_by_type.wikis).toBe(1);
    expect(d.next_offset).toBe(2);
    // 早期終了は予算ではなく「十分に集まった」ことによる → 警告も truncated も出さない
    expect(d.truncated).toBe(false);
    expect(r.json.warnings).toEqual([]);
  });

  it("offset: wiki はクライアント側で offset / count を切り出し、issues / documents には offset を渡す", async () => {
    const r = await run(
      { keyword: "k", count: 2, offset: 1 },
      {
        "GET /projects": [proj(1, "P1")],
        "GET /issues": [],
        "GET /documents": [],
        "GET /wikis": [wiki(1, 1, "a"), wiki(2, 1, "b"), wiki(3, 1, "c"), wiki(4, 1, "d")],
      },
    );
    expect(r.calls[1]).toContain("offset=1");
    expect(r.calls[2]).toContain("offset=1");
    expect(r.json.digest.items.map((i: { title: string }) => i.title)).toEqual(["b", "c"]);
    expect(r.json.digest.possibly_more_by_type.wikis).toBe(1);
    expect(r.json.digest.next_offset).toBe(3); // offset + count
  });

  it("wiki 検索のプロジェクト数は 10 まで。超えた分は検索せず wiki_search_truncated と truncated(予算の上限に含める)", async () => {
    const projects = Array.from({ length: 15 }, (_, i) => proj(i + 1, `P${i + 1}`));
    const r = await run(
      { keyword: "k" },
      { "GET /projects": projects, "GET /issues": [], "GET /documents": [], "GET /wikis": [] },
    );
    expect(r.calls.filter((c) => c.startsWith("GET /wikis"))).toHaveLength(10);
    expect(codes(r)).toEqual(["wiki_search_truncated"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "wikis", retryable: false });
    expect(r.json.digest.truncated).toBe(true);
    expect(r.calls).toHaveLength(13);
  });

  it("ちょうど 10 プロジェクトなら truncated にならない", async () => {
    const projects = Array.from({ length: 10 }, (_, i) => proj(i + 1, `P${i + 1}`));
    const r = await run(
      { keyword: "k" },
      { "GET /projects": projects, "GET /issues": [], "GET /documents": [], "GET /wikis": [] },
    );
    expect(r.json.digest.truncated).toBe(false);
    expect(r.json.warnings).toEqual([]);
  });

  it("URL のパスはエスケープする(課題キー・ドキュメント ID・Wiki 名・プロジェクトキー)", async () => {
    const r = await run(
      { keyword: "k" },
      {
        "GET /projects": [proj(1, "P R")],
        "GET /issues": [issue({ key: "P R-1", projectId: 1 })],
        "GET /documents": [{ id: "a/b", projectId: 1, title: "t" }],
        "GET /wikis": [wiki(1, 1, "日本 語/x")],
      },
    );
    expect(r.json.digest.items.map((i: { url: string }) => i.url)).toEqual([
      "https://example.backlog.com/view/P%20R-1",
      "https://example.backlog.com/document/P%20R/a%2Fb",
      "https://example.backlog.com/wiki/P%20R/%E6%97%A5%E6%9C%AC%20%E8%AA%9E%2Fx",
    ]);
  });

  it("課題の project_key は、プロジェクト一覧にないときは課題キーの接頭辞から補う", async () => {
    const r = await run(
      { keyword: "k" },
      {
        "GET /projects": [],
        "GET /issues": [issue({ key: "ZZ-5", projectId: 99 })],
        "GET /documents": [],
      },
    );
    expect(r.json.digest.items[0]).toMatchObject({
      project_key: "ZZ",
      url: "https://example.backlog.com/view/ZZ-5",
    });
  });

  it("入力: keyword が空(空白だけ含む)は argument_error。count は 1〜100(範囲外は argument_error)。project_keys は 5 個まで", async () => {
    for (const args of [
      { keyword: "" },
      { keyword: "   " },
      { keyword: "k", count: 0 },
      { keyword: "k", count: 101 },
      { keyword: "k", project_keys: "A,B,C,D,E,F" },
    ]) {
      const r = await run(args, {});
      expect(r.json.error.code, JSON.stringify(args)).toBe("argument_error");
      expect(r.calls).toEqual([]);
    }
  });

  describe("API 呼び出しの最悪ケース", () => {
    it("maxApiCalls は 13 = max(project_keys 5 の 5 + 2 + 5, キーなしの 1 + 2 + wiki 10)", () => {
      expect(search.maxApiCalls).toBe(13);
    });
    it("project_keys 5 個: GetProject 5 + issues 1 + documents 1 + wiki 5 = 12", async () => {
      const respond: Record<string, unknown> = {
        "GET /issues": [],
        "GET /documents": [],
        "GET /wikis": [],
      };
      for (const [i, k] of ["A", "B", "C", "D", "E"].entries())
        respond[`GET /projects/${k}`] = proj(i + 1, k);
      const r = await run(
        { keyword: "k", project_keys: "A,B,C,D,E" },
        respond as Parameters<typeof callTool>[2],
      );
      expect(r.calls).toHaveLength(12);
      expect(r.json.digest.truncated).toBe(false);
    });
  });
});
