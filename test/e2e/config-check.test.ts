import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import worker from "../../src/index";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

afterEach(() => vi.restoreAllMocks());

/** Worker 全体(src/index.ts の default export)を、設定を欠かした env で呼ぶ。 */
function callWorker(
  path: string,
  overrides: Partial<Record<keyof Env, unknown>>,
  init?: RequestInit,
) {
  const badEnv = { ...env, ...overrides } as unknown as Env;
  return worker.fetch(
    new Request(`https://logbutler.test${path}`, { redirect: "manual", ...init }),
    badEnv,
    ctx,
  );
}

const GATED_PATHS: [string, RequestInit?][] = [
  ["/mcp", { method: "POST", body: "{}" }],
  ["/token", { method: "POST", body: "grant_type=authorization_code" }],
  ["/register", { method: "POST", body: "{}" }],
  ["/authorize"],
  ["/callback"],
  ["/.well-known/oauth-authorization-server"],
  ["/.well-known/oauth-protected-resource/mcp"],
];

describe("E2E: 起動時の設定チェック", () => {
  describe("secret が欠けた Worker", () => {
    it.each(GATED_PATHS)("%s は 500 で、本文に項目名も値も出さない", async (path, init) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await callWorker(path, { BACKLOG_CLIENT_SECRET: undefined }, init);
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).not.toContain("BACKLOG_CLIENT_SECRET");
      expect(body).not.toContain("test-backlog-client-id");
    });

    it("詳細はログに出る(項目名だけ。値は出ない)", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      await callWorker("/mcp", { BACKLOG_CLIENT_SECRET: undefined }, { method: "POST" });
      const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("BACKLOG_CLIENT_SECRET");
      expect(logged).not.toContain("test-backlog-client-id");
    });

    it("/healthz は 503 で、欠けている項目名だけを返す", async () => {
      const res = await callWorker("/healthz", { BACKLOG_CLIENT_SECRET: undefined });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        status: "misconfigured",
        missing: ["BACKLOG_CLIENT_SECRET"],
        invalid: [],
      });
    });
  });

  it("KV バインディングが無いと /healthz は OAUTH_KV を欠けとして返し、/mcp は 500", async () => {
    const health = await callWorker("/healthz", { OAUTH_KV: undefined });
    expect(health.status).toBe(503);
    expect(((await health.json()) as { missing: string[] }).missing).toEqual(["OAUTH_KV"]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mcp = await callWorker("/mcp", { OAUTH_KV: undefined }, { method: "POST", body: "{}" });
    expect(mcp.status).toBe(500);
  });

  it("PUBLIC_BASE_URL がプレースホルダのままなら invalid として /healthz に出る(値は出ない)", async () => {
    const res = await callWorker("/healthz", { PUBLIC_BASE_URL: "https://<domain>" });
    expect(res.status).toBe(503);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("PUBLIC_BASE_URL");
    expect(text).not.toContain("<domain>");
  });

  it("設定がそろっていれば /healthz は 200 {status:'ok'}、/mcp は通常どおり 401(認可が必要)", async () => {
    const health = await callWorker("/healthz", {});
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    const mcp = await callWorker("/mcp", {}, { method: "POST", body: "{}" });
    expect(mcp.status).toBe(401);
  });
});
