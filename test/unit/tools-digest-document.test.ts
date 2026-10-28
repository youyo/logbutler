/** space_digest / document_digest / document_search(logvalet `internal/digest/{space,document,document_search}_test.go` から書き起こし)。 */
import { describe, expect, it } from "vitest";
import { documentDigest, documentSearch, spaceDigest } from "../../src/mcp/tools/digest";
import golden from "../fixtures/document_search_snippet.json";
import { NOW } from "../helpers/analysis-fixtures";
import { jsonResponse } from "../helpers/mock-fetch";
import { callTool } from "../helpers/tool-call";

const run = (
  tool: string,
  args: Record<string, unknown>,
  respond: Parameters<typeof callTool>[2],
) => callTool(`logbutler_${tool}`, args, respond, { now: NOW, timezone: "Asia/Tokyo" });
const codes = (r: { json: { warnings: { code: string }[] } }) => r.json.warnings.map((w) => w.code);
const err404 = () => jsonResponse({ errors: [{ message: "No such thing.", code: 6 }] }, 404);

const SPACE = {
  spaceKey: "myspace",
  name: "My Space",
  ownerId: 1,
  lang: "ja",
  timezone: "Asia/Tokyo",
  reportSendTime: "08:00:00",
  textFormattingRule: "markdown",
};
const DISK = {
  capacity: 10737418240,
  issue: 100,
  wiki: 20,
  file: 3,
  subversion: 4,
  git: 5,
  gitLFS: 6,
};

describe("space_digest", () => {
  it("GetSpace → GetSpaceDiskUsage。used_bytes は 6 項目の和、エンベロープは resource=space", async () => {
    const r = await run("space_digest", {}, { "GET /space": SPACE, "GET /space/diskUsage": DISK });
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toEqual(["GET /space", "GET /space/diskUsage"]);
    expect(r.json).toMatchObject({
      schema_version: "1",
      resource: "space",
      generated_at: NOW.toISOString(),
      space: "example",
      base_url: "https://example.backlog.com",
      warnings: [],
    });
    expect(r.json.digest).toEqual({
      space: {
        space_key: "myspace",
        name: "My Space",
        owner_id: 1,
        lang: "ja",
        timezone: "Asia/Tokyo",
        text_formatting_rule: "markdown",
      },
      disk_usage: DISK, // Backlog の生データ(camelCase)のまま
      summary: {
        headline: "スペース My Space（myspace）",
        has_disk_usage: true,
        capacity_bytes: 10737418240,
        used_bytes: 100 + 20 + 3 + 4 + 5 + 6,
      },
      llm_hints: {
        primary_entities: ["myspace", "My Space"],
        open_questions: [],
        suggested_next_actions: [],
      },
    });
  });

  it("ディスク使用量の取得失敗は warning(部分成功)。disk_usage と容量は出さない", async () => {
    const r = await run(
      "space_digest",
      {},
      { "GET /space": SPACE, "GET /space/diskUsage": err404 },
    );
    expect(r.isError, r.text).toBe(false);
    expect(codes(r)).toEqual(["disk_usage_fetch_failed"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "disk_usage", retryable: false });
    expect(r.json.digest.disk_usage).toBeUndefined();
    expect(r.json.digest.summary).toEqual({
      headline: "スペース My Space（myspace）",
      has_disk_usage: false,
    });
  });

  it("GetSpace の失敗はツールエラー(必須の取得)", async () => {
    const r = await run("space_digest", {}, { "GET /space": err404 });
    expect(r.isError).toBe(true);
    expect(r.json.error.code).toBe("not_found");
  });

  it("API 呼び出しは最大 2 回(maxApiCalls=2)", () => {
    expect(spaceDigest.maxApiCalls).toBe(2);
  });
});

const DOC = {
  id: "test-doc-uuid-001",
  projectId: 10,
  title: "テストドキュメント",
  plain: "本文です",
  json: { type: "doc" },
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-02T00:00:00Z",
  createdUser: { id: 1, userId: "a", name: "Alice" },
  statusId: 1,
};

