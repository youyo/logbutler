import { expect } from "vitest";
import { createBacklogClient } from "../../src/backlog/client";
import type { IdempotencyDeps } from "../../src/mcp/idempotency";
import { createMcpServer } from "../../src/mcp/server";
import { rpcTo } from "./mcp";
import { jsonResponse, mockOutboundFetch, type RecordedCall } from "./mock-fetch";
import { firstText } from "./oauth-flow";

export const BACKLOG_API = "https://example.backlog.com/api/v2";
export const TEST_TOKEN = "tok-test-123";

/** 応答の指定。値は JSON 本文、Response、または呼び出しを見て返す関数。 */
export type Respond = unknown | Response | ((call: RecordedCall) => Response | unknown);

/**
 * 呼び出しの表記: `GET /issues?projectId[]=1&count=20`。パスはエンコードされたまま、
 * クエリは decode して key 順(同じ key の中は送った順)に並べる。
 */
export function describeCall(call: RecordedCall): string {
  const url = new URL(call.url);
  const pairs = [...url.searchParams.entries()]
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => (a.entry[0] < b.entry[0] ? -1 : a.entry[0] > b.entry[0] ? 1 : a.i - b.i))
    .map(({ entry: [k, v] }) => `${k}=${v}`);
  return `${call.method} ${url.pathname.replace(/^\/api\/v2/, "")}${pairs.length ? `?${pairs.join("&")}` : ""}`;
}

/** フォーム本文（application/x-www-form-urlencoded）を `key=value` の配列にする。キー順にそろえる（同じキーは送った順）。 */
export function formPairs(call: RecordedCall | undefined): string[] {
  return [...new URLSearchParams(call?.body ?? "").entries()]
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => (a.entry[0] < b.entry[0] ? -1 : a.entry[0] > b.entry[0] ? 1 : a.i - b.i))
    .map(({ entry: [k, v] }) => `${k}=${v}`);
}

export interface ToolRun {
  isError: boolean;
  text: string;
  /** text を JSON として読んだもの(JSON でなければ undefined)。 */
  // biome-ignore lint/suspicious/noExplicitAny: テストが応答の JSON を自由に辿るため
  json: any;
  calls: string[];
  recorded: RecordedCall[];
}

/**
 * 実際の Backlog クライアント(fetch はモック)を通してツールを呼ぶ。
 * respond のキーは "METHOD /path"(クエリなし、/api/v2 以降)。想定外の宛先への通信は例外になる。
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  respond: Record<string, Respond>,
  opts: {
    now?: Date;
    timezone?: string;
    /** WriteNonIdempotent の冪等キャッシュ(省略時はキャッシュなし)。 */
    idempotency?: IdempotencyDeps;
    /** tools/call の params._meta。 */
    meta?: Record<string, unknown>;
  } = {},
): Promise<ToolRun> {
  const handlers = Object.fromEntries(
    Object.entries(respond).map(([key, value]) => {
      const [method, path] = key.split(" ");
      return [
        `${method} ${BACKLOG_API}${path}`,
        (call: RecordedCall) => {
          const v =
            typeof value === "function" ? (value as (c: RecordedCall) => unknown)(call) : value;
          return v instanceof Response ? v : jsonResponse(v);
        },
      ];
    }),
  );
  const mocks = mockOutboundFetch(handlers);
  const res = await rpcTo(
    () =>
      createMcpServer({
        getClient: (options) =>
          createBacklogClient({
            spaceHost: "example.backlog.com",
            accessToken: TEST_TOKEN,
            maxApiCalls: options.maxApiCalls,
          }),
        spaceHost: "example.backlog.com",
        onBacklogUnauthorized: () => {},
        now: opts.now ? () => opts.now as Date : undefined,
        timezone: opts.timezone,
        idempotency: opts.idempotency,
      }),
    "tools/call",
    { name, arguments: args, ...(opts.meta ? { _meta: opts.meta } : {}) },
  );
  const text = firstText(res);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    isError: res.result?.isError === true,
    text,
    json,
    calls: mocks.calls.map(describeCall),
    recorded: mocks.calls,
  };
}

export interface ToolCase {
  tool: string;
  args?: Record<string, unknown>;
  /** "METHOD /path" → 応答。呼ぶ順に書く。 */
  respond: Record<string, Respond>;
  /** 期待する呼び出し(順序つき)。`describeCall` の表記。 */
  calls: string[];
  /** ツールの出力。省略時は最後に返した応答の本文(Backlog の生データのまま返すツール用)。 */
  output?: unknown;
}

/** 引数 → Backlog API への写像と、返却 JSON を検証する。 */
export async function expectTool(c: ToolCase): Promise<ToolRun> {
  const run = await callTool(c.tool, c.args ?? {}, c.respond);
  expect(run.isError, run.text).toBe(false);
  expect(run.calls).toEqual(c.calls);
  const last = Object.values(c.respond).at(-1);
  const expected =
    c.output !== undefined ? c.output : typeof last === "function" ? undefined : last;
  if (expected !== undefined) expect(run.json).toEqual(expected);
  return run;
}
