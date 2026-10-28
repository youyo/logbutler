import { env } from "cloudflare:workers";
import { GrantType, OAuthError } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backlogStaleKey, isBacklogStale, markBacklogStale } from "../../src/auth/backlog-stale";
import type { GrantProps } from "../../src/auth/props";
import {
  BACKLOG_EXPIRY_GRACE_SECONDS,
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
  };
}

function call(grantType: GrantType, props: GrantProps, grantId = "g") {
  return callback({
    grantType,
    props,
    env,
    clientId: "c",
    subjectClientId: "c",
    userId: "42",
    grantId,
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

  it("refresh_token: Backlog の期限が切れていれば Backlog も更新し props を差し替える", async () => {
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

  describe("Backlog は有効期限内のリフレッシュで同じトークンを残り寿命つきで返す(2026-10-29 の観測。ADR 0014)", () => {
    /** 観測どおり: 同じアクセストークンを、残り秒数を expires_in として返す(ローテーションなし)。 */
    const sameTokenWithRemaining = (seconds: number) => () =>
      jsonResponse({ access_token: "old-at", expires_in: seconds });

    it("残りが MCP の寿命より短くても、期限内なら Backlog を呼ばず、MCP の寿命を Backlog の残り + 余裕にする", async () => {
      const m = mockOutboundFetch({ [TOKEN_ENDPOINT]: sameTokenWithRemaining(600) });
      const result = await call(GrantType.REFRESH_TOKEN, propsExpiringIn(600));
      expect(m.calls).toHaveLength(0);
      expect(result?.newProps).toBeUndefined();
      expect(result?.accessTokenTTL).toBe(600 + BACKLOG_EXPIRY_GRACE_SECONDS);
    });

    it("残りが 1 分を切っていても期限内なら Backlog を呼ばない(MCP の寿命は KV の最小 60 秒)", async () => {
      const m = mockOutboundFetch({ [TOKEN_ENDPOINT]: sameTokenWithRemaining(30) });
      const result = await call(GrantType.REFRESH_TOKEN, propsExpiringIn(30));
      expect(m.calls).toHaveLength(0);
      expect(result?.accessTokenTTL).toBe(60);
    });

    it("期限ちょうど(残り 0)は期限切れとして Backlog を更新する", async () => {
      const m = mockOutboundFetch({
        [TOKEN_ENDPOINT]: () => jsonResponse({ access_token: "new-at", expires_in: 3600 }),
      });
      await call(GrantType.REFRESH_TOKEN, propsExpiringIn(0));
      expect(m.calls).toHaveLength(1);
    });

    it("stale 印で更新して同じトークンが返ったら、MCP の寿命は Backlog の残り + 余裕(印は消す)", async () => {
      await markBacklogStale(env.OAUTH_KV, "42", "g-same-1");
      const m = mockOutboundFetch({ [TOKEN_ENDPOINT]: sameTokenWithRemaining(1755) });
      const result = await call(GrantType.REFRESH_TOKEN, propsExpiringIn(1760), "g-same-1");
      expect(m.calls).toHaveLength(1);
      // 期限は Backlog が返した残り寿命で保存し直す(延びていない)
      expect(result?.newProps).toMatchObject({
        backlogAccessToken: "old-at",
        backlogExpiresAt: NOW + 1755 * 1000,
      });
      expect(result?.accessTokenTTL).toBe(1755 + BACKLOG_EXPIRY_GRACE_SECONDS);
      expect(await isBacklogStale(env.OAUTH_KV, "42", "g-same-1")).toBe(false);
    });

    it("同じトークンが残り長めで返っても、MCP の寿命の上限は MCP_ACCESS_TOKEN_TTL_SECONDS", async () => {
      await markBacklogStale(env.OAUTH_KV, "42", "g-same-2");
      mockOutboundFetch({ [TOKEN_ENDPOINT]: sameTokenWithRemaining(3000) });
      const result = await call(GrantType.REFRESH_TOKEN, propsExpiringIn(3000), "g-same-2");
      expect(result?.accessTokenTTL).toBe(MCP_ACCESS_TOKEN_TTL_SECONDS);
    });

    it("期限切れ後の更新でも同じトークン(残り 0 以下)が返ったら、MCP の寿命は最小の 60 秒(1 分後に再試行)", async () => {
      mockOutboundFetch({ [TOKEN_ENDPOINT]: sameTokenWithRemaining(0) });
      const result = await call(GrantType.REFRESH_TOKEN, propsExpiringIn(-5));
      expect(result?.accessTokenTTL).toBe(60);
    });

    it("余裕は小さい(数秒)", () => {
      expect(BACKLOG_EXPIRY_GRACE_SECONDS).toBeGreaterThan(0);
      expect(BACKLOG_EXPIRY_GRACE_SECONDS).toBeLessThanOrEqual(10);
    });
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

  describe("Backlog の更新が必要という印(backlog-stale)", () => {
    it("印があれば、期限に余裕があっても Backlog を更新し、成功したら印を消す", async () => {
      await markBacklogStale(env.OAUTH_KV, "42", "g-stale-1");
      expect(await isBacklogStale(env.OAUTH_KV, "42", "g-stale-1")).toBe(true);
      const m = mockOutboundFetch({
        [TOKEN_ENDPOINT]: () =>
          jsonResponse({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
      });
      const result = await call(GrantType.REFRESH_TOKEN, propsExpiringIn(3500), "g-stale-1");
      expect(m.calls).toHaveLength(1);
      expect(result?.newProps).toMatchObject({ backlogAccessToken: "new-at" });
      expect(await isBacklogStale(env.OAUTH_KV, "42", "g-stale-1")).toBe(false);
    });

    it("印は grant ごと: 別の grant の印では更新しない", async () => {
      await markBacklogStale(env.OAUTH_KV, "42", "g-stale-other");
      const m = mockOutboundFetch({});
      const result = await call(GrantType.REFRESH_TOKEN, propsExpiringIn(3500), "g-stale-mine");
      expect(m.calls).toHaveLength(0);
      expect(result?.newProps).toBeUndefined();
      expect(await isBacklogStale(env.OAUTH_KV, "42", "g-stale-other")).toBe(true);
    });

    it("印があって Backlog の更新が一時障害で失敗したら、印は残す(次の更新で再試行する)", async () => {
      await markBacklogStale(env.OAUTH_KV, "42", "g-stale-2");
      mockOutboundFetch({ [TOKEN_ENDPOINT]: () => jsonResponse({}, 503) });
      const err = await call(GrantType.REFRESH_TOKEN, propsExpiringIn(3500), "g-stale-2").catch(
        (e: unknown) => e,
      );
      expect((err as OAuthError).code).toBe("temporarily_unavailable");
      expect(await isBacklogStale(env.OAUTH_KV, "42", "g-stale-2")).toBe(true);
    });

    it("authorization_code では印を読まない(印があっても更新せず、KV も見ず、印は残る)", async () => {
      await markBacklogStale(env.OAUTH_KV, "42", "g-stale-code");
      const kvGet = vi.spyOn(env.OAUTH_KV, "get");
      const m = mockOutboundFetch({});
      const result = await call(
        GrantType.AUTHORIZATION_CODE,
        propsExpiringIn(3500),
        "g-stale-code",
      );
      expect(m.calls).toHaveLength(0);
      expect(result?.newProps).toBeUndefined();
      expect(kvGet).not.toHaveBeenCalled();
      expect(await isBacklogStale(env.OAUTH_KV, "42", "g-stale-code")).toBe(true);
    });

    it('印の値は "1" だけ', async () => {
      await markBacklogStale(env.OAUTH_KV, "42", "g-stale-val");
      expect(await env.OAUTH_KV.get(backlogStaleKey("42", "g-stale-val"))).toBe("1");
    });

    it("印の値にトークンは入らない(TTL つきの目印だけ)", async () => {
      await markBacklogStale(env.OAUTH_KV, "42", "g-stale-3");
      const raw = await env.OAUTH_KV.getWithMetadata(backlogStaleKey("42", "g-stale-3"));
      expect(raw.value).not.toContain("old-at");
      expect(raw.value).not.toContain("old-rt");
      expect(backlogStaleKey("42", "g-stale-3")).toBe("backlog-stale:42:g-stale-3");
    });
  });

  describe("診断ログ(値を出さない)", () => {
    function captureLogs() {
      const lines: string[] = [];
      for (const level of ["log", "info", "warn", "error"] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        });
      }
      return lines;
    }
    const events = (lines: string[]) =>
      lines.flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      });

    it("更新の判定(grant_type・残り秒数・needs_refresh・stale・refreshed)を出し、トークンは出さない", async () => {
      const lines = captureLogs();
      mockOutboundFetch({
        [TOKEN_ENDPOINT]: () =>
          jsonResponse({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
      });
      await call(GrantType.REFRESH_TOKEN, propsExpiringIn(-10), "g-log-1");
      const decision = events(lines).find((e) => e.event === "token_exchange");
      expect(decision).toEqual({
        event: "token_exchange",
        grant_type: "refresh_token",
        backlog_remaining_seconds: -10,
        needs_refresh: true,
        stale_marker: false,
        refreshed: true,
        access_token_changed: true,
        ttl_basis: "new_token",
        access_token_ttl: MCP_ACCESS_TOKEN_TTL_SECONDS,
      });
      const backlog = events(lines).find((e) => e.event === "backlog_token");
      expect(backlog).toEqual({
        event: "backlog_token",
        grant_type: "refresh_token",
        expires_in: 3600,
        refresh_token_rotated: true,
      });
      const all = lines.join("\n");
      for (const secret of ["old-at", "old-rt", "new-at", "new-rt", "test-backlog-client-secret"]) {
        expect(all).not.toContain(secret);
      }
    });

    it("Backlog が同じアクセストークンを返したら access_token_changed: false、ローテーションなしなら rotated: false", async () => {
      const lines = captureLogs();
      mockOutboundFetch({
        [TOKEN_ENDPOINT]: () => jsonResponse({ access_token: "old-at", expires_in: 3600 }),
      });
      await call(GrantType.REFRESH_TOKEN, propsExpiringIn(0), "g-log-2");
      const decision = events(lines).find((e) => e.event === "token_exchange");
      expect(decision?.access_token_changed).toBe(false);
      expect(events(lines).find((e) => e.event === "backlog_token")?.refresh_token_rotated).toBe(
        false,
      );
      expect(lines.join("\n")).not.toContain("old-at");
    });

    it("更新しないときも判定を出す(stale 印の有無つき)", async () => {
      const lines = captureLogs();
      mockOutboundFetch({});
      await call(GrantType.REFRESH_TOKEN, propsExpiringIn(3500), "g-log-3");
      expect(events(lines).find((e) => e.event === "token_exchange")).toEqual({
        event: "token_exchange",
        grant_type: "refresh_token",
        backlog_remaining_seconds: 3500,
        needs_refresh: false,
        stale_marker: false,
        refreshed: false,
        ttl_basis: "backlog_remaining",
        access_token_ttl: MCP_ACCESS_TOKEN_TTL_SECONDS,
      });
    });

    it("同じトークンが返ったときは ttl_basis: backlog_remaining", async () => {
      const lines = captureLogs();
      mockOutboundFetch({
        [TOKEN_ENDPOINT]: () => jsonResponse({ access_token: "old-at", expires_in: 100 }),
      });
      await call(GrantType.REFRESH_TOKEN, propsExpiringIn(0), "g-log-4");
      const decision = events(lines).find((e) => e.event === "token_exchange");
      expect(decision).toMatchObject({
        refreshed: true,
        access_token_changed: false,
        ttl_basis: "backlog_remaining",
        access_token_ttl: 100 + BACKLOG_EXPIRY_GRACE_SECONDS,
      });
    });
  });
});
