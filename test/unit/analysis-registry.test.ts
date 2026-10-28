import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createBacklogClient } from "../../src/backlog/client";
import { defineTool } from "../../src/mcp/registry";
import { createMcpServer } from "../../src/mcp/server";
import { rpcTo } from "../helpers/mcp";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";
import { firstText } from "../helpers/oauth-flow";

afterEach(() => vi.restoreAllMocks());

const probe = (maxApiCalls?: number) =>
  defineTool({
    name: "logbutler_analysis_probe",
    title: "プローブ",
    description: "probe",
    category: "ReadOnly",
    toolset: "analysis",
    inputSchema: z.object({ times: z.number() }),
    ...(maxApiCalls === undefined ? {} : { maxApiCalls }),
    handler: async ({ times }, ctx) => {
      for (let i = 0; i < times; i++) await ctx.client.request("GET", "/ping");
      return { spaceHost: ctx.spaceHost, ok: true };
    },
  });

async function call(tool: ReturnType<typeof probe>, times: number) {
  const mocks = mockOutboundFetch({
    "GET https://example.backlog.com/api/v2/ping": () => jsonResponse({}),
  });
  const getClient = vi.fn((o?: { maxApiCalls?: number }) =>
    createBacklogClient({
      spaceHost: "example.backlog.com",
      accessToken: "tok",
      maxApiCalls: o?.maxApiCalls,
    }),
  );
  const res = await rpcTo(
    () =>
      createMcpServer({
        tools: [tool],
        getClient,
        onBacklogUnauthorized: () => {},
        spaceHost: "example.backlog.com",
      }),
    "tools/call",
    { name: tool.name, arguments: { times } },
  );
  return { res, getClient, mocks, text: firstText(res) };
}

describe("registry: ツールごとの maxApiCalls", () => {
  it("宣言した maxApiCalls を getClient に渡す", async () => {
    const { getClient } = await call(probe(7), 1);
    expect(getClient).toHaveBeenCalledWith({ maxApiCalls: 7 });
  });

  it("宣言がなければ maxApiCalls は渡さない(クライアントの既定 50 回のまま)", async () => {
    const { getClient } = await call(probe(), 1);
    expect(getClient).toHaveBeenCalledWith({});
  });

  it("宣言した回数ちょうどまでは通り、+1 回目で api_error(retryable でない)になる", async () => {
    const ok = await call(probe(3), 3);
    expect(ok.res.result?.isError).toBeFalsy();
    expect(ok.mocks.calls).toHaveLength(3);

    vi.restoreAllMocks();
    const over = await call(probe(3), 4);
    expect(over.res.result?.isError).toBe(true);
    expect(JSON.parse(over.text).error).toMatchObject({ code: "api_error", retryable: false });
    expect(over.mocks.calls).toHaveLength(3);
  });

  it("ToolContext に spaceHost が渡る", async () => {
    const { text } = await call(probe(3), 1);
    expect(JSON.parse(text)).toEqual({ spaceHost: "example.backlog.com", ok: true });
  });
});
