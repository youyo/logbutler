/**
 * M06: 公式 MCP 由来の追加ツール(notification_list / notification_count / project_users)と、
 * 応答サイズの上限(max_response_tokens)。Worker 全体への HTTP(認可フローで得たトークン)で固定する。
 */
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

afterEach(() => vi.restoreAllMocks());

const API = `${BACKLOG_HOST}/api/v2`;

async function loggedIn(handlers: Parameters<typeof mockOutboundFetch>[0] = {}) {
  await setupMocks();
  const flow = await runAuthorizationFlow();
  const { access_token } = (await flow.tokenResponse.json()) as TokenSet;
  vi.restoreAllMocks();
  return { token: access_token, ...mockOutboundFetch(handlers) };
}

describe("E2E 15: 公式 MCP 由来の 3 ツール", () => {
  it("/mcp?toolsets=notification で通知系 2 個だけが見える", async () => {
    const { token } = await loggedIn();
    const res = await mcpRequest(token, "tools/list", {}, `${MCP_URL}?toolsets=notification`);
    expect(res.status).toBe(200);
    const names = ((await readRpc(res)).result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["logbutler_notification_count", "logbutler_notification_list"]);
  });

  it("project_users は project の toolset に載り、通知系は read_only=true でも残る", async () => {
    const { token } = await loggedIn();
    const project = await mcpRequest(token, "tools/list", {}, `${MCP_URL}?toolsets=project`);
    const names = ((await readRpc(project)).result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("logbutler_project_users");
    expect(names).not.toContain("logbutler_notification_list");

    const ro = await mcpRequest(
      token,
      "tools/list",
      {},
      `${MCP_URL}?toolsets=notification&read_only=true`,
    );
    expect(((await readRpc(ro)).result?.tools ?? []).map((t) => t.name).sort()).toEqual([
      "logbutler_notification_count",
      "logbutler_notification_list",
    ]);
  });

  it("notification_count を /mcp から呼ぶと Backlog の /notifications/count を叩いて {count} を返す", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/notifications/count`]: () => jsonResponse({ count: 4 }),
    });
    const res = await mcpRequest(token, "tools/call", {
      name: "logbutler_notification_count",
      arguments: { already_read: false },
    });
    expect(JSON.parse(firstText(await readRpc(res)))).toEqual({ count: 4 });
    expect(
      calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`),
    ).toEqual(["GET /api/v2/notifications/count?alreadyRead=false"]);
  });
});

describe("E2E 16: 応答サイズの上限", () => {
  const projects = Array.from({ length: 50 }, (_, i) => ({
    id: i,
    projectKey: `P${i}`,
    name: `プロジェクト${i}`,
  }));

  it("上限を超えると isError で response_too_large のエンベロープを返し、本文は返さない", async () => {
    const { token } = await loggedIn({ [`GET ${API}/projects`]: () => jsonResponse(projects) });
    const res = await mcpRequest(token, "tools/call", {
      name: "logbutler_project_list",
      arguments: { max_response_tokens: 100 },
    });
    expect(res.status).toBe(200);
    const rpc = await readRpc(res);
    expect(rpc.result?.isError).toBe(true);
    const body = JSON.parse(firstText(rpc));
    expect(body.schema_version).toBe("1");
    expect(body.error.code).toBe("response_too_large");
    expect(body.error.retryable).toBe(false);
    expect(body.error.message).toContain("100");
    expect(firstText(rpc)).not.toContain("プロジェクト1");
  });

  it("上限内(引数なしの既定・0 で無効)なら通常どおり返す", async () => {
    const { token } = await loggedIn({ [`GET ${API}/projects`]: () => jsonResponse(projects) });
    for (const args of [{}, { max_response_tokens: 0 }]) {
      const res = await mcpRequest(token, "tools/call", {
        name: "logbutler_project_list",
        arguments: args,
      });
      const rpc = await readRpc(res);
      expect(rpc.result?.isError ?? false).toBe(false);
      expect(JSON.parse(firstText(rpc))).toHaveLength(50);
    }
  });
});
