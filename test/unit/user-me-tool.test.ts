import { createMcpHandler } from "agents/mcp/server";
import { describe, expect, it } from "vitest";
import { BacklogApiError, BacklogUnauthorizedError } from "../../src/backlog/client";
import { createMcpServer } from "../../src/mcp/server";
import { firstText, type RpcResponse } from "../helpers/oauth-flow";

/** 応答は JSON または SSE(`data: {...}` 行)のどちらでも来る。 */
function parseRpcResponse(text: string): RpcResponse {
  const data = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim();
  return JSON.parse(data ?? "null");
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

async function rpc(
  deps: Parameters<typeof createMcpServer>[0],
  method: string,
  params: Record<string, unknown> = {},
) {
  const handler = createMcpHandler(() => createMcpServer(deps), { route: "/mcp" });
  const res = await handler(
    new Request("https://logbutler.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    {},
    ctx,
  );
  expect(res.status).toBe(200);
  return parseRpcResponse(await res.text());
}

const okDeps = {
  getClient: () => ({
    getMyself: async () => ({
      id: 42,
      userId: "alice",
      name: "Alice",
      mailAddress: "a@example.com",
      roleType: 2,
    }),
  }),
  onBacklogUnauthorized: () => {},
};

describe("MCP server (logbutler_user_me)", () => {
  it("tools/list は logbutler_user_me を公開する(読み取り専用の annotation 付き)", async () => {
    const { result } = await rpc(okDeps, "tools/list");
    const names = (result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names).toEqual(["logbutler_user_me"]);
    expect(result?.tools?.[0]?.annotations?.readOnlyHint).toBe(true);
  });

  it("tools/call は snake_case の JSON を text content で返す", async () => {
    const { result } = await rpc(okDeps, "tools/call", {
      name: "logbutler_user_me",
      arguments: {},
    });
    expect(result?.isError).toBeFalsy();
    expect(JSON.parse(firstText({ result }))).toEqual({
      id: 42,
      user_id: "alice",
      name: "Alice",
      mail_address: "a@example.com",
      role_type: 2,
    });
  });

  it("Backlog の 401 はエラーエンベロープ(retryable)で返し、onBacklogUnauthorized を呼ぶ", async () => {
    let called = 0;
    const { result } = await rpc(
      {
        getClient: () => ({
          getMyself: async () => {
            throw new BacklogUnauthorizedError();
          },
        }),
        onBacklogUnauthorized: () => {
          called++;
        },
      },
      "tools/call",
      { name: "logbutler_user_me", arguments: {} },
    );
    expect(called).toBe(1);
    expect(result?.isError).toBe(true);
    expect(JSON.parse(firstText({ result }))).toEqual({
      schema_version: "1",
      error: {
        code: "backlog_unauthorized",
        message: "Backlog rejected the access token. Refresh the MCP token and retry.",
        retryable: true,
      },
    });
  });

  it("Backlog のその他のエラーも snake_case のエンベロープで返す", async () => {
    const { result } = await rpc(
      {
        getClient: () => ({
          getMyself: async () => {
            throw new BacklogApiError(503);
          },
        }),
        onBacklogUnauthorized: () => {},
      },
      "tools/call",
      { name: "logbutler_user_me", arguments: {} },
    );
    expect(result?.isError).toBe(true);
    const body = JSON.parse(firstText({ result }));
    expect(body.schema_version).toBe("1");
    expect(body.error.code).toBe("backlog_api_error");
    expect(body.error.retryable).toBe(true);
  });
});
