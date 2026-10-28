import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";
import {
  BACKLOG_MYSELF,
  BACKLOG_TOKEN,
  mcpRequest,
  ORIGIN,
  readRpc,
  runAuthorizationFlow,
  setupMocks,
  type TokenSet,
  worker,
} from "../helpers/oauth-flow";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {});

function refreshRequest(clientId: string, refreshToken: string) {
  return worker.fetch(`${ORIGIN}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
}

/** Backlog のトークンエンドポイントを、grant_type ごとに応答を変えるモックにする。 */
function backlogTokenResponder(opts: { rotate: boolean; refreshStatus?: number }) {
  return (call: { body: string }) => {
    const form = new URLSearchParams(call.body);
    if (form.get("grant_type") === "authorization_code") {
      return jsonResponse({
        access_token: "backlog-at-1",
        refresh_token: "backlog-rt-1",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (opts.refreshStatus && opts.refreshStatus !== 200) {
      return jsonResponse({ error: "invalid_grant" }, opts.refreshStatus);
    }
    return jsonResponse({
      access_token: "backlog-at-2",
      ...(opts.rotate ? { refresh_token: "backlog-rt-2" } : {}),
      token_type: "Bearer",
      expires_in: 3600,
    });
  };
}

describe("E2E 4: リフレッシュで Backlog のトークンも更新される", () => {
  it("Backlog のアクセストークンが期限切れの状態で MCP クライアントがリフレッシュすると、Backlog のトークンも更新され /mcp で新トークンが使われる", async () => {
    const { callsTo } = await setupMocks({
      backlogToken: backlogTokenResponder({ rotate: true }),
    });
    const flow = await runAuthorizationFlow();
    const first = (await flow.tokenResponse.json()) as TokenSet;
    // コード交換時は取りたてなので Backlog のリフレッシュは起きていない
    expect(callsTo(BACKLOG_TOKEN)).toHaveLength(1);

    // 2 時間後(Backlog のアクセストークンは期限切れ。MCP のリフレッシュトークンは 30 日有効)
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 3600 * 1000 });

    const refreshed = await refreshRequest(flow.clientId, first.refresh_token);
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as TokenSet;
    expect(second.access_token).not.toBe(first.access_token);

    const backlogCalls = callsTo(BACKLOG_TOKEN);
    expect(backlogCalls).toHaveLength(2);
    const form = new URLSearchParams(backlogCalls[1]?.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("backlog-rt-1");
    expect(form.get("client_secret")).toBe("test-backlog-client-secret");

    // 新しい MCP トークンで /mcp を呼ぶと、更新後の Backlog トークンが使われる
    const call = await mcpRequest(second.access_token, "tools/call", {
      name: "logbutler_user_me",
      arguments: {},
    });
    expect(call.status).toBe(200);
    expect((await readRpc(call)).result?.isError).toBeFalsy();
    expect(callsTo(BACKLOG_MYSELF).at(-1)?.headers.get("authorization")).toBe(
      "Bearer backlog-at-2",
    );

    // 2 回目のリフレッシュ(まだ期限内)では、ローテーション後のリフレッシュトークンが使われる
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
    const third = await refreshRequest(flow.clientId, second.refresh_token);
    expect(third.status).toBe(200);
    const form3 = new URLSearchParams(callsTo(BACKLOG_TOKEN)[2]?.body);
    expect(form3.get("refresh_token")).toBe("backlog-rt-2");
  });

  it("Backlog がリフレッシュトークンをローテーションしない場合も、元のリフレッシュトークンで更新を続けられる", async () => {
    const { callsTo } = await setupMocks({
      backlogToken: backlogTokenResponder({ rotate: false }),
    });
    const flow = await runAuthorizationFlow();
    const first = (await flow.tokenResponse.json()) as TokenSet;

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 3600 * 1000 });
    const r1 = await refreshRequest(flow.clientId, first.refresh_token);
    expect(r1.status).toBe(200);
    const second = (await r1.json()) as TokenSet;

    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
    const r2 = await refreshRequest(flow.clientId, second.refresh_token);
    expect(r2.status).toBe(200);
    const form2 = new URLSearchParams(callsTo(BACKLOG_TOKEN)[2]?.body);
    expect(form2.get("refresh_token")).toBe("backlog-rt-1");
  });

  it("Backlog の期限に余裕があるうちは、MCP のリフレッシュで Backlog を呼ばない", async () => {
    // Backlog のトークンが 3 時間有効なら、MCP の 30 分後のリフレッシュでは Backlog を更新しない
    const { callsTo } = await setupMocks({
      backlogToken: () =>
        jsonResponse({
          access_token: "backlog-at-1",
          refresh_token: "backlog-rt-1",
          token_type: "Bearer",
          expires_in: 3 * 3600,
        }),
    });
    const flow = await runAuthorizationFlow();
    const first = (await flow.tokenResponse.json()) as TokenSet;
    const r = await refreshRequest(flow.clientId, first.refresh_token);
    expect(r.status).toBe(200);
    expect(callsTo(BACKLOG_TOKEN)).toHaveLength(1);
  });

  it("Backlog 側で失効(invalid_grant)していたらリフレッシュは invalid_grant になり、再認可が必要になる", async () => {
    await setupMocks({
      backlogToken: backlogTokenResponder({ rotate: true, refreshStatus: 400 }),
    });
    const flow = await runAuthorizationFlow();
    const first = (await flow.tokenResponse.json()) as TokenSet;

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 3600 * 1000 });
    const res = await refreshRequest(flow.clientId, first.refresh_token);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");

    // grant は失効済み: 同じリフレッシュトークンはもう使えない
    const again = await refreshRequest(flow.clientId, first.refresh_token);
    expect(again.status).toBe(400);
  });

  it("Backlog の一時障害は 503 temporarily_unavailable で、grant は残る(再試行できる)", async () => {
    let backlogDown = true;
    await setupMocks({
      backlogToken: (call) => {
        const form = new URLSearchParams(call.body);
        if (form.get("grant_type") === "authorization_code") {
          return jsonResponse({
            access_token: "backlog-at-1",
            refresh_token: "backlog-rt-1",
            expires_in: 3600,
          });
        }
        return backlogDown
          ? jsonResponse({}, 503)
          : jsonResponse({ access_token: "backlog-at-2", expires_in: 3600 });
      },
    });
    const flow = await runAuthorizationFlow();
    const first = (await flow.tokenResponse.json()) as TokenSet;

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 3600 * 1000 });
    const down = await refreshRequest(flow.clientId, first.refresh_token);
    expect(down.status).toBe(503);
    expect(((await down.json()) as { error: string }).error).toBe("temporarily_unavailable");

    backlogDown = false;
    const retry = await refreshRequest(flow.clientId, first.refresh_token);
    expect(retry.status).toBe(200);
  });

  it("/mcp で Backlog が 401 を返したら、MCP も 401 + invalid_token を返してクライアントにリフレッシュさせる", async () => {
    await setupMocks({
      backlogToken: backlogTokenResponder({ rotate: true }),
    });
    const flow = await runAuthorizationFlow();
    const first = (await flow.tokenResponse.json()) as TokenSet;

    // Backlog 側でトークンが取り消された状態にする
    vi.restoreAllMocks();
    mockOutboundFetch({ [BACKLOG_MYSELF]: () => jsonResponse({}, 401) });

    const res = await mcpRequest(first.access_token, "tools/call", {
      name: "logbutler_user_me",
      arguments: {},
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    expect(res.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});
