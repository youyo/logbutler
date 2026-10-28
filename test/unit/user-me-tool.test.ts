import { describe, expect, it } from "vitest";
import { BacklogApiError, BacklogUnauthorizedError } from "../../src/backlog/client";
import { createMcpServer } from "../../src/mcp/server";
import { USER_ME_TOOL } from "../../src/mcp/tools/user-me";
import { fakeClient, rpcTo } from "../helpers/mcp";
import { firstText } from "../helpers/oauth-flow";

type Deps = Parameters<typeof createMcpServer>[0];

const rpc = (deps: Deps, method: string, params: Record<string, unknown> = {}) =>
  rpcTo(() => createMcpServer(deps), method, params);

const okDeps: Deps = {
  getClient: () =>
    fakeClient({
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

const failingDeps = (err: Error, onBacklogUnauthorized = () => {}): Deps => ({
  getClient: () =>
    fakeClient({
      getMyself: async () => {
        throw err;
      },
    }),
  onBacklogUnauthorized,
});

describe("MCP server (logbutler_user_me)", () => {
  it("tools/list は logbutler_user_me を公開する(読み取り専用の annotation 付き)", async () => {
    const { result } = await rpc(okDeps, "tools/list");
    const names = (result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names).toEqual([USER_ME_TOOL]);
    expect(result?.tools?.[0]?.annotations?.readOnlyHint).toBe(true);
  });

  it("tools/call は snake_case の JSON を text content で返す", async () => {
    const { result } = await rpc(okDeps, "tools/call", { name: USER_ME_TOOL, arguments: {} });
    expect(result?.isError).toBeFalsy();
    expect(JSON.parse(firstText({ result }))).toEqual({
      id: 42,
      user_id: "alice",
      name: "Alice",
      mail_address: "a@example.com",
      role_type: 2,
    });
  });

  it("Backlog の 401 は authentication_error のエンベロープで返し、onBacklogUnauthorized を呼ぶ", async () => {
    let called = 0;
    const { result } = await rpc(
      failingDeps(new BacklogUnauthorizedError(), () => {
        called++;
      }),
      "tools/call",
      { name: USER_ME_TOOL, arguments: {} },
    );
    expect(called).toBe(1);
    expect(result?.isError).toBe(true);
    expect(JSON.parse(firstText({ result }))).toEqual({
      schema_version: "1",
      error: {
        code: "authentication_error",
        message: "Backlog API error (HTTP 401).",
        retryable: false,
      },
    });
  });

  it("Backlog の 503 は api_error(retryable)のエンベロープで返す", async () => {
    const { result } = await rpc(failingDeps(new BacklogApiError(503)), "tools/call", {
      name: USER_ME_TOOL,
      arguments: {},
    });
    expect(result?.isError).toBe(true);
    const body = JSON.parse(firstText({ result }));
    expect(body.schema_version).toBe("1");
    expect(body.error.code).toBe("api_error");
    expect(body.error.retryable).toBe(true);
  });
});
