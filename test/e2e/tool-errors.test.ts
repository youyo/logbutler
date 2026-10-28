import { afterEach, describe, expect, it, vi } from "vitest";
import { clearJwksCache } from "../../src/auth/access-jwt";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";
import {
  accessHeaders,
  BACKLOG_MYSELF,
  firstText,
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

/** 認可フローを通して MCP のアクセストークンを得てから、Backlog のモックを差し替える。 */
async function loggedIn(myself: (n: number) => Response) {
  const { accessKey } = await setupMocks();
  const flow = await runAuthorizationFlow(await accessHeaders(accessKey));
  const { access_token } = (await flow.tokenResponse.json()) as TokenSet;
  vi.restoreAllMocks();
  let n = 0;
  const mocks = mockOutboundFetch({ [BACKLOG_MYSELF]: () => myself(++n) });
  return { token: access_token, ...mocks };
}

const callMe = (token: string) =>
  mcpRequest(token, "tools/call", { name: "logbutler_user_me", arguments: {} });

describe("E2E 6: ツールのエラーは isError + spec §9 のエンベロープ", () => {
  it("Backlog の 403 は permission_error(retryable=false)", async () => {
    const { token } = await loggedIn(() =>
      jsonResponse({ errors: [{ message: "No permission.", code: 11 }] }, 403),
    );
    const res = await callMe(token);
    expect(res.status).toBe(200);
    const rpc = await readRpc(res);
    expect(rpc.result?.isError).toBe(true);
    expect(JSON.parse(firstText(rpc))).toEqual({
      schema_version: "1",
      error: {
        code: "permission_error",
        message: "Backlog API error (HTTP 403, code=11): No permission.",
        retryable: false,
      },
    });
  });

  it("Backlog の 503 は api_error(retryable=true)", async () => {
    const { token } = await loggedIn(() => jsonResponse({}, 503));
    const rpc = await readRpc(await callMe(token));
    expect(rpc.result?.isError).toBe(true);
    expect(JSON.parse(firstText(rpc)).error).toMatchObject({ code: "api_error", retryable: true });
  });

  it("arguments の型が JSON-RPC として不正なときは、ツールではなくプロトコルのエラー(Backlog は呼ばない)", async () => {
    const { token, callsTo } = await loggedIn(() => jsonResponse({}));
    const rpc = await readRpc(
      await mcpRequest(token, "tools/call", { name: "logbutler_user_me", arguments: "oops" }),
    );
    expect(rpc.result).toBeUndefined();
    expect(rpc.error).toBeDefined();
    expect(callsTo(BACKLOG_MYSELF)).toHaveLength(0);
  });

  it("エラー応答にアクセストークンを含めない", async () => {
    const { token } = await loggedIn(() =>
      jsonResponse({ errors: [{ message: "bad", code: 1 }] }, 500),
    );
    const text = await (await callMe(token)).text();
    expect(text).not.toContain("backlog-at-1");
    expect(text).not.toContain("backlog-rt-1");
  });
});

describe("E2E 7: Backlog の 429 は Retry-After に従って再試行する", () => {
  it("1 回目が 429 でも、再試行で成功すればツールは成功する(Backlog への呼び出しは直列で 2 回)", async () => {
    const { token, callsTo } = await loggedIn((n) =>
      n === 1
        ? new Response(JSON.stringify({ errors: [{ message: "Too many", code: 14 }] }), {
            status: 429,
            headers: { "Retry-After": "0" },
          })
        : jsonResponse({ id: 42, userId: "alice", name: "Alice" }),
    );
    const rpc = await readRpc(await callMe(token));
    expect(rpc.result?.isError).toBeFalsy();
    expect(JSON.parse(firstText(rpc)).user_id).toBe("alice");
    expect(callsTo(BACKLOG_MYSELF)).toHaveLength(2);
  });

  it("3 回とも 429 なら rate_limited(retryable=true)で終わる", async () => {
    const { token, callsTo } = await loggedIn(
      () => new Response("{}", { status: 429, headers: { "Retry-After": "0" } }),
    );
    const rpc = await readRpc(await callMe(token));
    expect(rpc.result?.isError).toBe(true);
    expect(JSON.parse(firstText(rpc)).error).toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
    expect(callsTo(BACKLOG_MYSELF)).toHaveLength(3);
  });
});

describe("E2E 8: tools/list はスナップショットと一致する", () => {
  it("認可済みの /mcp の tools/list が test/snapshots/tools_list.json と同じ", async () => {
    const { token } = await loggedIn(() => jsonResponse({}));
    const rpc = await readRpc(await mcpRequest(token, "tools/list"));
    const { normalizeTools } = await import("../helpers/baseline");
    const snapshot = (await import("../snapshots/tools_list.json")).default;
    expect(normalizeTools((rpc.result?.tools ?? []) as never)).toEqual(snapshot);
  });
});
