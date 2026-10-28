import type { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { expect } from "vitest";
import type { BacklogClient } from "../../src/backlog/client";
import type { BacklogUser } from "../../src/backlog/types";
import { callMcpHandler } from "../../src/mcp/request-body";
import type { RpcResponse } from "./oauth-flow";

/** 応答は JSON または SSE(`data: {...}` 行)のどちらでも来る。 */
export function parseRpcResponse(text: string): RpcResponse {
  const data = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim();
  return JSON.parse(data ?? "null");
}

/** McpServer のファクトリに JSON-RPC を 1 件送り、応答を返す(HTTP 層は createMcpHandler を通る)。 */
export async function rpcTo(
  factory: () => McpServer,
  method: string,
  params: Record<string, unknown> = {},
): Promise<RpcResponse> {
  const handler = createMcpHandler(factory, { route: "/mcp" });
  const res = await callMcpHandler(
    handler,
    new Request("https://logbutler.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return parseRpcResponse(text);
}

/** テスト用のクライアント。呼ばれたくないメソッドは例外にする。 */
export function fakeClient(overrides: Partial<BacklogClient> = {}): BacklogClient {
  const unexpected = (name: string) => async () => {
    throw new Error(`fakeClient: 想定外の ${name} 呼び出し`);
  };
  return {
    request: unexpected("request") as BacklogClient["request"],
    download: unexpected("download") as BacklogClient["download"],
    getMyself: unexpected("getMyself") as () => Promise<BacklogUser>,
    redact: (text) => text,
    ...overrides,
  };
}
