import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_REDIRECT,
  CookieJar,
  MCP_URL,
  ORIGIN,
  pkcePair,
  registerClient,
  setupMocks,
  worker,
} from "../helpers/oauth-flow";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("E2E 5: 公開エンドポイントの到達性(M06 で Access の記述を外した形)", () => {
  it("/mcp・/token・/register・/.well-known/* と /healthz は、Worker 発行トークンなしでも期待どおり応答する", async () => {
    await setupMocks();
    expect((await worker.fetch(`${ORIGIN}/healthz`)).status).toBe(200);
    expect((await worker.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).status).toBe(
      200,
    );
    expect((await worker.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).status).toBe(
      200,
    );
    expect((await registerClient()).length).toBeGreaterThan(0);
    // /token は未登録クライアントなので invalid_client の 401
    const token = await worker.fetch(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "x", client_id: "y" }),
    });
    expect(token.status).toBe(401);
    // /mcp はトークンなしで 401
    expect((await worker.fetch(MCP_URL, { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("E2E 6: 認可フローの入力検証(M01 持ち越し。M06 で Access なしの形に)", () => {
  it("client_name に <script> を入れて登録しても、同意画面ではエスケープされる", async () => {
    await setupMocks();
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
    const res = await worker.fetch(url.toString());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain(payload);
    expect(html).toContain("&#60;script&#62;alert(1)&#60;/script&#62;");
  });

  it("偽造した state の /callback は拒否し、Backlog のトークン交換をしない", async () => {
    const { callsTo } = await setupMocks();
    const res = await worker.fetch(`${ORIGIN}/callback?code=backlog-code&state=forged-state`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get("Location")).toBeNull();
    expect(callsTo("POST https://example.backlog.com/api/v2/oauth2/token")).toHaveLength(0);
  });

  it("同意後に発行された正規の state でも、Cookie なし(別ブラウザ)の /callback は拒否し、Backlog のトークン交換をしない", async () => {
    const { callsTo } = await setupMocks();
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
    const jar = new CookieJar();
    const consent = await worker.fetch(url.toString());
    jar.update(consent);
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())?.[1] ?? "";
    expect(handle).not.toBe("");
    const approve = await worker.fetch(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: { Cookie: jar.header(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, decision: "approve" }),
    });
    const state =
      new URL(approve.headers.get("Location") ?? "", ORIGIN).searchParams.get("state") ?? "";
    expect(state).not.toBe("");

    // 正規の state だが Cookie を持たない別ブラウザからの /callback
    const res = await worker.fetch(
      `${ORIGIN}/callback?code=backlog-code&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get("Location")).toBeNull();
    expect(callsTo("POST https://example.backlog.com/api/v2/oauth2/token")).toHaveLength(0);
  });

  it("未登録の redirect_uri の /authorize は同意画面を出さず拒否する(クライアントへもリダイレクトしない)", async () => {
    await setupMocks();
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
    const res = await worker.fetch(url.toString());
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).not.toContain('name="handle"');
  });
});
