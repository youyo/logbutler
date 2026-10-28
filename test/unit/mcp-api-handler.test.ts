import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GrantProps } from "../../src/auth/props";
import { createMcpApiHandler } from "../../src/mcp/api-handler";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";

const MYSELF = "GET https://example.backlog.com/api/v2/users/myself";
const props: GrantProps = {
  backlogAccessToken: "backlog-at",
  backlogRefreshToken: "backlog-rt",
  backlogExpiresAt: Date.now() + 3_600_000,
  backlogUserId: 42,
  accessEmail: "alice@example.com",
};
const ctx = { waitUntil() {}, passThroughOnException() {}, props } as unknown as ExecutionContext;

function callTool() {
  return createMcpApiHandler().fetch(
    new Request("https://logbutler.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "logbutler_user_me", arguments: {} },
      }),
    }),
    env,
    ctx,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("MCP API handler (/mcp の下流)", () => {
  it("grant の props にある Backlog アクセストークンで Backlog を呼ぶ", async () => {
    const m = mockOutboundFetch({
      [MYSELF]: () => jsonResponse({ id: 42, userId: "alice", name: "Alice" }),
    });
    const res = await callTool();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("alice");
    expect(m.calls[0]?.headers.get("authorization")).toBe("Bearer backlog-at");
  });

  it("Backlog が 401 なら MCP も 401 + invalid_token の WWW-Authenticate にする", async () => {
    mockOutboundFetch({ [MYSELF]: () => jsonResponse({}, 401) });
    const res = await callTool();
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(
      'resource_metadata="https://logbutler.test/.well-known/oauth-protected-resource/mcp"',
    );
    // Backlog のトークンは応答に含まれない
    expect(await res.text()).not.toContain("backlog-at");
  });
});
