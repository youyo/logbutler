// test:live のクライアント(test/live/helpers/live.ts)の、/mcp が 401 のときの再試行。
// 実環境には通信しない: fetch を差し替え、状態ファイルは一時ディレクトリに置く。
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LiveClient } from "../live/helpers/live";

const MCP_URL = "https://logbutler.invalid/mcp";

interface Recorded {
  url: string;
  authorization: string | null;
  body: string;
}

/** /token はローテーションしたトークンを順に返し、/mcp は mcpStatuses の順に応答する偽の fetch。 */
function fakeServer(mcpStatuses: number[]) {
  const calls: Recorded[] = [];
  let issued = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    calls.push({ url, authorization: headers.get("Authorization"), body });
    if (url.endsWith("/token")) {
      issued++;
      return Response.json({ access_token: `mcp-at-${issued}`, refresh_token: `mcp-rt-${issued}` });
    }
    const status = mcpStatuses.shift() ?? 200;
    if (status === 401) {
      return Response.json({ error: "invalid_token" }, { status: 401 });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: '{"id":42}' }], isError: false },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

let dir: string;
let stateFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "logbutler-live-client-"));
  stateFile = join(dir, "state.json");
  writeFileSync(
    stateFile,
    JSON.stringify({ mcpUrl: MCP_URL, clientId: "client-1", refreshToken: "mcp-rt-0" }),
    { mode: 0o600 },
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = () => ({ projectKey: "TEST", stateFile });
const tokenCalls = (calls: Recorded[]) => calls.filter((c) => c.url.endsWith("/token"));
const readState = () => JSON.parse(readFileSync(stateFile, "utf8")) as { refreshToken: string };

describe("LiveClient: /mcp の 401 で MCP のトークンを 1 回だけ更新して再試行する", () => {
  it("401 → 更新(ローテーション後の値を 0600 で書き戻す)→ 再試行で成功する", async () => {
    const { calls, fetchImpl } = fakeServer([401, 200]);
    const client = await LiveClient.connect(config(), { fetch: fetchImpl });
    expect(readState().refreshToken).toBe("mcp-rt-1");

    const data = await client.ok("logbutler_user_me");
    expect(data).toEqual({ id: 42 });

    const tokens = tokenCalls(calls);
    expect(tokens).toHaveLength(2);
    expect(new URLSearchParams(tokens[1]?.body).get("refresh_token")).toBe("mcp-rt-1");
    const mcp = calls.filter((c) => c.url === MCP_URL);
    expect(mcp.map((c) => c.authorization)).toEqual(["Bearer mcp-at-1", "Bearer mcp-at-2"]);
    expect(readState().refreshToken).toBe("mcp-rt-2");
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
  });

  it("更新後も 401 ならエラーにする(更新は 1 回だけ)", async () => {
    const { calls, fetchImpl } = fakeServer([401, 401, 200]);
    const client = await LiveClient.connect(config(), { fetch: fetchImpl });
    const err = await client.ok("logbutler_user_me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain("401");
    expect(tokenCalls(calls)).toHaveLength(2);
    // エラーメッセージにトークンを出さない
    for (const secret of ["mcp-at-1", "mcp-at-2", "mcp-rt-1", "mcp-rt-2"]) {
      expect(String(err)).not.toContain(secret);
    }
  });

  it("トークンを明示した呼び出し・認証なしの呼び出しは、401 でも更新しない(401 そのものを確かめるため)", async () => {
    const { calls, fetchImpl } = fakeServer([401, 401]);
    const client = await LiveClient.connect(config(), { fetch: fetchImpl });
    expect((await client.rpc("tools/list", {}, { auth: false })).status).toBe(401);
    expect((await client.rpc("tools/list", {}, { token: "not-a-valid-token" })).status).toBe(401);
    expect(tokenCalls(calls)).toHaveLength(1);
  });
});
