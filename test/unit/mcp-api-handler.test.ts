import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GrantProps } from "../../src/auth/props";
import { createMcpApiHandler } from "../../src/mcp/api-handler";
import { parseRpcResponse } from "../helpers/mcp";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";

const MYSELF = "GET https://example.backlog.com/api/v2/users/myself";
const props: GrantProps = {
  backlogAccessToken: "backlog-at",
  backlogRefreshToken: "backlog-rt",
  backlogExpiresAt: Date.now() + 3_600_000,
  backlogUserId: 42,
};
const ctx = { waitUntil() {}, passThroughOnException() {}, props } as unknown as ExecutionContext;

function callTool(testEnv: object = env) {
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
    testEnv as typeof env,
    ctx,
  );
}

function listTools(testEnv: object, query = "") {
  return createMcpApiHandler().fetch(
    new Request(`https://logbutler.test/mcp${query}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    testEnv as typeof env,
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

  describe("Backlog の 401 で grant に更新の印を置く", () => {
    const MCP_TOKEN = "42:grant-unit-1:mcp-secret-value";
    const authCtx = {
      waitUntil() {},
      passThroughOnException() {},
      props: { ...props, backlogExpiresAt: Date.now() + 2_000_000 },
      auth: { token: MCP_TOKEN, audience: "https://logbutler.test/mcp", scope: [], userId: "42" },
    } as unknown as ExecutionContext;
    const call = (testEnv: object = env) =>
      createMcpApiHandler().fetch(
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
        testEnv as typeof env,
        authCtx,
      );

    it("Backlog が 401 なら backlog-stale:<userId>:<grantId> を KV に置く(値にトークンは入らない)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockOutboundFetch({ [MYSELF]: () => jsonResponse({}, 401) });
      const res = await call();
      expect(res.status).toBe(401);
      const value = await env.OAUTH_KV.get("backlog-stale:42:grant-unit-1");
      expect(value).not.toBeNull();
      for (const secret of ["backlog-at", "backlog-rt", "mcp-secret-value"]) {
        expect(value).not.toContain(secret);
      }
    });

    it("Backlog が 200 なら印を置かない", async () => {
      mockOutboundFetch({
        [MYSELF]: () => jsonResponse({ id: 42, userId: "alice", name: "Alice" }),
      });
      const ctx2 = {
        ...authCtx,
        auth: { token: "42:grant-unit-ok:secret", audience: "x", scope: [], userId: "42" },
      } as unknown as ExecutionContext;
      const res = await createMcpApiHandler().fetch(
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
        ctx2,
      );
      expect(res.status).toBe(200);
      expect(await env.OAUTH_KV.get("backlog-stale:42:grant-unit-ok")).toBeNull();
    });

    it.each([403, 404, 429, 500])(
      "Backlog が %i なら印を置かない(401 のときだけ置く)",
      async (status) => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        mockOutboundFetch({ [MYSELF]: () => jsonResponse({}, status) });
        const ctx3 = {
          ...authCtx,
          auth: { token: `42:grant-unit-${status}:secret`, audience: "x", scope: [], userId: "42" },
        } as unknown as ExecutionContext;
        const res = await createMcpApiHandler().fetch(
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
          ctx3,
        );
        expect(res.status).not.toBe(401);
        expect(await env.OAUTH_KV.get(`backlog-stale:42:grant-unit-${status}`)).toBeNull();
      },
      30_000,
    );

    it("KV への書き込みが失敗しても 401 は返す", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockOutboundFetch({ [MYSELF]: () => jsonResponse({}, 401) });
      const brokenKv = {
        ...env.OAUTH_KV,
        get: env.OAUTH_KV.get.bind(env.OAUTH_KV),
        put: async () => {
          throw new Error("kv down");
        },
      };
      const res = await call({ ...env, OAUTH_KV: brokenKv });
      expect(res.status).toBe(401);
    });

    it("401 の診断ログに props 上の残り秒数と印の結果を出し、トークンは出さない", async () => {
      const lines: string[] = [];
      for (const level of ["log", "info", "warn", "error"] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        });
      }
      mockOutboundFetch({ [MYSELF]: () => jsonResponse({}, 401) });
      await call();
      const event = lines
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as Record<string, unknown>];
          } catch {
            return [];
          }
        })
        .find((e) => e.event === "backlog_unauthorized");
      expect(event).toMatchObject({ event: "backlog_unauthorized", stale_marked: true });
      expect(typeof event?.backlog_remaining_seconds).toBe("number");
      // props の期限は約 2000 秒後
      expect(event?.backlog_remaining_seconds as number).toBeGreaterThan(1900);
      expect(event?.backlog_remaining_seconds as number).toBeLessThanOrEqual(2000);
      const all = lines.join("\n");
      for (const secret of ["backlog-at", "backlog-rt", "mcp-secret-value", MCP_TOKEN]) {
        expect(all).not.toContain(secret);
      }
    });
  });

  describe("URL クエリ(toolsets / read_only)", () => {
    const names = async (query: string) => {
      const res = await listTools(env, query);
      expect(res.status).toBe(200);
      return parseRpcResponse(await res.text()).result?.tools?.map((t) => t.name) ?? [];
    };

    it("?toolsets= で有効なグループを絞る(user_me は user グループ)", async () => {
      expect(await names("?toolsets=user")).toContain("logbutler_user_me");
      expect(await names("?toolsets=issue,wiki")).not.toContain("logbutler_user_me");
    });

    it("?read_only=true でも読み取りツールは残り、書き込みは消える", async () => {
      const ro = await names("?read_only=true");
      expect(ro).toContain("logbutler_user_me");
      expect(ro).not.toContain("logbutler_issue_create");
    });

    it("クエリなしなら全ツール", async () => {
      expect(await names("")).toHaveLength(86);
    });

    it("環境変数 LOGBUTLER_* は読まない(クエリが唯一の入口)", async () => {
      const res = await listTools(
        { ...env, LOGBUTLER_TOOLSETS: "wiki", LOGBUTLER_READ_ONLY: "true" },
        "",
      );
      expect(parseRpcResponse(await res.text()).result?.tools).toHaveLength(86);
    });

    it("未知の toolset は 400 で、理由(悪い名前・有効な名前)を本文に返す。ツールは実行しない", async () => {
      const res = await listTools(env, "?toolsets=isue");
      expect(res.status).toBe(400);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      const body = (await res.json()) as { error: string; error_description: string };
      expect(body.error).toBe("invalid_query");
      expect(body.error_description).toContain("isue");
      expect(body.error_description).toContain("wiki");
    });

    it("read_only が true / false 以外なら 400", async () => {
      const res = await listTools(env, "?read_only=yes");
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("read_only");
    });
  });

  describe("timezone 引数(「今日」の基準)", () => {
    const ISSUES = "GET https://example.backlog.com/api/v2/issues";
    const callIssueList = (args: Record<string, unknown>) =>
      createMcpApiHandler().fetch(
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
            params: { name: "logbutler_issue_list", arguments: { due_date: "today", ...args } },
          }),
        }),
        env,
        ctx,
      );

    // 2026-10-28 15:30 UTC = 東京では 10-29 の 00:30
    const dueDate = async (args: Record<string, unknown>) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-10-28T15:30:00Z"));
        const m = mockOutboundFetch({ [ISSUES]: () => jsonResponse([]) });
        const res = await callIssueList(args);
        expect(res.status).toBe(200);
        return new URL(m.calls[0]?.url ?? "").searchParams.get("dueDateSince");
      } finally {
        vi.useRealTimers();
      }
    };

    it("省略なら Asia/Tokyo", async () => {
      expect(await dueDate({})).toBe("2026-10-29");
    });

    it("引数で指定すればその地域の今日になる。廃止した環境変数は読まない", async () => {
      expect(await dueDate({ timezone: "UTC" })).toBe("2026-10-28");
      expect(await dueDate({ timezone: "America/Los_Angeles" })).toBe("2026-10-28");
    });
  });
});
