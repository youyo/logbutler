import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";
import {
  BACKLOG_HOST,
  firstText,
  MCP_URL,
  mcpRequest,
  readRpc,
  runAuthorizationFlow,
  setupMocks,
  type TokenSet,
} from "../helpers/oauth-flow";

afterEach(() => {
  vi.restoreAllMocks();
});

const API = `${BACKLOG_HOST}/api/v2`;

/** 認可フローを通して MCP のアクセストークンを得てから、Backlog のモックを差し替える。 */
async function loggedIn(handlers: Parameters<typeof mockOutboundFetch>[0]) {
  await setupMocks();
  const flow = await runAuthorizationFlow();
  const { access_token } = (await flow.tokenResponse.json()) as TokenSet;
  vi.restoreAllMocks();
  return { token: access_token, ...mockOutboundFetch(handlers) };
}

const call = (token: string, name: string, args: Record<string, unknown>) =>
  mcpRequest(token, "tools/call", { name, arguments: args });

/** 完了集合(完了・対応済み・Closed・Done・Resolved)以外に、プロジェクト固有のカスタム状態 101 がある。 */
const PROJ_STATUSES = [
  { id: 1, projectId: 10, name: "未対応" },
  { id: 2, projectId: 10, name: "処理中" },
  { id: 3, projectId: 10, name: "処理済み" },
  { id: 4, projectId: 10, name: "完了" },
  { id: 101, projectId: 10, name: "レビュー待ち" },
];

