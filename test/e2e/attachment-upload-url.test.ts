// E2E: 添付アップロードの URL 経路(ADR 0018)。/mcp で prepare → PUT /uploads/<id> → /mcp で完了、を Worker 全体で通す。
// Backlog は outbound fetch のモック。R2 は wrangler.jsonc のダミーの r2_buckets(miniflare)。
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";
import {
  BACKLOG_HOST,
  worker as entry,
  firstText,
  MCP_URL,
  ORIGIN,
  readRpc,
  runAuthorizationFlow,
  setupMocks,
  type TokenSet,
} from "../helpers/oauth-flow";

afterEach(() => {
  vi.restoreAllMocks();
});

const API = `${BACKLOG_HOST}/api/v2`;
const PREPARE = "logbutler_issue_attachment_upload_prepare";
const UPLOAD = "logbutler_issue_attachment_upload";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function accessToken(): Promise<string> {
  await setupMocks();
  const flow = await runAuthorizationFlow();
  const { access_token } = (await flow.tokenResponse.json()) as TokenSet;
  vi.restoreAllMocks();
  return access_token;
}

function rpcInit(token: string, method: string, params: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  };
}

/** Worker 全体(wrangler.jsonc の env。UPLOAD_BUCKET あり)。 */
const viaWorker = (token: string, method: string, params: Record<string, unknown> = {}) =>
  entry.fetch(MCP_URL, rpcInit(token, method, params));

/** UPLOAD_BUCKET の binding を外した Worker。 */
function withoutBucketEnv(): Env {
  const { UPLOAD_BUCKET: _omit, ...rest } = env as unknown as Env;
  return rest as Env;
}
const viaBucketless = (url: string, init: RequestInit) =>
  worker.fetch(new Request(url, { redirect: "manual", ...init }), withoutBucketEnv(), ctx);

/** curl -T と同じく Content-Length 付きで PUT する。 */
function putInit(content: string): RequestInit {
  const body = new TextEncoder().encode(content);
  return { method: "PUT", body, headers: { "Content-Length": String(body.length) } };
}

const toolNames = async (res: Response) =>
  ((await readRpc(res)).result?.tools ?? []).map((t) => t.name);

describe("E2E: 添付アップロードの URL 経路(UPLOAD_BUCKET あり)", () => {
  it("prepare → PUT → upload_id で完了し、モックの Backlog に POST と PATCH が届く", async () => {
    const token = await accessToken();
    const issue = { id: 1, issueKey: "PROJ-1" };
    const mocks = mockOutboundFetch({
      [`POST ${API}/space/attachment`]: () =>
        jsonResponse({ id: 77, name: "report.txt", size: 11 }),
      [`PATCH ${API}/issues/PROJ-1`]: () => jsonResponse(issue),
    });

    expect(await toolNames(await viaWorker(token, "tools/list"))).toContain(PREPARE);

    const prepared = await readRpc(
      await viaWorker(token, "tools/call", { name: PREPARE, arguments: {} }),
    );
    expect(prepared.result?.isError).toBeFalsy();
    const out = JSON.parse(firstText(prepared)) as {
      upload_id: string;
      upload_url: string;
      curl: string;
    };
    expect(out.upload_url).toBe(`${ORIGIN}/uploads/${out.upload_id}`);
    expect(out.curl).toContain(out.upload_url);
    expect(mocks.calls).toEqual([]);

    // shell の curl -T に相当する PUT(OAuth の外側。Bearer なし)
    const put = await entry.fetch(out.upload_url, putInit("hello world"));
    expect(put.status).toBe(201);
    expect(put.headers.get("Cache-Control")).toBe("no-store");
    expect(await put.json()).toEqual({ upload_id: out.upload_id, size: 11 });

    const args = { issue_key: "PROJ-1", file_name: "report.txt", upload_id: out.upload_id };
    const done = await readRpc(
      await viaWorker(token, "tools/call", { name: UPLOAD, arguments: args }),
    );
    expect(done.result?.isError, firstText(done)).toBeFalsy();
    expect(JSON.parse(firstText(done))).toEqual(issue);
    const paths = mocks.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(paths).toEqual(["POST /api/v2/space/attachment", "PATCH /api/v2/issues/PROJ-1"]);
    expect(mocks.calls[0]?.body).toContain('filename="report.txt"');
    expect(mocks.calls[0]?.body).toContain("hello world");
    expect(new URLSearchParams(mocks.calls[1]?.body).getAll("attachmentId[]")).toEqual(["77"]);

    // 完了後は ticket が消えているので、遅れて届いた PUT は 404(data を作り直さない)
    expect((await entry.fetch(out.upload_url, putInit("late"))).status).toBe(404);

    // 同じ引数の再呼び出しは、冪等キャッシュ(WriteNonIdempotent。5 分)が最初の成功を返す。Backlog は呼ばない
    const again = await readRpc(
      await viaWorker(token, "tools/call", { name: UPLOAD, arguments: args }),
    );
    expect(again.result?.isError).toBeFalsy();
    expect(JSON.parse(firstText(again))).toEqual(issue);
    expect(mocks.calls).toHaveLength(2);
  });

  it("prepare は 2 回呼ぶと別の upload_id(冪等キャッシュで包まれず、KV の idem: にも残らない)", async () => {
    const token = await accessToken();
    mockOutboundFetch({});
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const rpc = await readRpc(
        await viaWorker(token, "tools/call", { name: PREPARE, arguments: {} }),
      );
      ids.push((JSON.parse(firstText(rpc)) as { upload_id: string }).upload_id);
    }
    expect(ids[0]).not.toBe(ids[1]);
    const kv = (env as unknown as Env).OAUTH_KV;
    const idem = await kv.list({ prefix: "idem:" });
    expect(idem.keys.map((k) => k.name).filter((n) => n.includes(PREPARE))).toEqual([]);
    for (const k of idem.keys) {
      const v = (await kv.get(k.name)) ?? "";
      for (const id of ids) expect(v).not.toContain(id);
    }
  });

  it("PUT: 2 回目は 409、未発行の ID は 404、GET は 404。Origin 付きでも CORS のヘッダは返さない", async () => {
    const token = await accessToken();
    mockOutboundFetch({});
    const prepared = await readRpc(
      await viaWorker(token, "tools/call", { name: PREPARE, arguments: {} }),
    );
    const { upload_url } = JSON.parse(firstText(prepared)) as { upload_url: string };
    const first = await entry.fetch(upload_url, {
      ...putInit("a"),
      headers: { "Content-Length": "1", Origin: "https://evil.example" },
    });
    expect(first.status).toBe(201);
    expect(first.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect((await entry.fetch(upload_url, putInit("b"))).status).toBe(409);
    expect((await entry.fetch(`${ORIGIN}/uploads/${"Z".repeat(43)}`, putInit("a"))).status).toBe(
      404,
    );
    expect((await entry.fetch(upload_url)).status).toBe(404);
  });
});

