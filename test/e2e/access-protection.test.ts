import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearJwksCache } from "../../src/auth/access-jwt";
import { createTestKey, signAccessJwt } from "../helpers/access";
import {
  accessHeaders,
  CLIENT_REDIRECT,
  MCP_URL,
  ORIGIN,
  pkcePair,
  registerClient,
  setupMocks,
  worker,
} from "../helpers/oauth-flow";

beforeEach(() => clearJwksCache());
afterEach(() => {
  vi.restoreAllMocks();
  clearJwksCache();
});

async function authorizeUrl(): Promise<string> {
  const clientId = await registerClient();
  const { challenge } = await pkcePair();
  const url = new URL(`${ORIGIN}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    state: "s",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_URL,
  }).toString();
  return url.toString();
}

describe("E2E 5: /authorize と /callback は正しい Cf-Access-Jwt-Assertion がないと 403", () => {
  it("JWT なしの GET /authorize・POST /authorize・GET /callback はすべて 403", async () => {
    await setupMocks();
    const url = await authorizeUrl();
    expect((await worker.fetch(url)).status).toBe(403);
    expect(
      (
        await worker.fetch(`${ORIGIN}/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ handle: "x", decision: "approve" }),
        })
      ).status,
    ).toBe(403);
    expect((await worker.fetch(`${ORIGIN}/callback?code=c&state=s`)).status).toBe(403);
  });

  it("期限切れ・aud 違い・署名不正・別チームの JWT は 403", async () => {
    const { accessKey } = await setupMocks();
    const url = await authorizeUrl();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const rogue = await createTestKey(accessKey.kid); // 同じ kid の別の鍵
    const bad = [
      await signAccessJwt(accessKey, { iat: past, exp: past + 300 }),
      await signAccessJwt(accessKey, { aud: "another-app" }),
      await signAccessJwt(rogue),
      await signAccessJwt(accessKey, { teamDomain: "evil.cloudflareaccess.com" }),
      "not-a-jwt",
    ];
    for (const jwt of bad) {
      const a = await worker.fetch(url, { headers: { "Cf-Access-Jwt-Assertion": jwt } });
      expect(a.status, "authorize").toBe(403);
      const c = await worker.fetch(`${ORIGIN}/callback?code=c&state=s`, {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      });
      expect(c.status, "callback").toBe(403);
    }
  });

  it("正しい JWT なら /authorize は同意画面(200)を返す", async () => {
    const { accessKey } = await setupMocks();
    const res = await worker.fetch(await authorizeUrl(), {
      headers: await accessHeaders(accessKey),
    });
    expect(res.status).toBe(200);
  });

  it("/mcp・/token・/register・/.well-known/* と /healthz は Access の JWT なしで到達できる(Worker 発行トークンで守る)", async () => {
    await setupMocks();
    expect((await worker.fetch(`${ORIGIN}/healthz`)).status).toBe(200);
    expect((await worker.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).status).toBe(
      200,
    );
    expect((await worker.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).status).toBe(
      200,
    );
    expect((await registerClient()).length).toBeGreaterThan(0);
    // /token は JWT 不要(未登録クライアントなので invalid_client の 401 になるが、Access の 403 ではない)
    const token = await worker.fetch(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "x", client_id: "y" }),
    });
    expect(token.status).toBe(401);
    // /mcp はトークンなしで 401(403 ではない)
    expect((await worker.fetch(MCP_URL, { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("E2E 6: 認可フローの入力検証(M01 持ち越し)", () => {
  it("client_name に <script> を入れて登録しても、同意画面ではエスケープされる", async () => {
    const { accessKey } = await setupMocks();
    const payload = "<script>alert(1)</script>";
    const clientId = await registerClient(payload);
    const { challenge } = await pkcePair();
    const url = new URL(`${ORIGIN}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      state: "s",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP_URL,
    }).toString();
    const res = await worker.fetch(url.toString(), { headers: await accessHeaders(accessKey) });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain(payload);
    expect(html).toContain("&#60;script&#62;alert(1)&#60;/script&#62;");
  });

  it("偽造した state の /callback は拒否し、Backlog のトークン交換をしない", async () => {
    const { accessKey, callsTo } = await setupMocks();
    const res = await worker.fetch(`${ORIGIN}/callback?code=backlog-code&state=forged-state`, {
      headers: await accessHeaders(accessKey),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get("Location")).toBeNull();
    expect(callsTo("POST https://example.backlog.com/api/v2/oauth2/token")).toHaveLength(0);
  });

  it("未登録の redirect_uri の /authorize は同意画面を出さず拒否する(クライアントへもリダイレクトしない)", async () => {
    const { accessKey } = await setupMocks();
    const clientId = await registerClient();
    const { challenge } = await pkcePair();
    const url = new URL(`${ORIGIN}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://evil.example/cb",
      state: "s",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP_URL,
    }).toString();
    const res = await worker.fetch(url.toString(), { headers: await accessHeaders(accessKey) });
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).not.toContain('name="handle"');
  });
});
