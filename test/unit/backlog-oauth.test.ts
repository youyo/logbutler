import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BacklogOAuthError,
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
} from "../../src/auth/backlog-oauth";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";

const cfg = {
  spaceHost: "example.backlog.com",
  clientId: "cid",
  clientSecret: "csecret",
};
const TOKEN_ENDPOINT = "POST https://example.backlog.com/api/v2/oauth2/token";
const NOW = 1_800_000_000_000;

afterEach(() => vi.restoreAllMocks());

describe("buildAuthorizeUrl", () => {
  it("スペースの認可エンドポイントに response_type・client_id・redirect_uri・state を付ける", () => {
    const url = new URL(
      buildAuthorizeUrl(cfg, { redirectUri: "https://lb.test/callback", state: "st-1" }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://example.backlog.com/OAuth2AccessRequest.action",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://lb.test/callback");
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.has("client_secret")).toBe(false);
  });
});

describe("exchangeCode", () => {
  it("authorization_code をフォームで送り、期限を expires_in から計算する", async () => {
    const m = mockOutboundFetch({
      [TOKEN_ENDPOINT]: () =>
        jsonResponse({
          access_token: "at-1",
          refresh_token: "rt-1",
          token_type: "Bearer",
          expires_in: 3600,
        }),
    });
    const tokens = await exchangeCode(
      cfg,
      { code: "the-code", redirectUri: "https://lb.test/callback" },
      NOW,
    );
    expect(tokens).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: NOW + 3600 * 1000,
    });
    const [call] = m.calls;
    expect(call?.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call?.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("redirect_uri")).toBe("https://lb.test/callback");
    expect(form.get("client_id")).toBe("cid");
    expect(form.get("client_secret")).toBe("csecret");
  });

  it("コード交換が 4xx なら invalid_grant の BacklogOAuthError にする(トークンや secret を含めない)", async () => {
    mockOutboundFetch({ [TOKEN_ENDPOINT]: () => jsonResponse({ error: "invalid_grant" }, 400) });
    const err = await exchangeCode(
      cfg,
      { code: "bad", redirectUri: "https://lb.test/callback" },
      NOW,
    )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BacklogOAuthError);
    expect((err as BacklogOAuthError).kind).toBe("invalid_grant");
    expect((err as BacklogOAuthError).message).not.toContain("csecret");
  });
});

describe("refreshTokens", () => {
  it("refresh_token をフォームで送り、応答に refresh_token があれば差し替える(ローテーションあり)", async () => {
    const m = mockOutboundFetch({
      [TOKEN_ENDPOINT]: () =>
        jsonResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }),
    });
    const tokens = await refreshTokens(cfg, "rt-1", NOW);
    expect(tokens).toEqual({
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: NOW + 3600 * 1000,
    });
    const form = new URLSearchParams(m.calls[0]?.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt-1");
    expect(form.get("client_id")).toBe("cid");
    expect(form.get("client_secret")).toBe("csecret");
  });

  it("応答に refresh_token がなければ元の refresh_token を維持する(ローテーションなし)", async () => {
    mockOutboundFetch({
      [TOKEN_ENDPOINT]: () => jsonResponse({ access_token: "at-2", expires_in: 3600 }),
    });
    const tokens = await refreshTokens(cfg, "rt-1", NOW);
    expect(tokens.refreshToken).toBe("rt-1");
    expect(tokens.accessToken).toBe("at-2");
  });

  it("400/401 は invalid_grant、5xx・429・通信失敗は temporarily_unavailable", async () => {
    for (const [status, kind] of [
      [400, "invalid_grant"],
      [401, "invalid_grant"],
      [429, "temporarily_unavailable"],
      [503, "temporarily_unavailable"],
    ] as const) {
      vi.restoreAllMocks();
      mockOutboundFetch({ [TOKEN_ENDPOINT]: () => jsonResponse({ error: "x" }, status) });
      const err = await refreshTokens(cfg, "rt-1", NOW).catch((e: unknown) => e);
      expect((err as BacklogOAuthError).kind, `status ${status}`).toBe(kind);
    }
    vi.restoreAllMocks();
    mockOutboundFetch({
      [TOKEN_ENDPOINT]: () => {
        throw new TypeError("network down");
      },
    });
    const err = await refreshTokens(cfg, "rt-1", NOW).catch((e: unknown) => e);
    expect((err as BacklogOAuthError).kind).toBe("temporarily_unavailable");
  });

  it("成功応答に access_token がなければ temporarily_unavailable ではなく invalid_response", async () => {
    mockOutboundFetch({ [TOKEN_ENDPOINT]: () => jsonResponse({ nope: true }) });
    const err = await refreshTokens(cfg, "rt-1", NOW).catch((e: unknown) => e);
    expect((err as BacklogOAuthError).kind).toBe("invalid_response");
  });
});

describe("診断ログ(backlog_token)", () => {
  function captureLogs() {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    return lines;
  }

  it("コード交換: expires_in の秒数だけを出す(トークン・client_secret は出さない)", async () => {
    const lines = captureLogs();
    mockOutboundFetch({
      [TOKEN_ENDPOINT]: () =>
        jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3599 }),
    });
    await exchangeCode(cfg, { code: "code-1", redirectUri: "https://lb.test/callback" }, NOW);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: "backlog_token", grant_type: "authorization_code", expires_in: 3599 },
    ]);
    for (const secret of ["at-1", "rt-1", "csecret", "code-1"]) {
      expect(lines.join("\n")).not.toContain(secret);
    }
  });

  it("更新: リフレッシュトークンが変わったか(ローテーション)を true / false で出す", async () => {
    const lines = captureLogs();
    mockOutboundFetch({
      [TOKEN_ENDPOINT]: () =>
        jsonResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }),
    });
    await refreshTokens(cfg, "rt-1", NOW);
    mockOutboundFetch({
      [TOKEN_ENDPOINT]: () =>
        jsonResponse({ access_token: "at-3", refresh_token: "rt-1", expires_in: 3600 }),
    });
    await refreshTokens(cfg, "rt-1", NOW);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      {
        event: "backlog_token",
        grant_type: "refresh_token",
        expires_in: 3600,
        refresh_token_rotated: true,
      },
      {
        event: "backlog_token",
        grant_type: "refresh_token",
        expires_in: 3600,
        refresh_token_rotated: false,
      },
    ]);
    for (const secret of ["at-2", "at-3", "rt-1", "rt-2", "csecret"]) {
      expect(lines.join("\n")).not.toContain(secret);
    }
  });
});