describe("E2E 9: 読み取りツール(M03)が OAuth 済みトークンの /mcp で動く", () => {
  it("issue_list: project_key を解決し、フィルターを Backlog のクエリにして、生データ(camelCase)を返す", async () => {
    const issues = [
      { id: 1, issueKey: "PROJ-1", summary: "s", createdUser: { id: 1, userId: "alice" } },
    ];
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects/PROJ`]: () => jsonResponse({ id: 10, projectKey: "PROJ" }),
      [`GET ${API}/projects/PROJ/statuses`]: () => jsonResponse(PROJ_STATUSES),
      [`GET ${API}/issues`]: () => jsonResponse(issues),
    });
    const res = await call(token, "logbutler_issue_list", {
      project_key: "PROJ",
      status_id: "not-closed",
      count: 5,
    });
    expect(res.status).toBe(200);
    const rpc = await readRpc(res);
    expect(rpc.result?.isError).toBeFalsy();
    expect(JSON.parse(firstText(rpc))).toEqual(issues);

    const issueCall = calls.find((c) => new URL(c.url).pathname.endsWith("/issues"));
    const q = new URL(issueCall?.url ?? "").searchParams;
    expect(q.getAll("projectId[]")).toEqual(["10"]);
    // not-closed は ID の決め打ちでなく、プロジェクトの状態一覧から完了集合以外の ID(カスタム状態 101 を含む)
    expect(q.getAll("statusId[]")).toEqual(["1", "2", "3", "101"]);
    expect(q.get("count")).toBe("5");
    // grant の props にある Backlog トークンで呼ぶ(MCP のトークンではない)
    expect(issueCall?.headers.get("authorization")).toMatch(/^Bearer backlog-at-/);
    // 並列呼び出しなし: プロジェクト解決 → 状態一覧 → 課題一覧の順
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v2/projects/PROJ",
      "/api/v2/projects/PROJ/statuses",
      "/api/v2/issues",
    ]);
  });

  it("issue_list(not-closed・プロジェクト指定なし): 参加プロジェクトの状態一覧から、重複を除いた完了集合以外の ID を使う", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects`]: () =>
        jsonResponse([
          { id: 10, projectKey: "PROJ" },
          { id: 20, projectKey: "OTHER" },
        ]),
      [`GET ${API}/projects/PROJ/statuses`]: () => jsonResponse(PROJ_STATUSES),
      [`GET ${API}/projects/OTHER/statuses`]: () =>
        jsonResponse([
          { id: 1, name: "未対応" },
          { id: 201, name: "検証中" },
          { id: 202, name: "Closed" },
        ]),
      [`GET ${API}/issues`]: () => jsonResponse([]),
    });
    const rpc = await readRpc(
      await call(token, "logbutler_issue_list", { status_id: "not-closed" }),
    );
    expect(rpc.result?.isError, firstText(rpc)).toBeFalsy();
    const issueCall = calls.find((c) => new URL(c.url).pathname.endsWith("/issues"));
    expect(new URL(issueCall?.url ?? "").searchParams.getAll("statusId[]")).toEqual([
      "1",
      "2",
      "3",
      "101",
      "201",
    ]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v2/projects",
      "/api/v2/projects/PROJ/statuses",
      "/api/v2/projects/OTHER/statuses",
      "/api/v2/issues",
    ]);
  });

  it("issue_comment_list: offset は Backlog に送らず、count + offset 件を取って先頭 offset 件を読み飛ばす(実 Backlog は offset に 400 unknownParameter を返す)", async () => {
    const comments = Array.from({ length: 5 }, (_, i) => ({ id: 50 - i, content: `c${i}` }));
    const { token, calls } = await loggedIn({
      [`GET ${API}/issues/PROJ-1/comments`]: (c) =>
        new URL(c.url).searchParams.has("offset")
          ? jsonResponse(
              { errors: [{ message: "unknownParameter", code: 7, moreInfo: "offset" }] },
              400,
            )
          : jsonResponse(comments),
    });
    const rpc = await readRpc(
      await call(token, "logbutler_issue_comment_list", {
        issue_key: "PROJ-1",
        count: 2,
        offset: 3,
      }),
    );
    expect(rpc.result?.isError, firstText(rpc)).toBeFalsy();
    expect(JSON.parse(firstText(rpc)).map((c: { id: number }) => c.id)).toEqual([47, 46]);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("count")).toBe("5");
  });

  it("document_tree: ドキュメントが 0 件のプロジェクト(Backlog が 404 ActiveRoot node not found)は空の木を返し、存在しないプロジェクトは not_found のまま", async () => {
    const { token } = await loggedIn({
      [`GET ${API}/documents/tree`]: (c) =>
        new URL(c.url).searchParams.get("projectIdOrKey") === "EMPTY"
          ? jsonResponse({ errors: [{ message: "ActiveRoot node not found", code: 6 }] }, 404)
          : jsonResponse({ errors: [{ message: "No project.", code: 6 }] }, 404),
      [`GET ${API}/projects/EMPTY`]: () => jsonResponse({ id: 30, projectKey: "EMPTY" }),
      [`GET ${API}/projects/GONE`]: () =>
        jsonResponse({ errors: [{ message: "No project.", code: 6 }] }, 404),
    });
    const empty = await readRpc(
      await call(token, "logbutler_document_tree", { project_key: "EMPTY" }),
    );
    expect(empty.result?.isError, firstText(empty)).toBeFalsy();
    expect(JSON.parse(firstText(empty))).toEqual({
      projectId: 30,
      activeTree: { id: "Active", children: [] },
      trashTree: { id: "Trash", children: [] },
    });
    const gone = await readRpc(
      await call(token, "logbutler_document_tree", { project_key: "GONE" }),
    );
    expect(gone.result?.isError).toBe(true);
    expect(JSON.parse(firstText(gone)).error.code).toBe("not_found");
  });

  it("wiki_get: GET /wikis/{id} の生データを返し、Backlog の 404 は §9 エンベロープになる", async () => {
    const page = { id: 100, projectId: 10, name: "Home", content: "# hi", createdUser: { id: 1 } };
    const { token } = await loggedIn({
      [`GET ${API}/wikis/100`]: () => jsonResponse(page),
      [`GET ${API}/wikis/999`]: () =>
        jsonResponse({ errors: [{ message: "No wiki.", code: 6 }] }, 404),
    });
    const ok = await readRpc(await call(token, "logbutler_wiki_get", { wiki_id: 100 }));
    expect(JSON.parse(firstText(ok))).toEqual(page);

    const missing = await readRpc(await call(token, "logbutler_wiki_get", { wiki_id: 999 }));
    expect(missing.result?.isError).toBe(true);
    expect(JSON.parse(firstText(missing))).toEqual({
      schema_version: "1",
      error: {
        code: "not_found",
        message: "Backlog API error (HTTP 404, code=6): No wiki.",
        retryable: false,
      },
    });
  });

  it("issue_attachment_download: バイト列を base64 で返し、上限超過は api_error のエンベロープ", async () => {
    const { token } = await loggedIn({
      [`GET ${API}/issues/PROJ-1/attachments/7`]: () =>
        new Response(new Uint8Array([104, 105]), {
          headers: {
            "Content-Type": "text/plain",
            "Content-Disposition": "attachment; filename*=UTF-8''%E3%81%82.txt",
          },
        }),
      [`GET ${API}/issues/PROJ-1/attachments/8`]: () =>
        new Response(new Uint8Array(20 * 1024 * 1024 + 1)),
    });
    const ok = await readRpc(
      await call(token, "logbutler_issue_attachment_download", {
        issue_key: "PROJ-1",
        attachment_id: 7,
      }),
    );
    expect(JSON.parse(firstText(ok))).toEqual({
      content_base64: "aGk=",
      filename: "あ.txt",
      content_type: "text/plain",
      size_bytes: 2,
    });

    const big = await readRpc(
      await call(token, "logbutler_issue_attachment_download", {
        issue_key: "PROJ-1",
        attachment_id: 8,
      }),
    );
    expect(big.result?.isError).toBe(true);
    expect(JSON.parse(firstText(big)).error).toMatchObject({ code: "api_error", retryable: false });
  });

  it("入力が不正なら Backlog を呼ばずに argument_error", async () => {
    const { token, calls } = await loggedIn({});
    const rpc = await readRpc(await call(token, "logbutler_issue_list", { count: 500 }));
    expect(rpc.result?.isError).toBe(true);
    expect(JSON.parse(firstText(rpc)).error.code).toBe("argument_error");
    expect(calls).toHaveLength(0);
  });

  it("URL クエリ ?toolsets= で toolset を絞ると、tools/list からそのツールが消える", async () => {
    const { token } = await loggedIn({});
    const list = async (toolsets?: string) => {
      const url =
        toolsets === undefined ? MCP_URL : `${MCP_URL}?${new URLSearchParams({ toolsets })}`;
      const res = await mcpRequest(token, "tools/list", {}, url);
      expect(res.status).toBe(200);
      return (await readRpc(res)).result?.tools?.map((t) => t.name) ?? [];
    };

    const all = await list();
    expect(await list("all")).toEqual(all);
    expect(all).toHaveLength(38 + 15 + 11 + 7 + 3 + 12); // M03 の読み取り 38 + M04 の書き込み 14 と project_conventions + M05A の分析 11 + M05B の digest・検索 7 + M06 の 3 + プロジェクト設定 12
    expect(all).toContain("logbutler_issue_list");

    const wikiOnly = await list("wiki");
    expect(wikiOnly).toHaveLength(8);
    expect(wikiOnly.every((n) => n.startsWith("logbutler_wiki_"))).toBe(true);
    expect(wikiOnly).not.toContain("logbutler_issue_list");
    expect(wikiOnly).not.toContain("logbutler_user_me");

    const two = await list("issue, shared_file");
    expect(two.sort()).toEqual(
      [
        "logbutler_issue_attachment_delete",
        "logbutler_issue_attachment_download",
        "logbutler_issue_attachment_list",
        "logbutler_issue_attachment_upload",
        "logbutler_issue_comment_add",
        "logbutler_issue_comment_list",
        "logbutler_issue_comment_update",
        "logbutler_issue_create",
        "logbutler_issue_get",
        "logbutler_issue_list",
        "logbutler_issue_related_add",
        "logbutler_issue_related_delete",
        "logbutler_issue_related_list",
        "logbutler_issue_update",
        "logbutler_shared_file_download",
        "logbutler_shared_file_list",
      ].sort(),
    );
  });
});