describe("E2E: UPLOAD_BUCKET の binding が無い Worker", () => {
  it("prepare は tools/list に出ず、PUT /uploads/* は 404、upload_id は Backlog を呼ばずにエラー。base64 の経路は動く", async () => {
    const token = await accessToken();
    const issue = { id: 1, issueKey: "PROJ-1" };
    const mocks = mockOutboundFetch({
      [`POST ${API}/space/attachment`]: () => jsonResponse({ id: 78 }),
      [`PATCH ${API}/issues/PROJ-1`]: () => jsonResponse(issue),
    });

    const names = await toolNames(await viaBucketless(MCP_URL, rpcInit(token, "tools/list", {})));
    expect(names).not.toContain(PREPARE);
    expect(names).toContain(UPLOAD);
    expect(names).toHaveLength(87);

    const put = await viaBucketless(`${ORIGIN}/uploads/${"A".repeat(43)}`, putInit("x"));
    expect(put.status).toBe(404);

    const viaId = await readRpc(
      await viaBucketless(
        MCP_URL,
        rpcInit(token, "tools/call", {
          name: UPLOAD,
          arguments: { issue_key: "PROJ-1", file_name: "a.txt", upload_id: "A".repeat(43) },
        }),
      ),
    );
    expect(viaId.result?.isError).toBe(true);
    expect(JSON.parse(firstText(viaId)).error.code).toBe("argument_error");
    expect(mocks.calls).toEqual([]);

    const viaBase64 = await readRpc(
      await viaBucketless(
        MCP_URL,
        rpcInit(token, "tools/call", {
          name: UPLOAD,
          arguments: { issue_key: "PROJ-1", file_name: "a.txt", file_content_base64: btoa("hi") },
        }),
      ),
    );
    expect(viaBase64.result?.isError, firstText(viaBase64)).toBeFalsy();
    expect(mocks.calls.map((c) => c.method)).toEqual(["POST", "PATCH"]);
  });

  it("tools/call で prepare を名指ししても失敗し、R2 にも Backlog にも触れない", async () => {
    const token = await accessToken();
    const mocks = mockOutboundFetch({});
    const rpc = await readRpc(
      await viaBucketless(MCP_URL, rpcInit(token, "tools/call", { name: PREPARE, arguments: {} })),
    );
    // 登録されていないツール(MCP の「ツールが見つからない」エラー)。upload_url は返らない
    expect(rpc.error).toEqual({ code: -32602, message: `Tool ${PREPARE} not found` });
    expect(rpc.result).toBeUndefined();
    expect(mocks.calls).toEqual([]);
  });

  it("/healthz は 200 のまま(UPLOAD_BUCKET は必須の設定ではない。ADR 0010 は変えない)", async () => {
    const res = await viaBucketless(`${ORIGIN}/healthz`, {});
    expect(res.status).toBe(200);
  });
});