describe("document_digest", () => {
  const ok = {
    "GET /documents/test-doc-uuid-001": DOC,
    "GET /projects": [
      { id: 9, projectKey: "OTHER", name: "他" },
      { id: 10, projectKey: "PROJ", name: "テストプロジェクト" },
    ],
    "GET /documents/test-doc-uuid-001/attachments": [
      { id: 1, name: "file.txt", size: 1024, createdUser: { id: 1, name: "x" } },
    ],
  };

  it("GetDocument → ListProjects(ID 一致で解決)→ ListDocumentAttachments。サマリーは決定的", async () => {
    const r = await run("document_digest", { document_id: "test-doc-uuid-001" }, ok);
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toEqual([
      "GET /documents/test-doc-uuid-001",
      "GET /projects",
      "GET /documents/test-doc-uuid-001/attachments",
    ]);
    expect(r.json.resource).toBe("document");
    expect(r.json.warnings).toEqual([]);
    expect(r.json.digest).toEqual({
      document: {
        id: "test-doc-uuid-001",
        project_id: 10,
        title: "テストドキュメント",
        plain: "本文です",
        json: { type: "doc" },
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-02T00:00:00Z",
        created_user: { id: 1, name: "Alice" },
      },
      project: { id: 10, key: "PROJ", name: "テストプロジェクト" },
      attachments: [{ id: 1, name: "file.txt", size: 1024 }],
      summary: {
        headline: "ドキュメント「テストドキュメント」（ID: test-doc-uuid-001）",
        attachment_count: 1,
        has_content: true,
        content_length: 4,
      },
      llm_hints: {
        primary_entities: ["document:test-doc-uuid-001", "テストドキュメント", "PROJ"],
        open_questions: [],
        suggested_next_actions: [],
      },
    });
  });

  it("content_length はコードポイント数(サロゲートペアを 1 と数える)", async () => {
    const r = await run(
      "document_digest",
      { document_id: "d" },
      {
        "GET /documents/d": { ...DOC, id: "d", plain: "𠮷野家" },
        "GET /projects": [],
        "GET /documents/d/attachments": [],
      },
    );
    expect(r.json.digest.summary.content_length).toBe(3);
  });

  it("ListProjects の失敗は project_fetch_failed(retryable は Backlog のエラーに従う)。project は ID 0 の空", async () => {
    const r = await run(
      "document_digest",
      { document_id: "test-doc-uuid-001" },
      {
        ...ok,
        "GET /projects": () => jsonResponse({}, 503),
      },
    );
    expect(r.isError, r.text).toBe(false);
    expect(codes(r)).toEqual(["project_fetch_failed"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "project", retryable: true });
    expect(r.json.digest.project).toEqual({ id: 0, key: "", name: "" });
    expect(r.json.digest.llm_hints.primary_entities).toEqual([
      "document:test-doc-uuid-001",
      "テストドキュメント",
    ]);
  });

  it("プロジェクト ID が一覧になければ project_not_matched(retryable=false)", async () => {
    const r = await run(
      "document_digest",
      { document_id: "test-doc-uuid-001" },
      {
        ...ok,
        "GET /projects": [{ id: 1, projectKey: "X", name: "x" }],
      },
    );
    expect(codes(r)).toEqual(["project_not_matched"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "project", retryable: false });
  });

  it("添付ファイルの取得失敗は attachments_fetch_failed。attachments は空配列", async () => {
    const r = await run(
      "document_digest",
      { document_id: "test-doc-uuid-001" },
      {
        ...ok,
        "GET /documents/test-doc-uuid-001/attachments": err404,
      },
    );
    expect(codes(r)).toEqual(["attachments_fetch_failed"]);
    expect(r.json.digest.attachments).toEqual([]);
    expect(r.json.digest.summary.attachment_count).toBe(0);
  });

  it("GetDocument の失敗はツールエラー。document_id に含まれる '/' はパスをエスケープする", async () => {
    const r = await run(
      "document_digest",
      { document_id: "a/b" },
      { "GET /documents/a%2Fb": err404 },
    );
    expect(r.isError).toBe(true);
    expect(r.calls).toEqual(["GET /documents/a%2Fb"]);
    expect(r.json.error.code).toBe("not_found");
  });

  it("document_id が空なら argument_error(Backlog を呼ばない)", async () => {
    const r = await run("document_digest", { document_id: "" }, {});
    expect(r.json.error.code).toBe("argument_error");
    expect(r.calls).toEqual([]);
  });

  it("API 呼び出しは最大 3 回(maxApiCalls=3)", () => {
    expect(documentDigest.maxApiCalls).toBe(3);
  });
});

const mkDoc = (id: string, plain: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: 10,
  title: "タイトル",
  plain,
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-01T00:00:00Z",
  ...extra,
});
const PROJECTS = [{ id: 10, projectKey: "PROJ", name: "P" }];