describe("E2E 9b: issue_list の include_descendants(子と孫をまとめて返す。ADR 0015)", () => {
  it("子の ID を集めてから、親 ∪ 子の parentIssueId[] とフィルタで 1 回だけ一覧を取る", async () => {
    const grandchildren = [
      { id: 201, issueKey: "PROJ-201", parentIssueId: 101 },
      { id: 101, issueKey: "PROJ-101", parentIssueId: 100 },
    ];
    const { token, calls } = await loggedIn({
      [`GET ${API}/issues`]: (c) =>
        jsonResponse(
          new URL(c.url).searchParams.get("sort") === "created"
            ? [{ id: 101 }, { id: 102 }]
            : grandchildren,
        ),
    });
    const rpc = await readRpc(
      await call(token, "logbutler_issue_list", {
        parent_issue_ids: "100",
        include_descendants: true,
        keyword: "x",
        count: 30,
      }),
    );
    expect(rpc.result?.isError).toBeFalsy();
    expect(JSON.parse(firstText(rpc))).toEqual(grandchildren);

    expect(calls).toHaveLength(2);
    const collect = new URL(calls[0]?.url ?? "").searchParams;
    expect(collect.getAll("parentIssueId[]")).toEqual(["100"]);
    expect(collect.has("keyword")).toBe(false);
    const last = new URL(calls[1]?.url ?? "").searchParams;
    expect(last.getAll("parentIssueId[]")).toEqual(["100", "101", "102"]);
    expect(last.get("keyword")).toBe("x");
    expect(last.get("count")).toBe("30");
  });

  it("parent_issue_ids がなければ argument_error(Backlog を呼ばない)", async () => {
    const { token, calls } = await loggedIn({});
    const rpc = await readRpc(
      await call(token, "logbutler_issue_list", { include_descendants: true }),
    );
    expect(rpc.result?.isError).toBe(true);
    expect(JSON.parse(firstText(rpc)).error.code).toBe("argument_error");
    expect(calls).toHaveLength(0);
  });
});
