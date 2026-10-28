import { env } from "cloudflare:workers";
import { GrantType, OAuthError } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GrantProps } from "../../src/auth/props";
import {
  createTokenExchangeCallback,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
} from "../../src/auth/token-exchange";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";

const TOKEN_ENDPOINT = "POST https://example.backlog.com/api/v2/oauth2/token";
const NOW = 1_800_000_000_000;
const callback = createTokenExchangeCallback({ now: () => NOW });

function propsExpiringIn(seconds: number): GrantProps {
  return {
    backlogAccessToken: "old-at",
    backlogRefreshToken: "old-rt",
    backlogExpiresAt: NOW + seconds * 1000,
    backlogUserId: 42,
    accessEmail: "alice@example.com",
  };
}

function call(grantType: GrantType, props: GrantProps) {
  return callback({
    grantType,
    props,
    env,
    clientId: "c",
    subjectClientId: "c",
    userId: "42",
    grantId: "g",
    scope: [],
    requestedScope: [],
    resource: "https://logbutler.test/mcp",
  });
}

afterEach(() => vi.restoreAllMocks());

describe("tokenExchangeCallback", () => {
  it("MCP のアクセストークンは Backlog のアクセストークン(約 1 時間)より短い", () => {
    expect(MCP_ACCESS_TOKEN_TTL_SECONDS).toBeLessThan(3600);
  });

  it("refresh_token: Backlog の期限が MCP の次のトークンより先に切れるなら Backlog も更新し props を差し替える", async () => {
    const m = mockOutboundFetch({
      [TOKEN_ENDPOINT]: () =>
        jsonResponse({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
    });
    const result = await call(GrantType.REFRESH_TOKEN, propsExpiringIn(-10)); // 期限切れ
    expect(m.calls).toHaveLength(1);
    expect(new URLSearchParams(m.calls[0]?.body).get("refresh_token")).toBe("old-rt");
    expect(result?.newProps).toMatchObject({
      backlogAccessToken: "new-at",
      backlogRefreshToken: "new-rt",
      backlogExpiresAt: NOW + 3600 * 1000,
      backlogUserId: 42,
      accessEmail: "alice@example.com",
    });
    expect(result?.accessTokenProps).toEqual(result?.newProps);
    expect(result?.accessTokenTTL).toBe(MCP_ACCESS_TOKEN_TTL_SECONDS);
  });

  it("refresh_token: Backlog がリフレッシュトークンをローテーションしない場合は元のものを維持する", async () => {
    mockOutboundFetch({
      [TOKEN_ENDPOINT]: () => jsonResponse({ access_token: "new-at", expires_in: 3600 }),
    });
    const result = await call(GrantType.REFRESH_TOKEN, propsExpiringIn(0));
    const next = result?.newProps as GrantProps | undefined;
    expect(next?.backlogRefreshToken).toBe("old-rt");
    expect(next?.backlogAccessToken).toBe("new-at");
  });

  it("refresh_token: Backlog の期限に十分な余裕があれば Backlog を呼ばない", async () => {
    const m = mockOutboundFetch({});
    const result = await call(GrantType.REFRESH_TOKEN, propsExpiringIn(3500));
    expect(m.calls).toHaveLength(0);
    expect(result?.newProps).toBeUndefined();
  });

  it("MCP のトークンの寿命は Backlog のトークンの残り寿命を超えない", async () => {
    const m = mockOutboundFetch({
      [TOKEN_ENDPOINT]: () => jsonResponse({ access_token: "new-at", expires_in: 600 }),
    });
    const result = await call(GrantType.REFRESH_TOKEN, propsExpiringIn(0));
    expect(m.calls).toHaveLength(1);
    // 600 秒 - 余裕 60 秒
    expect(result?.accessTokenTTL).toBe(540);
  });

  it("authorization_code: 取りたての Backlog トークンはそのまま使い、MCP の寿命だけ設定する", async () => {
    const m = mockOutboundFetch({});
    const result = await call(GrantType.AUTHORIZATION_CODE, propsExpiringIn(3600));
    expect(m.calls).toHaveLength(0);
    expect(result?.accessTokenTTL).toBe(MCP_ACCESS_TOKEN_TTL_SECONDS);
  });

  it("Backlog 側で失効(invalid_grant)していたら OAuthError('invalid_grant') を投げる", async () => {
    mockOutboundFetch({ [TOKEN_ENDPOINT]: () => jsonResponse({ error: "invalid_grant" }, 400) });
    const err = await call(GrantType.REFRESH_TOKEN, propsExpiringIn(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("invalid_grant");
    expect(JSON.stringify((err as OAuthError).description)).not.toContain("old-rt");
  });

  it("Backlog の一時障害は temporarily_unavailable(grant は残す)", async () => {
    mockOutboundFetch({ [TOKEN_ENDPOINT]: () => jsonResponse({}, 503) });
    const err = await call(GrantType.REFRESH_TOKEN, propsExpiringIn(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("temporarily_unavailable");
    expect((err as OAuthError).statusCode).toBe(503);
  });
});