describe("document_search", () => {
  it("golden: 2 件・snippet モードの digest が logvalet の golden ファイルと一致する", async () => {
    const r = await run(
      "document_search",
      { keyword: "OAuth" },
      {
        "GET /documents": [
          {
            id: "doc-golden-001",
            projectId: 10,
            title: "OAuth 認証ガイド",
            plain:
              "OAuth 2.0 を使った認証フローの説明です。クライアントIDとシークレットを設定してください。",
            created: "2026-01-15T09:00:00Z",
            updated: "2026-01-15T09:00:00Z",
            createdUser: { id: 1, name: "Alice" },
            updatedUser: { id: 2, name: "Bob" },
          },
          {
            id: "doc-golden-002",
            projectId: 10,
            title: "API リファレンス",
            plain: "OAuth トークンを Authorization ヘッダーに付与してリクエストします。",
            created: "2026-01-15T09:00:00Z",
            updated: "2026-01-15T09:00:00Z",
          },
        ],
        "GET /projects": PROJECTS,
      },
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.json.resource).toBe("document_search");
    expect(r.json.digest).toEqual(golden);
  });

  it("API は GET /documents(offset は 0 でも送る・count 既定 100)→ ListProjects(URL 構築)", async () => {
    const r = await run(
      "document_search",
      { keyword: "k" },
      { "GET /documents": [mkDoc("d1", "p")], "GET /projects": PROJECTS },
    );
    expect(r.calls).toEqual(["GET /documents?count=100&keyword=k&offset=0", "GET /projects"]);
  });

  it("detail: snippet は snippet のみ、meta は両方なし、full は snippet + plain 全文。既定は snippet", async () => {
    const docs = [mkDoc("d1", "OAuth トークンの説明テキスト")];
    const res = { "GET /documents": docs, "GET /projects": PROJECTS };
    const snippet = await run("document_search", { keyword: "OAuth", detail: "snippet" }, res);
    expect(snippet.json.digest.items[0]).toMatchObject({ snippet: "OAuth トークンの説明テキスト" });
    expect(snippet.json.digest.items[0].plain).toBeUndefined();
    const meta = await run("document_search", { keyword: "OAuth", detail: "meta" }, res);
    expect(meta.json.digest.items[0].snippet).toBeUndefined();
    expect(meta.json.digest.items[0].plain).toBeUndefined();
    const full = await run("document_search", { keyword: "OAuth", detail: "full" }, res);
    expect(full.json.digest.items[0]).toMatchObject({
      snippet: "OAuth トークンの説明テキスト",
      plain: "OAuth トークンの説明テキスト",
    });
    const dflt = await run("document_search", { keyword: "OAuth" }, res);
    expect(dflt.json.digest.detail).toBe("snippet");
  });

  it("detail が snippet / meta / full 以外なら argument_error(Backlog を呼ばない)", async () => {
    const r = await run("document_search", { keyword: "k", detail: "brief" }, {});
    expect(r.json.error.code).toBe("argument_error");
    expect(r.calls).toEqual([]);
  });

  it("snippet はコードポイント単位(長い本文のキーワード周辺 ±100)", async () => {
    const plain = `${"あ".repeat(150)}認証${"い".repeat(150)}`;
    const r = await run(
      "document_search",
      { keyword: "認証" },
      {
        "GET /documents": [mkDoc("d1", plain)],
        "GET /projects": PROJECTS,
      },
    );
    expect(r.json.digest.items[0].snippet).toBe([...plain].slice(50, 250).join(""));
  });

  it("URL のパスはエスケープする(logvalet は未エスケープ)。projectKey に '/' や空白があっても URL が壊れない", async () => {
    const r = await run(
      "document_search",
      { keyword: "k" },
      {
        "GET /documents": [mkDoc("a/b c#1", "p")],
        "GET /projects": [{ id: 10, projectKey: "P R", name: "P" }],
      },
    );
    expect(r.json.digest.items[0].url).toBe(
      "https://example.backlog.com/document/P%20R/a%2Fb%20c%231",
    );
  });

  it("possibly_more / next_offset: 件数が count 以上なら true で next_offset = offset + 件数", async () => {
    const docs = (n: number) => Array.from({ length: n }, (_, i) => mkDoc(`d${i}`, "p"));
    const full = await run(
      "document_search",
      { keyword: "k", count: 3, offset: 10 },
      {
        "GET /documents": docs(3),
        "GET /projects": PROJECTS,
      },
    );
    expect(full.json.digest).toMatchObject({
      total_returned: 3,
      possibly_more: true,
      next_offset: 13,
    });
    const part = await run(
      "document_search",
      { keyword: "k", count: 3 },
      {
        "GET /documents": docs(2),
        "GET /projects": PROJECTS,
      },
    );
    expect(part.json.digest.possibly_more).toBe(false);
    expect(part.json.digest.next_offset).toBeUndefined();
    // 既定の 100 件: 100 で true、99 で false
    expect(
      (
        await run(
          "document_search",
          { keyword: "k" },
          { "GET /documents": docs(100), "GET /projects": PROJECTS },
        )
      ).json.digest.possibly_more,
    ).toBe(true);
    expect(
      (
        await run(
          "document_search",
          { keyword: "k" },
          { "GET /documents": docs(99), "GET /projects": PROJECTS },
        )
      ).json.digest.possibly_more,
    ).toBe(false);
  });

  it("count は 1〜100。範囲外は argument_error(logvalet は黙って 100 に丸めていた)", async () => {
    for (const count of [0, 101, -1]) {
      const r = await run("document_search", { keyword: "k", count }, {});
      expect(r.json.error.code, String(count)).toBe("argument_error");
      expect(r.calls).toEqual([]);
    }
  });

  it("結果が空なら ListProjects を呼ばない(URL を作る必要がない)。items は []", async () => {
    const r = await run("document_search", { keyword: "k" }, { "GET /documents": [] });
    expect(r.calls).toHaveLength(1);
    expect(r.json.digest).toMatchObject({ total_returned: 0, possibly_more: false, items: [] });
  });

  it("ListProjects の失敗は project_fetch_failed の warning で、url なしで本体を返す(部分成功)", async () => {
    const r = await run(
      "document_search",
      { keyword: "k" },
      {
        "GET /documents": [mkDoc("d1", "p")],
        "GET /projects": () => jsonResponse({}, 503),
      },
    );
    expect(r.isError, r.text).toBe(false);
    expect(codes(r)).toEqual(["project_fetch_failed"]);
    expect(r.json.warnings[0]).toMatchObject({ component: "url", retryable: true });
    expect(r.json.digest.items[0].url).toBeUndefined();
  });

  it("project_keys: GetProject で ID にし(重複は 1 つ)、projectId[] で絞る。URL のプロジェクトキーは解決済みの値を使い、ListProjects は呼ばない", async () => {
    const r = await run(
      "document_search",
      { keyword: "k", project_keys: "PROJ, PROJ ,B" },
      {
        "GET /projects/PROJ": { id: 10, projectKey: "PROJ", name: "P" },
        "GET /projects/B": { id: 11, projectKey: "B", name: "B" },
        "GET /documents": [mkDoc("d1", "p", { projectId: 11 })],
      },
    );
    expect(r.calls).toEqual([
      "GET /projects/PROJ",
      "GET /projects/B",
      "GET /documents?count=100&keyword=k&offset=0&projectId[]=10&projectId[]=11",
    ]);
    expect(r.json.digest.items[0].url).toBe("https://example.backlog.com/document/B/d1");
  });

  it("project_keys の GetProject の失敗はツールエラー(logvalet と同じ。絞り込みを失って全体検索しない)", async () => {
    const r = await run(
      "document_search",
      { keyword: "k", project_keys: "BAD" },
      { "GET /projects/BAD": err404 },
    );
    expect(r.isError).toBe(true);
    expect(r.calls).toEqual(["GET /projects/BAD"]);
  });

  it("sort / order / offset を Backlog に渡す", async () => {
    const r = await run(
      "document_search",
      { keyword: "k", sort: "updated", order: "asc", offset: 5, count: 7 },
      { "GET /documents": [] },
    );
    expect(r.calls).toEqual(["GET /documents?count=7&keyword=k&offset=5&order=asc&sort=updated"]);
  });

  it("入力: keyword が空、project_keys が 6 個以上は argument_error", async () => {
    expect((await run("document_search", { keyword: "" }, {})).json.error.code).toBe(
      "argument_error",
    );
    const many = await run("document_search", { keyword: "k", project_keys: "A,B,C,D,E,F" }, {});
    expect(many.json.error.code).toBe("argument_error");
    expect(many.calls).toEqual([]);
  });

  it("API 呼び出しの最悪ケース: project_keys 5 個 → GetProject 5 + 検索 1 = 6、キーなし → 検索 1 + ListProjects 1 = 2。maxApiCalls=6", async () => {
    expect(documentSearch.maxApiCalls).toBe(6);
    const projects: Record<string, unknown> = {};
    for (const [i, k] of ["A", "B", "C", "D", "E"].entries()) {
      projects[`GET /projects/${k}`] = { id: i + 1, projectKey: k, name: k };
    }
    const r = await run(
      "document_search",
      { keyword: "k", project_keys: "A,B,C,D,E" },
      {
        ...projects,
        "GET /documents": [mkDoc("d1", "p", { projectId: 1 })],
      },
    );
    expect(r.calls).toHaveLength(6);
  });
});
