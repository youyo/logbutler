import { env } from "cloudflare:workers";
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

async function loggedIn(handlers: Parameters<typeof mockOutboundFetch>[0]) {
  await setupMocks();
  const flow = await runAuthorizationFlow();
  const { access_token } = (await flow.tokenResponse.json()) as TokenSet;
  vi.restoreAllMocks();
  return { token: access_token, ...mockOutboundFetch(handlers) };
}

const call = (
  token: string,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
) => mcpRequest(token, "tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });

const paths = (calls: { method: string; url: string }[]) =>
  calls.map((c) => `${c.method} ${new URL(c.url).pathname.replace("/api/v2", "")}`);

describe("E2E 10: 書き込みツール(M04)が OAuth 済みトークンの /mcp で動く", () => {
  it("issue_create: 冪等キーなし。同じ引数の再送は Backlog に 1 回しか届かない（引数ハッシュ）", async () => {
    const created = { id: 500, issueKey: "PROJ-9", summary: "新規" };
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects/PROJ`]: () => jsonResponse({ id: 10, projectKey: "PROJ" }),
      [`GET ${API}/priorities`]: () =>
        jsonResponse([
          { id: 10, name: "High" },
          { id: 11, name: "Normal" },
          { id: 12, name: "Low" },
        ]),
      [`POST ${API}/issues`]: () => jsonResponse(created),
    });
    const args = { project_key: "PROJ", summary: "新規", issue_type_id: 2, category_ids: "3,4" };
    const first = await readRpc(await call(token, "logbutler_issue_create", args));
    expect(first.result?.isError).toBeFalsy();
    expect(JSON.parse(firstText(first))).toEqual(created);

    const post = calls.find((c) => c.method === "POST");
    const form = new URLSearchParams(post?.body);
    expect(post?.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(post?.headers.get("authorization")).toMatch(/^Bearer backlog-at-/);
    expect(form.get("projectId")).toBe("10");
    expect(form.get("summary")).toBe("新規");
    expect(form.get("issueTypeId")).toBe("2");
    expect(form.getAll("categoryId[]")).toEqual(["3", "4"]);
    // priority_id 省略時は GET /priorities の一覧(スペースごとに ID が違いうる)から既定値を決めて送る。priorityId なしは Backlog が error.invalid で拒否する(V08)
    expect(paths(calls)).toContain("GET /priorities");
    expect(form.get("priorityId")).toBe("11");

    const again = await readRpc(await call(token, "logbutler_issue_create", args));
    expect(firstText(again)).toBe(firstText(first));
    expect(paths(calls).filter((p) => p === "POST /issues")).toHaveLength(1);

    // 保存したキーにユーザー ID(42)が入り、トークンは入らない
    const listed = await env.OAUTH_KV.list({ prefix: "idem:" });
    const key = listed.keys.map((k) => k.name).find((n) => n.includes("logbutler_issue_create"));
    expect(key).toMatch(/^idem:42:logbutler_issue_create:hash:[0-9a-f]{64}$/);
    expect(await env.OAUTH_KV.get(key ?? "")).not.toContain("backlog-at-");
  });

  it("issue_create: params._meta.idempotency_key があれば、引数が違っても重複とみなす", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects/PROJ`]: () => jsonResponse({ id: 10 }),
      [`POST ${API}/issues`]: () => jsonResponse({ id: 501, issueKey: "PROJ-10" }),
    });
    const base = { project_key: "PROJ", issue_type_id: 2, priority_id: 3 };
    const meta = { idempotency_key: "e2e-req-1" };
    const a = await readRpc(
      await call(token, "logbutler_issue_create", { ...base, summary: "A" }, meta),
    );
    const b = await readRpc(
      await call(token, "logbutler_issue_create", { ...base, summary: "B" }, meta),
    );
    expect(firstText(b)).toBe(firstText(a));
    expect(paths(calls).filter((p) => p === "POST /issues")).toHaveLength(1);
    expect(await env.OAUTH_KV.get("idem:42:logbutler_issue_create:explicit:e2e-req-1")).toContain(
      "PROJ-10",
    );
  });

  it("issue_attachment_upload(base64): multipart で一時領域へ送り、attachmentId[] で課題を更新する", async () => {
    const { token, calls } = await loggedIn({
      [`POST ${API}/space/attachment`]: () => jsonResponse({ id: 77, name: "hello.txt", size: 5 }),
      [`PATCH ${API}/issues/PROJ-1`]: () => jsonResponse({ id: 1, issueKey: "PROJ-1" }),
    });
    const rpc = await readRpc(
      await call(token, "logbutler_issue_attachment_upload", {
        issue_key: "PROJ-1",
        file_name: "../dir\\hello.txt",
        file_content_base64: btoa("hello"),
      }),
    );
    expect(rpc.result?.isError, firstText(rpc)).toBeFalsy();
    expect(JSON.parse(firstText(rpc))).toEqual({ id: 1, issueKey: "PROJ-1" });
    expect(paths(calls)).toEqual(["POST /space/attachment", "PATCH /issues/PROJ-1"]);
    const upload = calls[0];
    expect(upload?.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(upload?.body).toContain('name="file"; filename="hello.txt"');
    expect(upload?.body).toContain("hello");
    expect(new URLSearchParams(calls[1]?.body).getAll("attachmentId[]")).toEqual(["77"]);
  });

  it("issue_attachment_upload: ちょうど 4 MiB のファイル（base64 で約 5.6 MB）も MCP の本文サイズ上限で拒否されない", async () => {
    const { token, calls } = await loggedIn({
      [`POST ${API}/space/attachment`]: () => jsonResponse({ id: 78, name: "big.bin" }),
      [`PATCH ${API}/issues/PROJ-1`]: () => jsonResponse({ id: 1, issueKey: "PROJ-1" }),
    });
    const res = await call(token, "logbutler_issue_attachment_upload", {
      issue_key: "PROJ-1",
      file_name: "big.bin",
      file_content_base64: btoa("a".repeat(4 * 1024 * 1024)),
    });
    expect(res.status).toBe(200);
    const rpc = await readRpc(res);
    expect(rpc.result?.isError, firstText(rpc).slice(0, 200)).toBeFalsy();
    expect(paths(calls)).toEqual(["POST /space/attachment", "PATCH /issues/PROJ-1"]);
  });

  it("issue_attachment_upload: 0 バイトのファイルは Backlog に送らず argument_error", async () => {
    const { token, calls } = await loggedIn({});
    const rpc = await readRpc(
      await call(token, "logbutler_issue_attachment_upload", {
        issue_key: "PROJ-1",
        file_name: "empty.txt",
        file_content_base64: "",
      }),
    );
    expect(rpc.result?.isError).toBe(true);
    expect(JSON.parse(firstText(rpc)).error.code).toBe("argument_error");
    expect(calls).toHaveLength(0);
  });

  it('issue_update: 現在と同じ値だけの更新(Backlog が 400 "No comment content.")は、課題を GET して成功として返す', async () => {
    const current = { id: 1, issueKey: "PROJ-1", description: "same" };
    const { token, calls } = await loggedIn({
      [`PATCH ${API}/issues/PROJ-1`]: () =>
        jsonResponse({ errors: [{ message: "No comment content.", code: 7 }] }, 400),
      [`GET ${API}/issues/PROJ-1`]: () => jsonResponse(current),
    });
    const rpc = await readRpc(
      await call(token, "logbutler_issue_update", { issue_key: "PROJ-1", description: "same" }),
    );
    expect(rpc.result?.isError, firstText(rpc)).toBeFalsy();
    expect(JSON.parse(firstText(rpc))).toEqual(current);
    expect(paths(calls)).toEqual(["PATCH /issues/PROJ-1", "GET /issues/PROJ-1"]);
  });

  it("star_add: tools/list の注釈は idempotentHint=false(同じ対象に 2 回付けるとスターが 2 個になる)", async () => {
    const { token } = await loggedIn({});
    const res = await mcpRequest(token, "tools/list", {});
    const rpc = await readRpc(res);
    const tool = (rpc.result?.tools ?? []).find(
      (t: { name: string }) => t.name === "logbutler_star_add",
    ) as { annotations: Record<string, unknown> } | undefined;
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
  });

  it("watching_delete: DELETE /watchings/{id} を呼び、削除されたウォッチを返す", async () => {
    const deleted = { id: 5, resourceAlreadyRead: false, type: "issue" };
    const { token, calls } = await loggedIn({
      [`DELETE ${API}/watchings/5`]: () => jsonResponse(deleted),
    });
    const rpc = await readRpc(await call(token, "logbutler_watching_delete", { watching_id: 5 }));
    expect(JSON.parse(firstText(rpc))).toEqual(deleted);
    expect(paths(calls)).toEqual(["DELETE /watchings/5"]);
  });

  it("エラーは冪等キャッシュに残らない: 失敗した issue_create は再試行で Backlog に届く", async () => {
    let n = 0;
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects/PROJ`]: () => jsonResponse({ id: 10 }),
      [`POST ${API}/issues`]: () =>
        ++n === 1
          ? jsonResponse({ errors: [{ message: "busy", code: 1 }] }, 503)
          : jsonResponse({ id: 502, issueKey: "PROJ-11" }),
    });
    const args = { project_key: "PROJ", summary: "retry", issue_type_id: 2, priority_id: 3 };
    const first = await readRpc(await call(token, "logbutler_issue_create", args));
    expect(first.result?.isError).toBe(true);
    const second = await readRpc(await call(token, "logbutler_issue_create", args));
    expect(second.result?.isError).toBeFalsy();
    expect(paths(calls).filter((p) => p === "POST /issues")).toHaveLength(2);
  });

  it("URL クエリ ?read_only=true: 書き込み・破壊的 14 ツールが tools/list から消え、呼んでも実行されない", async () => {
    const { token, calls } = await loggedIn({});
    const rpcWith = async (readOnly: string, method: string, params: Record<string, unknown>) => {
      const res = await mcpRequest(token, method, params, `${MCP_URL}?read_only=${readOnly}`);
      expect(res.status).toBe(200);
      return readRpc(res);
    };
    const WRITE = [
      "issue_create",
      "issue_comment_add",
      "issue_attachment_upload",
      "document_create",
      "issue_update",
      "issue_comment_update",
      "issue_related_add",
      "star_add",
      "watching_add",
      "watching_update",
      "watching_mark_as_read",
      "issue_related_delete",
      "issue_attachment_delete",
      "watching_delete",
    ].map((n) => `logbutler_${n}`);

    const rw = (await rpcWith("false", "tools/list", {})).result?.tools?.map((t) => t.name) ?? [];
    for (const n of WRITE) expect(rw, n).toContain(n);
    expect(rw).toContain("logbutler_project_conventions");
    expect(rw).toHaveLength(38 + 14 + 1 + 11 + 7 + 3 + 12); // + M05A の分析 11 + M05B の 7 + M06 の 3(すべて ReadOnly)+ プロジェクト設定 12(書き込み・破壊的。E2E 16 に read_only の検証)

    const ro = (await rpcWith("true", "tools/list", {})).result?.tools?.map((t) => t.name) ?? [];
    for (const n of WRITE) expect(ro, n).not.toContain(n);
    expect(ro).toContain("logbutler_project_conventions");
    expect(ro).toHaveLength(38 + 1 + 11 + 7 + 3);

    const blocked = await rpcWith("true", "tools/call", {
      name: "logbutler_watching_delete",
      arguments: { watching_id: 5 },
    });
    // 実行が拒否されたのではなく、read_only ではツールが登録されていない(MCP の「ツールが見つからない」エラー)
    expect(blocked.error).toEqual({
      code: -32602,
      message: "Tool logbutler_watching_delete not found",
    });
    expect(blocked.result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("E2E 10b: 親子課題(3 階層目の設定の有効・無効。ADR 0015)", () => {
  it("issue_update: 親子関係の制約違反(HTTP 400・code=7)は argument_error のエンベロープで、元のキーと確認手段が入る", async () => {
    for (const n of [3, 5, 6]) {
      const { token } = await loggedIn({
        [`PATCH ${API}/issues/PROJ-5`]: () =>
          jsonResponse(
            { errors: [{ message: `err.editIssue.parentChildIssue.${n}`, code: 7 }] },
            400,
          ),
      });
      const rpc = await readRpc(
        await call(token, "logbutler_issue_update", { issue_key: "PROJ-5", parent_issue_id: 9 }),
      );
      expect(rpc.result?.isError).toBe(true);
      const body = JSON.parse(firstText(rpc));
      expect(body.error.code).toBe("argument_error");
      expect(body.error.retryable).toBe(false);
      expect(body.error.message).toContain(`err.editIssue.parentChildIssue.${n}`);
      expect(body.error.message).toContain("grandchildIssueEnabled");
    }
  });

  it("issue_update: engagement を指定しても、孫課題の親は付け替えない(祖先に案件の親課題がいる)", async () => {
    const yaml =
      "schema_version: 1\nproject:\n  key: PROJ\nengagements:\n  - name: 顧客A\n    lead: 山田\n    initiative: 運用保守\n";
    const rule = {
      id: 100,
      issueKey: "PROJ-1",
      issueType: { name: "規約" },
      description: `\`\`\`yaml\n${yaml}\`\`\`\n`,
    };
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects/PROJ`]: () => jsonResponse({ id: 10, projectKey: "PROJ" }),
      [`GET ${API}/projects/PROJ/issueTypes`]: () =>
        jsonResponse([
          { id: 10, name: "規約" },
          { id: 11, name: "案件" },
        ]),
      [`GET ${API}/issues`]: (c) =>
        jsonResponse(
          new URL(c.url).searchParams.get("issueTypeId[]") === "10"
            ? [rule]
            : [{ id: 101, summary: "[案件] 顧客A", issueType: { name: "案件" } }],
        ),
      [`GET ${API}/projects/PROJ/categories`]: () => jsonResponse([{ id: 20, name: "顧客A" }]),
      [`GET ${API}/issues/PROJ-7`]: () =>
        jsonResponse({ id: 7, issueKey: "PROJ-7", parentIssueId: 50 }),
      [`GET ${API}/issues/50`]: () =>
        jsonResponse({ id: 50, issueKey: "PROJ-3", parentIssueId: 101 }),
      [`PATCH ${API}/issues/PROJ-7`]: () => jsonResponse({ id: 7, issueKey: "PROJ-7" }),
    });
    const rpc = await readRpc(
      await call(token, "logbutler_issue_update", { issue_key: "PROJ-7", engagement: "顧客A" }),
    );
    expect(rpc.result?.isError).toBeFalsy();
    const patch = calls.find((c) => c.method === "PATCH");
    const form = new URLSearchParams(patch?.body);
    expect(form.getAll("categoryId[]")).toEqual(["20"]);
    expect(form.has("parentIssueId")).toBe(false);
    // 直列: 対象 → 親 → PATCH の順に、祖先をたどってから更新する
    expect(paths(calls).slice(-3)).toEqual([
      "GET /issues/PROJ-7",
      "GET /issues/50",
      "PATCH /issues/PROJ-7",
    ]);
  });
});
