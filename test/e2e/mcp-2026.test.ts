/**
 * MCP 仕様 2026-07-28(ステートレス、Mcp-Method / Mcp-Name、認可の iss)への準拠と、旧版(initialize あり)の互換を
 * Worker 全体への HTTP で固定する(M05.5)。どのレーンを通っているかをテストごとに明示する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearJwksCache } from "../../src/auth/access-jwt";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";
import {
  accessHeaders,
  BACKLOG_HOST,
  BACKLOG_TOKEN,
  CLIENT_REDIRECT,
  firstText,
  MCP_URL,
  MODERN_VERSION,
  mcpRequest,
  modernRequest,
  ORIGIN,
  readRpc,
  runAuthorizationFlow,
  setupMocks,
  type TokenSet,
  worker,
} from "../helpers/oauth-flow";

afterEach(() => {
  vi.restoreAllMocks();
  clearJwksCache();
});

const myself = () => jsonResponse({ id: 42, userId: "alice", name: "Alice" });

async function loggedIn(handlers: Parameters<typeof mockOutboundFetch>[0] = {}) {
  const { accessKey } = await setupMocks();
  const flow = await runAuthorizationFlow(await accessHeaders(accessKey));
  const tokens = (await flow.tokenResponse.json()) as TokenSet;
  vi.restoreAllMocks();
  return {
    token: tokens.access_token,
    tokens,
    clientId: flow.clientId,
    flow,
    ...mockOutboundFetch({ [`GET ${BACKLOG_HOST}/api/v2/users/myself`]: myself, ...handlers }),
  };
}

const errorBody = async (res: Response) =>
  (await res.json()) as { error?: { code: number; message: string } };

describe("E2E 12-1: 2026-07-28 レーン(initialize なし)", () => {
  it("Mcp-Method / MCP-Protocol-Version と _meta だけで tools/list が成功し、2026 版の応答になる", async () => {
    const { token } = await loggedIn();
    const res = await modernRequest(token, "tools/list");
    expect(res.status).toBe(200);
    const rpc = await readRpc(res);
    expect(rpc.result?.tools?.length).toBe(71);
    // 2026 版の応答だけが持つ印(旧版レーンには付かない)
    expect(JSON.stringify(rpc.result)).toContain("io.modelcontextprotocol/serverInfo");
  });

  it("Mcp-Name つきの tools/call が成功する(Backlog はモック)", async () => {
    const { token, calls } = await loggedIn();
    const res = await modernRequest(token, "tools/call", {
      name: "logbutler_user_me",
      arguments: {},
    });
    expect(res.status).toBe(200);
    const rpc = await readRpc(res);
    expect(rpc.result?.isError).toBeFalsy();
    expect(JSON.parse(firstText(rpc))).toMatchObject({ user_id: "alice" });
    expect(calls.some((c) => c.url.endsWith("/users/myself"))).toBe(true);
  });

  it("server/discover が 2026-07-28 を含む対応バージョンを返す", async () => {
    const { token } = await loggedIn();
    const res = await modernRequest(token, "server/discover");
    expect(res.status).toBe(200);
    expect(JSON.stringify(await readRpc(res))).toContain(MODERN_VERSION);
  });

  it("2026 レーンでも toolsets / read_only の URL クエリが効く", async () => {
    const { token } = await loggedIn();
    const res = await modernRequest(token, "tools/list", {}, { url: `${MCP_URL}?toolsets=wiki` });
    expect(res.status).toBe(200);
    const names = (await readRpc(res)).result?.tools?.map((t) => t.name) ?? [];
    expect(names).toHaveLength(8);
    expect(names.every((n) => n.startsWith("logbutler_wiki_"))).toBe(true);
  });
});

describe("E2E 12-1b: 2026-07-28 レーンの read_only", () => {
  it("?read_only=true で tools/list から書き込み・破壊的ツールが消え、tools/call は実行されない", async () => {
    const { token, calls } = await loggedIn();
    const url = `${MCP_URL}?read_only=true`;
    const list = await readRpc(await modernRequest(token, "tools/list", {}, { url }));
    const names = list.result?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("logbutler_issue_list");
    expect(names).not.toContain("logbutler_issue_create");
    expect(names).not.toContain("logbutler_watching_delete");
    expect(
      (list.result?.tools ?? []).every(
        (t) => (t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true,
      ),
    ).toBe(true);

    const res = await modernRequest(
      token,
      "tools/call",
      { name: "logbutler_watching_delete", arguments: { watching_id: 5 } },
      { url },
    );
    const rpc = await readRpc(res);
    expect(rpc.error).toEqual({
      code: -32602,
      message: "Tool logbutler_watching_delete not found",
    });
    expect(rpc.result).toBeUndefined();
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(calls.some((c) => c.url.includes("/watchings"))).toBe(false);
  });
});

describe("E2E 12-2: ヘッダーと本文の不一致は拒否される(request-body.ts が検証を迂回しない)", () => {
  const call = { name: "logbutler_user_me", arguments: {} };

  it("Mcp-Name が本文のツール名と違えば 400 / -32020 で、Backlog は呼ばれず、ツールは実行されない", async () => {
    const { token, calls } = await loggedIn();
    const res = await modernRequest(token, "tools/call", call, {
      headers: { "Mcp-Name": "logbutler_issue_list" },
    });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).error?.code).toBe(-32020);
    expect(calls).toHaveLength(0);
  });

  it("Mcp-Name がないと 400 / -32020", async () => {
    const { token, calls } = await loggedIn();
    const res = await modernRequest(token, "tools/call", call, { headers: { "Mcp-Name": null } });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).error?.code).toBe(-32020);
    expect(calls).toHaveLength(0);
  });

  it("Mcp-Method が本文の method と違えば 400 / -32020", async () => {
    const { token, calls } = await loggedIn();
    const res = await modernRequest(token, "tools/call", call, {
      headers: { "Mcp-Method": "tools/list" },
    });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).error?.code).toBe(-32020);
    expect(calls).toHaveLength(0);
  });

  it("Mcp-Method がないと 400 / -32020", async () => {
    const { token } = await loggedIn();
    const res = await modernRequest(token, "tools/list", {}, { headers: { "Mcp-Method": null } });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).error?.code).toBe(-32020);
  });

  it("MCP-Protocol-Version ヘッダーと _meta のバージョンが違えば 400 / -32020", async () => {
    const { token } = await loggedIn();
    const res = await modernRequest(
      token,
      "tools/list",
      {},
      {
        headers: { "MCP-Protocol-Version": "2025-11-25" },
      },
    );
    expect(res.status).toBe(400);
    expect((await errorBody(res)).error?.code).toBe(-32020);
  });
});

describe("E2E 12-3: 旧版レーン(initialize あり)も動く", () => {
  async function legacyFlow(version: string) {
    const { token, calls } = await loggedIn();
    const headers = (extra: Record<string, string> = {}) => ({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...extra,
    });
    const init = await worker.fetch(MCP_URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: "legacy-e2e", version: "0.0.0" },
        },
      }),
    });
    expect(init.status).toBe(200);
    const initRpc = (await readRpc(init)) as { result?: { protocolVersion?: string } };
    const notified = await worker.fetch(MCP_URL, {
      method: "POST",
      headers: headers({ "MCP-Protocol-Version": version }),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notified.status).toBe(202);
    const rpc = async (id: number, method: string, params: Record<string, unknown>) =>
      readRpc(
        await worker.fetch(MCP_URL, {
          method: "POST",
          headers: headers({ "MCP-Protocol-Version": version }),
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        }),
      );
    return { initRpc, rpc, calls };
  }

  for (const version of ["2025-11-25", "2025-06-18"]) {
    it(`${version}: initialize → tools/list → tools/call`, async () => {
      const { initRpc, rpc } = await legacyFlow(version);
      expect(initRpc.result?.protocolVersion).toBe(version);
      const list = await rpc(2, "tools/list", {});
      expect(list.result?.tools?.length).toBe(71);
      // 旧版の応答には 2026 版の印が付かない
      expect(JSON.stringify(list.result)).not.toContain("io.modelcontextprotocol/serverInfo");
      const called = await rpc(3, "tools/call", { name: "logbutler_user_me", arguments: {} });
      expect(called.result?.isError).toBeFalsy();
      expect(JSON.parse(firstText(called))).toMatchObject({ user_id: "alice" });
    });
  }
});

describe("E2E 12-4: 401 の WWW-Authenticate とリフレッシュが両レーンで同じ", () => {
  const RESOURCE_METADATA = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;

  it("トークンなしは両レーンとも同じ 401 チャレンジ(resource_metadata つき)", async () => {
    const legacy = await mcpRequest(null, "tools/list");
    const modern = await modernRequest(null, "tools/list");
    expect(legacy.status).toBe(401);
    expect(modern.status).toBe(401);
    const a = legacy.headers.get("WWW-Authenticate");
    expect(a).toContain(`resource_metadata="${RESOURCE_METADATA}"`);
    expect(modern.headers.get("WWW-Authenticate")).toBe(a);
  });

  it("Backlog が 401 を返したら、両レーンとも invalid_token の同じチャレンジ", async () => {
    const { token } = await loggedIn({
      [`GET ${BACKLOG_HOST}/api/v2/users/myself`]: () => jsonResponse({}, 401),
    });
    const params = { name: "logbutler_user_me", arguments: {} };
    const legacy = await mcpRequest(token, "tools/call", params);
    const modern = await modernRequest(token, "tools/call", params);
    expect(legacy.status).toBe(401);
    expect(modern.status).toBe(401);
    const a = legacy.headers.get("WWW-Authenticate") ?? "";
    expect(a).toContain('error="invalid_token"');
    expect(a).toContain(`resource_metadata="${RESOURCE_METADATA}"`);
    expect(modern.headers.get("WWW-Authenticate")).toBe(a);
  });

  it("リフレッシュトークンで得た新しいトークンが 2026 レーンで使える", async () => {
    const { tokens, clientId } = await loggedIn({
      [BACKLOG_TOKEN]: () =>
        jsonResponse({
          access_token: "backlog-at-2",
          refresh_token: "backlog-rt-2",
          token_type: "Bearer",
          expires_in: 3600,
        }),
    });
    const refreshed = await worker.fetch(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }),
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as TokenSet;
    const res = await modernRequest(next.access_token, "tools/call", {
      name: "logbutler_user_me",
      arguments: {},
    });
    expect(res.status).toBe(200);
    expect((await readRpc(res)).result?.isError).toBeFalsy();
  });
});

describe("E2E 12-5/6: 認可", () => {
  it("/authorize から戻るリダイレクトに iss(RFC 9207)が付き、メタデータも対応を宣言する", async () => {
    const { flow } = await loggedIn();
    const back = new URL(flow.callbackResponse.headers.get("Location") ?? "", ORIGIN);
    expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT);
    expect(back.searchParams.get("iss")).toBe(ORIGIN);
    const meta = (await (
      await worker.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(ORIGIN);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
  });

  it("DCR: application_type=native と localhost の redirect_uri を送るクライアントを登録できる", async () => {
    const res = await worker.fetch(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Native MCP Client",
        application_type: "native",
        redirect_uris: ["http://localhost:8123/callback", "http://127.0.0.1:8123/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; redirect_uris: string[] };
    // ライブラリは application_type を読まない(拒否も保存も応答への反映もしない)。M07 の確認項目(ADR 0008)。
    expect(body).not.toHaveProperty("application_type");
    expect(body.client_id).toBeTruthy();
    expect(body.redirect_uris).toContain("http://localhost:8123/callback");
  });
});
