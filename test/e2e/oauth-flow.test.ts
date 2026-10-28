import { afterEach, describe, expect, it, vi } from "vitest";
import { clearJwksCache } from "../../src/auth/access-jwt";
import {
  accessHeaders,
  BACKLOG_HOST,
  BACKLOG_MYSELF,
  BACKLOG_TOKEN,
  CLIENT_REDIRECT,
  CookieJar,
  firstText,
  MCP_URL,
  mcpRequest,
  ORIGIN,
  pkcePair,
  readRpc,
  registerClient,
  runAuthorizationFlow,
  setupMocks,
  type TokenSet,
  worker,
} from "../helpers/oauth-flow";

afterEach(() => {
  vi.restoreAllMocks();
  clearJwksCache();
});

describe("E2E 1: 未認証の /mcp は 401 とディスカバリを返す", () => {
  it("トークンなしの /mcp は 401 + WWW-Authenticate: Bearer resource_metadata=... を返し、その URL が authorization_servers を含む JSON を返す", async () => {
    await setupMocks();
    const res = await mcpRequest(null, "tools/list");
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(metadataUrl).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);

    // メタデータは Access を通さず(Bypass)に取れる
    const meta = await worker.fetch(metadataUrl ?? "");
    expect(meta.status).toBe(200);
    const body = (await meta.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(MCP_URL);
    expect(body.authorization_servers).toContain(ORIGIN);

    // 認可サーバーのメタデータにもエンドポイントが出ている
    const as = await worker.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(200);
    const asBody = (await as.json()) as Record<string, string>;
    expect(asBody.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(asBody.token_endpoint).toBe(`${ORIGIN}/token`);
    expect(asBody.registration_endpoint).toBe(`${ORIGIN}/register`);
  });
});

describe("E2E 2: DCR → /authorize → Backlog → /callback → /token", () => {
  it("アクセストークンを取得でき、同意画面は送信先を表示し、Backlog の認可 URL へ送る", async () => {
    const { accessKey, callsTo } = await setupMocks();
    const flow = await runAuthorizationFlow(await accessHeaders(accessKey));

    // 同意画面: クライアント名・送信先ホスト・Backlog のホストを表示する
    expect(flow.consent.status).toBe(200);
    expect(flow.consent.headers.get("Content-Type")).toContain("text/html");
    expect(flow.consent.headers.get("X-Frame-Options")).toBe("DENY");
    expect(flow.html).toContain("Test MCP Client");
    expect(flow.html).toContain("client.example");
    expect(flow.html).toContain("example.backlog.com");

    // 承認後は Backlog の認可画面へ
    expect(flow.backlogRedirect.status).toBe(302);
    const backlogUrl = new URL(flow.backlogRedirect.headers.get("Location") ?? "");
    expect(backlogUrl.origin + backlogUrl.pathname).toBe(
      `${BACKLOG_HOST}/OAuth2AccessRequest.action`,
    );
    expect(backlogUrl.searchParams.get("client_id")).toBe("test-backlog-client-id");
    expect(backlogUrl.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(backlogUrl.searchParams.get("response_type")).toBe("code");
    expect(backlogUrl.searchParams.get("client_secret")).toBeNull();

    // /callback は Backlog のコードをトークンに交換し、クライアントのリダイレクト先へ MCP の認可コードを返す
    expect(flow.callbackResponse.status).toBe(302);
    const back = new URL(flow.callbackResponse.headers.get("Location") ?? "");
    expect(back.origin + back.pathname).toBe(CLIENT_REDIRECT);
    expect(back.searchParams.get("state")).toBe("client-state-1");
    expect(back.searchParams.get("code")).toBeTruthy();
    expect(callsTo(BACKLOG_TOKEN)).toHaveLength(1);
    const form = new URLSearchParams(callsTo(BACKLOG_TOKEN)[0]?.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("backlog-code");
    expect(form.get("redirect_uri")).toBe(`${ORIGIN}/callback`);

    // /token
    expect(flow.tokenResponse.status).toBe(200);
    const tokens = (await flow.tokenResponse.json()) as TokenSet;
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    // MCP のアクセストークンは Backlog のもの(約 1 時間)より短い
    expect(tokens.expires_in).toBeLessThan(3600);
    // Backlog のトークンは MCP クライアントに渡らない
    expect(JSON.stringify(tokens)).not.toContain("backlog-at-1");
    expect(JSON.stringify(tokens)).not.toContain("backlog-rt-1");
  });

  it("同意画面で Deny すると access_denied でクライアントへ戻し、Backlog へは行かない", async () => {
    const { accessKey, callsTo } = await setupMocks();
    const access = await accessHeaders(accessKey);
    const flow = await runAuthorizationFlow(access);
    expect(flow.tokenResponse.status).toBe(200); // 前提の健全性

    // 別の認可リクエストで Deny
    const clientId = await registerClient();
    const { challenge } = await pkcePair();
    const url = new URL(`${ORIGIN}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      state: "s2",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP_URL,
    }).toString();
    const jar = new CookieJar();
    const consent = await worker.fetch(url.toString(), { headers: access });
    jar.update(consent);
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())?.[1] ?? "";
    const before = callsTo(BACKLOG_TOKEN).length;
    const denied = await worker.fetch(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: {
        ...access,
        Cookie: jar.header(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ handle, decision: "deny" }),
    });
    expect(denied.status).toBe(302);
    const loc = new URL(denied.headers.get("Location") ?? "");
    expect(loc.origin + loc.pathname).toBe(CLIENT_REDIRECT);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("s2");
    expect(callsTo(BACKLOG_TOKEN).length).toBe(before);
  });

  it("Backlog が認可を拒否して error 付きで戻したら、クライアントへ access_denied を返す", async () => {
    const { accessKey } = await setupMocks();
    const access = await accessHeaders(accessKey);
    const clientId = await registerClient();
    const { challenge } = await pkcePair();
    const url = new URL(`${ORIGIN}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      state: "s3",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP_URL,
    }).toString();
    const jar = new CookieJar();
    const consent = await worker.fetch(url.toString(), { headers: access });
    jar.update(consent);
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())?.[1] ?? "";
    const up = await worker.fetch(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: {
        ...access,
        Cookie: jar.header(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ handle, decision: "approve" }),
    });
    jar.update(up);
    const state = new URL(up.headers.get("Location") ?? "").searchParams.get("state") ?? "";
    const cb = await worker.fetch(
      `${ORIGIN}/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      { headers: { ...access, Cookie: jar.header() } },
    );
    expect(cb.status).toBe(302);
    const loc = new URL(cb.headers.get("Location") ?? "");
    expect(loc.origin + loc.pathname).toBe(CLIENT_REDIRECT);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("s3");
  });
});

describe("E2E 3: 取得したトークンで /mcp が使える", () => {
  it("tools/list と tools/call logbutler_user_me が成功する", async () => {
    const { accessKey, callsTo } = await setupMocks();
    const flow = await runAuthorizationFlow(await accessHeaders(accessKey));
    const { access_token } = (await flow.tokenResponse.json()) as TokenSet;

    const list = await mcpRequest(access_token, "tools/list");
    expect(list.status).toBe(200);
    const listBody = await readRpc(list);
    expect((listBody.result?.tools ?? []).map((t: { name: string }) => t.name)).toEqual([
      "logbutler_user_me",
    ]);

    const call = await mcpRequest(access_token, "tools/call", {
      name: "logbutler_user_me",
      arguments: {},
    });
    expect(call.status).toBe(200);
    const callBody = await readRpc(call);
    expect(callBody.result?.isError).toBeFalsy();
    expect(JSON.parse(firstText(callBody))).toEqual({
      id: 42,
      user_id: "alice",
      name: "Alice",
      mail_address: "alice@example.com",
    });
    // Backlog には grant の props にあるトークンで呼んでいる
    expect(callsTo(BACKLOG_MYSELF)[0]?.headers.get("authorization")).toBe("Bearer backlog-at-1");
  });

  it("不正なトークンの /mcp は 401", async () => {
    await setupMocks();
    const res = await mcpRequest("not-a-valid-token", "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });
});
