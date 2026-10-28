import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeBacklogOAuth,
  type FakeBacklogOAuthOptions,
} from "../helpers/fake-backlog-oauth";
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

/**
 * Backlog を観測どおりの fake(期限内の更新は同じトークン + 残り秒数、失効後は新しいトークン)にして、
 * トークンエンドポイントと /users/myself をモックする。
 */
function mockFakeBacklog(opts: FakeBacklogOAuthOptions = {}) {
  const backlog = createFakeBacklogOAuth(opts);
  const mocks = mockOutboundFetch({
    [BACKLOG_TOKEN]: (call) => backlog.token(call),
    [BACKLOG_MYSELF]: (call) => backlog.myself(call),
  });
  return { backlog, ...mocks };
}

describe("E2E 4: リフレッシュで Backlog のトークンも更新される", () => {
  it("Backlog のアクセストークンが期限切れの状態で MCP クライアントがリフレッシュすると、Backlog のトークンも更新され /mcp で新トークンが使われる", async () => {
    const { callsTo } = mockFakeBacklog({ rotate: true });
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
    const { callsTo } = mockFakeBacklog({ rotate: false });
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
    mockFakeBacklog({ rotate: true, refreshStatus: 400 });
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
    mockFakeBacklog({ rotate: true });
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

  it("保存した期限より前に Backlog が 401 を返し始めても、401 → リフレッシュ → 再呼び出しで回復する", async () => {
    // Backlog の発行済みトークン(backlog-at-1)が、保存した期限(1 時間後)より前に失効したシナリオ。
    // fake の revoke(): 取り消し後は API が 401、次のリフレッシュは新しいトークンを発行する。
    const { backlog, callsTo } = mockFakeBacklog({ rotate: true });
    const flow = await runAuthorizationFlow();
    const first = (await flow.tokenResponse.json()) as TokenSet;
    expect(callsTo(BACKLOG_TOKEN)).toHaveLength(1);

    // 期限(props 上はまだ約 1 時間)の前に Backlog 側で失効する
    backlog.revoke();
    const callMe = (token: string) =>
      mcpRequest(token, "tools/call", { name: "logbutler_user_me", arguments: {} });

    const denied = await callMe(first.access_token);
    expect(denied.status).toBe(401);

    // MCP クライアントは 401 を受けてリフレッシュする(期限に余裕があっても Backlog を更新させる)
    const refreshed = await refreshRequest(flow.clientId, first.refresh_token);
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as TokenSet;
    const backlogCalls = callsTo(BACKLOG_TOKEN);
    expect(backlogCalls).toHaveLength(2);
    expect(new URLSearchParams(backlogCalls[1]?.body).get("grant_type")).toBe("refresh_token");

    const retried = await callMe(second.access_token);
    expect(retried.status).toBe(200);
    expect((await readRpc(retried)).result?.isError).toBeFalsy();
    expect(callsTo(BACKLOG_MYSELF).at(-1)?.headers.get("authorization")).toBe(
      "Bearer backlog-at-2",
    );

    // 回復後のリフレッシュでは(期限に余裕があり印も消えているので)Backlog を呼ばない
    const again = await refreshRequest(flow.clientId, second.refresh_token);
    expect(again.status).toBe(200);
    expect(callsTo(BACKLOG_TOKEN)).toHaveLength(2);
  });
});

describe("E2E 4b: Backlog は期限内の更新で同じトークンを返す(2026-10-29 の観測。ADR 0014)", () => {
  const callMe = (token: string) =>
    mcpRequest(token, "tools/call", { name: "logbutler_user_me", arguments: {} });

  /** 通常の MCP クライアントのように、受け取った expires_in に従ってトークンを更新していく。 */
  async function refreshAt(clientId: string, refreshToken: string, atMs: number) {
    vi.setSystemTime(atMs);
    const res = await refreshRequest(clientId, refreshToken);
    expect(res.status).toBe(200);
    return (await res.json()) as TokenSet;
  }

  it("10 分ごとに更新しても期限内は Backlog を呼ばず、MCP の寿命は Backlog の残り + 余裕。失効直後の更新で新しいトークンになる", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const { backlog, callsTo } = mockFakeBacklog();
    const flow = await runAuthorizationFlow();
    let tokens = (await flow.tokenResponse.json()) as TokenSet;
    expect(tokens.expires_in).toBe(1800);

    // 観測したクライアントの間隔(約 10 分)で更新する。Backlog の残りが MCP の 30 分を切っても呼ばない
    const expected: Record<number, number> = {
      10: 1800,
      20: 1800,
      30: 1800,
      40: 20 * 60 + 5,
      50: 10 * 60 + 5,
    };
    for (const [minute, ttl] of Object.entries(expected)) {
      tokens = await refreshAt(flow.clientId, tokens.refresh_token, t0 + Number(minute) * 60_000);
      expect(tokens.expires_in).toBe(ttl);
      // 「毎分 refresh」にならない(以前は残り 31 分未満で同じトークンが返り、寿命 60 秒になっていた)
      expect(tokens.expires_in).toBeGreaterThan(60);
    }
    expect(backlog.refreshCalls).toBe(0);
    expect(callsTo(BACKLOG_TOKEN)).toHaveLength(1);

    // 失効の 1 秒前でもまだ Backlog のトークンで呼べる
    vi.setSystemTime(t0 + 3599_000);
    expect((await callMe(tokens.access_token)).status).toBe(200);

    // MCP の寿命(50 分 + 605 秒 = Backlog の失効 + 5 秒)で更新すると、Backlog から新しいトークンを得る
    tokens = await refreshAt(flow.clientId, tokens.refresh_token, t0 + 3605_000);
    expect(backlog.refreshCalls).toBe(1);
    expect(backlog.refreshesReturningSameToken).toBe(0);
    expect(backlog.currentAccessToken).toBe("backlog-at-2");
    expect(tokens.expires_in).toBe(1800);

    const res = await callMe(tokens.access_token);
    expect(res.status).toBe(200);
    expect((await readRpc(res)).result?.isError).toBeFalsy();
    expect(callsTo(BACKLOG_MYSELF).at(-1)?.headers.get("authorization")).toBe(
      "Bearer backlog-at-2",
    );
  });

  it("失効と次の更新の隙間で 401 が出ても、1 回の更新(stale 印)で回復する", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const { backlog, callsTo } = mockFakeBacklog();
    const flow = await runAuthorizationFlow();
    let tokens = (await flow.tokenResponse.json()) as TokenSet;
    tokens = await refreshAt(flow.clientId, tokens.refresh_token, t0 + 50 * 60_000);
    expect(tokens.expires_in).toBe(605);

    // Backlog は失効したが MCP のトークンはあと 3 秒有効: 401 が出て stale 印が置かれる
    vi.setSystemTime(t0 + 3602_000);
    const denied = await callMe(tokens.access_token);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');

    const logs: Record<string, unknown>[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      try {
        logs.push(JSON.parse(String(args[0])) as Record<string, unknown>);
      } catch {
        // JSON 以外のログは見ない
      }
    });
    const refreshed = await refreshRequest(flow.clientId, tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    tokens = (await refreshed.json()) as TokenSet;
    expect(logs.find((e) => e.event === "token_exchange")).toMatchObject({
      stale_marker: true,
      refreshed: true,
      access_token_changed: true,
      ttl_basis: "new_token",
    });
    expect(backlog.refreshCalls).toBe(1);

    const retried = await callMe(tokens.access_token);
    expect(retried.status).toBe(200);
    expect(callsTo(BACKLOG_MYSELF).at(-1)?.headers.get("authorization")).toBe(
      "Bearer backlog-at-2",
    );

    // 回復後の更新では(期限に余裕があり印も消えているので)Backlog を呼ばない
    tokens = await refreshAt(flow.clientId, tokens.refresh_token, t0 + 3700_000);
    expect(backlog.refreshCalls).toBe(1);
  });

  it("stale 印で更新して同じトークンが返っても、期限は保存し直され、次の更新は Backlog を呼ばず、失効直後に呼ぶ", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    // /users/myself を 1 回だけ 401 にして stale 印を置かせる(fake 自体は期限内で有効なまま)
    let forceDeny = false;
    const backlog = createFakeBacklogOAuth();
    const { callsTo } = mockOutboundFetch({
      [BACKLOG_TOKEN]: (call) => backlog.token(call),
      [BACKLOG_MYSELF]: (call) => (forceDeny ? jsonResponse({}, 401) : backlog.myself(call)),
    });
    const flow = await runAuthorizationFlow();
    let tokens = (await flow.tokenResponse.json()) as TokenSet;
    for (const minute of [10, 20, 30, 40]) {
      tokens = await refreshAt(flow.clientId, tokens.refresh_token, t0 + minute * 60_000);
    }
    expect(backlog.refreshCalls).toBe(0);

    // 50 分 + 0.9 秒: Backlog の残りは 599.1 秒。MCP のトークンはまだ有効
    const t1 = t0 + 3_000_900;
    vi.setSystemTime(t1);
    forceDeny = true;
    expect((await callMe(tokens.access_token)).status).toBe(401);
    forceDeny = false;

    const logs: Record<string, unknown>[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      try {
        logs.push(JSON.parse(String(args[0])) as Record<string, unknown>);
      } catch {
        // JSON 以外のログは見ない
      }
    });
    const refreshed = await refreshRequest(flow.clientId, tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    tokens = (await refreshed.json()) as TokenSet;
    // 期限内なので Backlog は同じトークンを返した。MCP の寿命 = Backlog の残り(599)+ 5
    expect(logs.find((e) => e.event === "token_exchange")).toMatchObject({
      stale_marker: true,
      refreshed: true,
      access_token_changed: false,
      ttl_basis: "backlog_remaining",
    });
    expect(backlog.refreshCalls).toBe(1);
    expect(backlog.refreshesReturningSameToken).toBe(1);
    expect(tokens.expires_in).toBe(599 + 5);
    expect((await callMe(tokens.access_token)).status).toBe(200);
    expect(callsTo(BACKLOG_MYSELF).at(-1)?.headers.get("authorization")).toBe(
      "Bearer backlog-at-1",
    );

    // 保存し直した期限は「応答時刻 + 599 秒」= 元の期限より 100ms 早い。
    // 100ms 後の更新では残りが 598.9 秒になり、寿命が 598 + 5 に縮む(保存し直さないと 599 + 5 のまま)。
    // 印は消えていて期限内なので、Backlog は呼ばない。
    tokens = await refreshAt(flow.clientId, tokens.refresh_token, t1 + 100);
    expect(tokens.expires_in).toBe(598 + 5);
    expect(backlog.refreshCalls).toBe(1);

    // 失効直後(元の期限 + 1 秒)の更新では Backlog を呼び、新しいトークンを得る
    tokens = await refreshAt(flow.clientId, tokens.refresh_token, t0 + 3601_000);
    expect(backlog.refreshCalls).toBe(2);
    expect(backlog.refreshesReturningSameToken).toBe(1);
    expect(backlog.currentAccessToken).toBe("backlog-at-2");
    expect((await callMe(tokens.access_token)).status).toBe(200);
    expect(callsTo(BACKLOG_MYSELF).at(-1)?.headers.get("authorization")).toBe(
      "Bearer backlog-at-2",
    );
  });
});
