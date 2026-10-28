import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearJwksCache } from "../../src/auth/access-jwt";
import worker from "../../src/index";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";
import {
  accessHeaders,
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
  clearJwksCache();
});

const API = `${BACKLOG_HOST}/api/v2`;

/** 認可フローを通して MCP のアクセストークンを得てから、Backlog のモックを差し替える。 */
async function loggedIn(handlers: Parameters<typeof mockOutboundFetch>[0]) {
  const { accessKey } = await setupMocks();
  const flow = await runAuthorizationFlow(await accessHeaders(accessKey));
  const { access_token } = (await flow.tokenResponse.json()) as TokenSet;
  vi.restoreAllMocks();
  return { token: access_token, ...mockOutboundFetch(handlers) };
}

const call = (token: string, name: string, args: Record<string, unknown>) =>
  mcpRequest(token, "tools/call", { name, arguments: args });

describe("E2E 9: 読み取りツール(M03)が OAuth 済みトークンの /mcp で動く", () => {
  it("issue_list: project_key を解決し、フィルターを Backlog のクエリにして、生データ(camelCase)を返す", async () => {
    const issues = [
      { id: 1, issueKey: "PROJ-1", summary: "s", createdUser: { id: 1, userId: "alice" } },
    ];
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects/PROJ`]: () => jsonResponse({ id: 10, projectKey: "PROJ" }),
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
    expect(q.getAll("statusId[]")).toEqual(["1", "2", "3"]);
    expect(q.get("count")).toBe("5");
    // grant の props にある Backlog トークンで呼ぶ(MCP のトークンではない)
    expect(issueCall?.headers.get("authorization")).toMatch(/^Bearer backlog-at-/);
    // 並列呼び出しなし: プロジェクト解決 → 課題一覧の順
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v2/projects/PROJ",
      "/api/v2/issues",
    ]);
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

  it("LOGBUTLER_TOOLSETS で toolset を絞ると、tools/list からそのツールが消える", async () => {
    const { token } = await loggedIn({});
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const list = async (toolsets: string) => {
      const res = await worker.fetch(
        new Request(MCP_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
        { ...env, LOGBUTLER_TOOLSETS: toolsets },
        ctx,
      );
      expect(res.status).toBe(200);
      return (await readRpc(res)).result?.tools?.map((t) => t.name) ?? [];
    };

    const all = await list("all");
    expect(all).toHaveLength(38 + 15); // M03 の読み取り 38 + M04 の書き込み 14 と project_conventions
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
