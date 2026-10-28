/**
 * M06 §0: Cloudflare Access 連携の削除。Logbutler は Backlog OAuth の認可サーバーだけを担い、
 * 利用者の制限は外側(MCP Server Portal の Access ポリシー)で行う(ADR 0009)。
 * Access の JWT(Cf-Access-Jwt-Assertion)なしで認可フロー全体が通ることを固定する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_REDIRECT,
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

afterEach(() => vi.restoreAllMocks());

describe("E2E 14: Access の JWT なしで認可フローが通る", () => {
  it("/register → /authorize → /callback → /token → /mcp が、Cf-Access-Jwt-Assertion なしで通る", async () => {
    const { callsTo } = await setupMocks();
    const flow = await runAuthorizationFlow();

    expect(flow.consent.status).toBe(200);
    expect(flow.backlogRedirect.status).toBe(302);
    expect(flow.callbackResponse.status).toBe(302);
    expect(flow.clientCode).not.toBe("");
    expect(flow.tokenResponse.status).toBe(200);
    expect(callsTo("POST https://example.backlog.com/api/v2/oauth2/token")).toHaveLength(1);

    const { access_token } = (await flow.tokenResponse.json()) as TokenSet;
    const list = await mcpRequest(access_token, "tools/list");
    expect(list.status).toBe(200);
    expect(((await readRpc(list)).result?.tools ?? []).length).toBeGreaterThan(0);
  });

  it("同意画面に Access のメールアドレス表示(Signed in as)がない", async () => {
    await setupMocks();
    const flow = await runAuthorizationFlow();
    expect(flow.html).not.toContain("Signed in as");
    expect(flow.html).not.toContain("alice@example.com");
  });

  it("JWT なしの POST /authorize(拒否)も 403 にならず、クライアントへ access_denied で戻る", async () => {
    await setupMocks();
    const clientId = await registerClient();
    const { challenge } = await pkcePair();
    const authorize = await worker.fetch(
      `${ORIGIN}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
        state: "s",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: MCP_URL,
      })}`,
    );
    expect(authorize.status).toBe(200);
    const cookie = authorize.headers
      .getSetCookie()
      .map((l) => l.split(";")[0])
      .join("; ");
    const handle = /name="handle" value="([^"]+)"/.exec(await authorize.text())?.[1] ?? "";
    const denied = await worker.fetch(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, decision: "deny" }),
    });
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get("Location") ?? "", ORIGIN).searchParams.get("error")).toBe(
      "access_denied",
    );
  });
});
