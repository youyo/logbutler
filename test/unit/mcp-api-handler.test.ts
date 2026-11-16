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
      expect(await names("")).toHaveLength(88); // テストの env は UPLOAD_BUCKET あり(prepare を含む)
    });

    it("環境変数 LOGBUTLER_* は読まない(クエリが唯一の入口)", async () => {
      const res = await listTools(
        { ...env, LOGBUTLER_TOOLSETS: "wiki", LOGBUTLER_READ_ONLY: "true" },
        "",
      );
      expect(parseRpcResponse(await res.text()).result?.tools).toHaveLength(88);
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

describe("添付アップロードの URL 経路(UPLOAD_BUCKET。ADR 0018)", () => {
  const PREPARE = "logbutler_issue_attachment_upload_prepare";
  const withoutBucket = () => {
    const { UPLOAD_BUCKET: _omit, ...rest } = env as unknown as Record<string, unknown>;
    return rest;
  };
  async function toolNames(testEnv: object, query = ""): Promise<string[]> {
    const res = await listTools(testEnv, query);
    expect(res.status).toBe(200);
    return (parseRpcResponse(await res.text()).result?.tools ?? []).map((t) => t.name);
  }
  function call(testEnv: object, name: string, args: Record<string, unknown>) {
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
          params: { name, arguments: args },
        }),
      }),
      testEnv as typeof env,
      ctx,
    );
  }

  it("binding があれば prepare を公開し、upload_url は PUBLIC_BASE_URL の /uploads/<id>", async () => {
    expect(await toolNames(env)).toContain(PREPARE);
    const res = await call(env, PREPARE, {});
    const text = parseRpcResponse(await res.text()).result?.content?.[0]?.text ?? "";
    const out = JSON.parse(text) as { upload_id: string; upload_url: string };
    expect(out.upload_url).toBe(`https://logbutler.test/uploads/${out.upload_id}`);
  });

  it("binding が無ければ prepare を tools/list に出さない(スキーマは変えない)", async () => {
    const without = await toolNames(withoutBucket());
    expect(without).not.toContain(PREPARE);
    const withBucket = await toolNames(env);
    expect(without).toEqual(withBucket.filter((n) => n !== PREPARE));
  });

  it("read_only=true では binding があっても prepare は出ない", async () => {
    expect(await toolNames(env, "?read_only=true")).not.toContain(PREPARE);
  });

  it("binding が無い Worker で upload_id を渡すと、Backlog を呼ばずに明確なエラー", async () => {
    const m = mockOutboundFetch({});
    const res = await call(withoutBucket(), "logbutler_issue_attachment_upload", {
      issue_key: "PROJ-1",
      file_name: "a.txt",
      upload_id: "A".repeat(43),
    });
    const rpc = parseRpcResponse(await res.text());
    expect(rpc.result?.isError).toBe(true);
    const envelope = JSON.parse(rpc.result?.content?.[0]?.text ?? "{}");
    expect(envelope.error.code).toBe("argument_error");
    expect(envelope.error.message).toContain("file_content_base64");
    expect(m.calls).toEqual([]);
  });
});
