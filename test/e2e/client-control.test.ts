/**
 * フラグのクライアント制御(M05.5): toolsets / read_only は /mcp の URL クエリ、timezone はツール引数。
 * 環境変数は使わない。Worker 全体への HTTP(認可フローで得たトークン)で固定する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";
import {
  BACKLOG_HOST,
  firstText,
  MCP_URL,
  mcpRequest,
  modernRequest,
  ORIGIN,
  readRpc,
  runAuthorizationFlow,
  setupMocks,
  type TokenSet,
} from "../helpers/oauth-flow";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const API = `${BACKLOG_HOST}/api/v2`;

async function loggedIn(handlers: Parameters<typeof mockOutboundFetch>[0] = {}) {
  await setupMocks();
  const flow = await runAuthorizationFlow();
  const { access_token } = (await flow.tokenResponse.json()) as TokenSet;
  vi.restoreAllMocks();
  return { token: access_token, ...mockOutboundFetch(handlers) };
}

describe("E2E 13-1: URL クエリ(toolsets / read_only)", () => {
  it("toolsets と read_only は組み合わせられる(issue は読み取りだけ残る)", async () => {
    const { token } = await loggedIn();
    const res = await mcpRequest(
      token,
      "tools/list",
      {},
      `${MCP_URL}?toolsets=issue&read_only=true`,
    );
    expect(res.status).toBe(200);
    const names = (await readRpc(res)).result?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("logbutler_issue_list");
    expect(names).not.toContain("logbutler_issue_create");
    expect(names).not.toContain("logbutler_wiki_list");
  });

  it("未知の toolset は 400 で、理由(どの名前が悪いか・有効な名前)を本文に返す。Backlog は呼ばない", async () => {
    const { token, calls } = await loggedIn();
    const url = `${MCP_URL}?toolsets=issue,isue`;
    const lanes = [
      mcpRequest(token, "tools/list", {}, url),
      modernRequest(token, "tools/list", {}, { url }),
    ];
    for (const pending of lanes) {
      const res = await pending;
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("isue");
      expect(text).toContain("toolsets");
      expect(text).toContain("wiki");
    }
    expect(calls).toHaveLength(0);
  });

  it("read_only が true / false 以外なら 400 で、tools/call も実行されない", async () => {
    const { token, calls } = await loggedIn();
    const res = await mcpRequest(
      token,
      "tools/call",
      { name: "logbutler_watching_delete", arguments: { watching_id: 5 } },
      `${MCP_URL}?read_only=yes`,
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("read_only");
    expect(text).toContain("yes");
    expect(calls).toHaveLength(0);
  });

  it("read_only の綴り違い(readonly など)は 400 で、正しいキー名を案内する。tools/call も実行されない", async () => {
    const { token, calls } = await loggedIn();
    for (const key of ["readonly", "readOnly", "read-only"]) {
      const res = await mcpRequest(
        token,
        "tools/call",
        { name: "logbutler_watching_delete", arguments: { watching_id: 5 } },
        `${MCP_URL}?${key}=true`,
      );
      expect(res.status, key).toBe(400);
      const text = await res.text();
      expect(text, key).toContain(key);
      expect(text, key).toContain("read_only");
    }
    expect(calls).toHaveLength(0);
  });

  it("read / tool で始まる未知のキー(toolset・readonlly など)も 400。optimize_context などは無視して 200", async () => {
    const { token, calls } = await loggedIn();
    for (const key of ["toolset", "readonlly", "tools", "readOnlyMode"]) {
      const res = await mcpRequest(token, "tools/list", {}, `${MCP_URL}?${key}=wiki`);
      expect(res.status, key).toBe(400);
      const text = await res.text();
      expect(text, key).toContain(key);
      expect(text, key).toMatch(/read_only|toolsets/);
    }
    for (const key of ["optimize_context", "codemode"]) {
      const res = await mcpRequest(token, "tools/list", {}, `${MCP_URL}?${key}=true`);
      expect(res.status, key).toBe(200);
    }
    expect(calls).toHaveLength(0);
  });

  it("クエリ付き URL でもトークンなしは 401 で、チャレンジの resource_metadata はクエリを含まない正規 URL", async () => {
    const res = await mcpRequest(null, "tools/list", {}, `${MCP_URL}?toolsets=wiki`);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("不正なクエリでもトークンなしなら先に 401(認証前にクエリの検証結果を見せない)", async () => {
    const res = await mcpRequest(null, "tools/list", {}, `${MCP_URL}?toolsets=isue`);
    expect(res.status).toBe(401);
  });

  it("クエリ付き URL で Backlog が 401 を返すと、正規 URL を指す invalid_token のチャレンジ", async () => {
    const { token } = await loggedIn({ [`GET ${API}/users/myself`]: () => jsonResponse({}, 401) });
    const res = await mcpRequest(
      token,
      "tools/call",
      { name: "logbutler_user_me", arguments: {} },
      `${MCP_URL}?toolsets=user`,
    );
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("保護リソースのメタデータの resource はクエリなしの /mcp のまま(クエリ付き URL もこの resource に属する)", async () => {
    const res = await mcpRequest(null, "tools/list");
    const url = /resource_metadata="([^"]+)"/.exec(res.headers.get("WWW-Authenticate") ?? "")?.[1];
    const { worker } = await import("../helpers/oauth-flow");
    const meta = (await (await worker.fetch(url ?? "")).json()) as { resource: string };
    expect(meta.resource).toBe(MCP_URL);
  });
});

describe("E2E 13-2: timezone 引数", () => {
  // 2026-10-28 15:30 UTC = 東京では 10-29 の 00:30
  const call = async (token: string, args: Record<string, unknown>) => {
    const res = await mcpRequest(token, "tools/call", {
      name: "logbutler_issue_list",
      arguments: args,
    });
    expect(res.status).toBe(200);
    const rpc = await readRpc(res);
    return { isError: rpc.result?.isError === true, json: JSON.parse(firstText(rpc)) };
  };

  it("省略時は Asia/Tokyo、指定すればその地域の「今日」で Backlog に問い合わせる", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-28T15:30:00Z") });
    const { token, calls } = await loggedIn({ [`GET ${API}/issues`]: () => jsonResponse([]) });
    const due = async (args: Record<string, unknown>) => {
      const before = calls.length;
      await call(token, { due_date: "today", ...args });
      return new URL(calls[before]?.url ?? "").searchParams.get("dueDateSince");
    };
    expect(await due({})).toBe("2026-10-29");
    expect(await due({ timezone: "UTC" })).toBe("2026-10-28");
    expect(await due({ timezone: "America/Los_Angeles" })).toBe("2026-10-28");
  });

  it("存在しないタイムゾーンは argument_error で、Backlog は呼ばない", async () => {
    const { token, calls } = await loggedIn();
    const { isError, json } = await call(token, { due_date: "today", timezone: "Mars/Base" });
    expect(isError).toBe(true);
    expect(json.error.code).toBe("argument_error");
    expect(json.error.message).toContain("Mars/Base");
    expect(calls).toHaveLength(0);
  });
});
