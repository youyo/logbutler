/**
 * feedback ツール(ADR 0019)。OAuth 済みトークンで /mcp(Worker 全体への HTTP)から呼び、
 * 公開(既定で見える・read_only=true でも見える・toolsets=issue では消える)と、応答に環境の値が出ないことを固定する。
 *
 * 応答はそのまま公開 issue に貼られうる。env(PUBLIC_BASE_URL・Backlog のスペース)と grant(利用者・トークン)が
 * 異なる 2 つの構成で、応答が完全に一致することを確かめる(C5)。Backlog・GitHub への通信は 0 回。
 */
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { mockOutboundFetch } from "../helpers/mock-fetch";
import {
  DEFAULT_TARGET,
  type FlowTarget,
  firstText,
  MCP_URL,
  mcpRequest,
  readRpc,
  runAuthorizationFlow,
  setupMocks,
  type TokenSet,
} from "../helpers/oauth-flow";

afterEach(() => vi.restoreAllMocks());

const NAME = "logbutler_feedback";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

/** 構成 B: Worker の公開 URL・Backlog のスペース・利用者・トークンを、構成 A(テストの既定)と変えた番兵の値。 */
const B = {
  origin: "https://sentinel-worker-q7x.example.net",
  spaceHost: "sentinel-space-k3v.backlog.jp",
  backlogToken: "backlog-at-sentinel-tok-55w",
  backlogRefresh: "backlog-rt-sentinel-ref-81p",
  myself: {
    id: 919_191,
    userId: "sentinel-user-z8m",
    name: "Sentinel Person Qx",
    mailAddress: "sentinel-mail-j2@sentinel-corp.example",
  },
};

const envB = {
  ...(env as unknown as Env),
  PUBLIC_BASE_URL: B.origin,
  BACKLOG_SPACE_HOST: B.spaceHost,
} as Env;

const targetB: FlowTarget = {
  origin: B.origin,
  fetch: (url, init = {}) =>
    worker.fetch(new Request(url, { redirect: "manual", ...init }), envB, ctx),
};

/** OAuth の通しを流し、MCP のアクセストークンを返す。Backlog のモックは通しのあと外す。 */
async function login(
  target: FlowTarget,
  mocks: Parameters<typeof setupMocks>[0] = {},
): Promise<string> {
  await setupMocks(mocks);
  const flow = await runAuthorizationFlow(target);
  expect(flow.tokenResponse.status).toBe(200);
  const { access_token } = (await flow.tokenResponse.json()) as TokenSet;
  vi.restoreAllMocks();
  return access_token;
}

const loginA = () => login(DEFAULT_TARGET);
const loginB = () =>
  login(targetB, {
    backlogHost: `https://${B.spaceHost}`,
    myself: B.myself,
    backlogToken: () =>
      Response.json({
        access_token: B.backlogToken,
        refresh_token: B.backlogRefresh,
        token_type: "Bearer",
        expires_in: 3600,
      }),
  });

async function toolNames(token: string, query = ""): Promise<string[]> {
  const res = await mcpRequest(token, "tools/list", {}, `${MCP_URL}${query}`);
  expect(res.status, `tools/list ${query}`).toBe(200);
  const tools = (await readRpc(res)).result?.tools;
  expect(tools, `tools/list ${query} に result.tools がない`).toBeDefined();
  return (tools ?? []).map((t) => t.name).sort();
}

async function callFeedback(
  token: string,
  target: FlowTarget,
  args: Record<string, unknown>,
  query = "",
) {
  const res = await mcpRequest(
    token,
    "tools/call",
    { name: NAME, arguments: args },
    `${target.origin}/mcp${query}`,
    target.fetch,
  );
  expect(res.status).toBe(200);
  return readRpc(res);
}

describe("E2E: feedback ツールの公開", () => {
  it("既定(toolsets=all)で tools/list に出る(89 個)", async () => {
    const token = await loginA();
    const names = await toolNames(token);
    expect(names).toContain(NAME);
    expect(names).toHaveLength(89); // UPLOAD_BUCKET あり(ADR 0018 の prepare を含む)
  });

  it("read_only=true でも見える(読み取り専用)", async () => {
    const token = await loginA();
    expect(await toolNames(token, "?read_only=true")).toContain(NAME);
  });

  it("toolsets=issue では消え、toolsets=feedback ではこれだけ(read_only=true でも 0 個にならない)", async () => {
    const token = await loginA();
    expect(await toolNames(token, "?toolsets=issue")).not.toContain(NAME);
    expect(await toolNames(token, "?toolsets=feedback")).toEqual([NAME]);
    expect(await toolNames(token, "?toolsets=feedback&read_only=true")).toEqual([NAME]);
  });

  it("annotations は readOnlyHint=true・openWorldHint=false", async () => {
    const token = await loginA();
    const res = await mcpRequest(token, "tools/list", {}, `${MCP_URL}?toolsets=feedback`);
    const tool = (await readRpc(res)).result?.tools?.[0] as unknown as {
      annotations: Record<string, unknown>;
    };
    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
});

describe("E2E: feedback ツールの tools/call", () => {
  it("案内の JSON を text content で返す。Backlog にも GitHub にも通信しない", async () => {
    const token = await loginA();
    const { calls } = mockOutboundFetch({});
    const rpc = await callFeedback(token, DEFAULT_TARGET, {});
    expect(rpc.result?.isError).toBeUndefined();
    const out = JSON.parse(firstText(rpc));
    expect(out.schema_version).toBe("1");
    expect(out.kind).toBe("bug");
    expect(out.repository).toEqual({
      owner: "youyo",
      repo: "logbutler",
      url: "https://github.com/youyo/logbutler",
    });
    expect(out.title_template).toBe("[feedback] <公開ツール名>: <一行の要約>");
    expect(out.search_url).toBe("https://github.com/youyo/logbutler/issues");
    expect(out.create.web.new_issue_url).toBe("https://github.com/youyo/logbutler/issues/new");
    expect(out.create.gh.command).toBe(
      "gh issue create -R youyo/logbutler --title '<title>' --body-file <承認された本文のファイル>",
    );
    expect(Object.keys(out.create)).toEqual(["web", "gh", "github_mcp"]);
    expect(calls).toEqual([]);
  });

  it("tools/list の入力スキーマは kind だけ(P5)", async () => {
    const token = await loginA();
    const res = await mcpRequest(token, "tools/list", {}, `${MCP_URL}?toolsets=feedback`);
    const tool = (await readRpc(res)).result?.tools?.[0] as unknown as {
      inputSchema: { properties: Record<string, unknown> };
    };
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["kind"]);
  });

  it("env と grant が異なる 2 つの構成で、kind ごとに応答が完全に一致し、どちらの環境の値も出ない(C5・P5)", async () => {
    const tokenA = await loginA();
    const tokenB = await loginB();
    expect(tokenB).not.toBe(tokenA);

    const sentinels = [
      // 構成 A(テストの既定)
      "logbutler.test",
      "example.backlog.com",
      "alice",
      "Alice",
      "backlog-at-1",
      "backlog-rt-1",
      tokenA,
      // 構成 B
      "sentinel",
      B.origin,
      B.spaceHost,
      B.backlogToken,
      B.backlogRefresh,
      String(B.myself.id),
      B.myself.userId,
      B.myself.name,
      B.myself.mailAddress,
      tokenB,
    ];

    const { calls } = mockOutboundFetch({});
    for (const args of [
      {},
      { kind: "bug" },
      { kind: "feature" },
      { kind: "question" },
      { kind: "other" },
    ]) {
      const textA = firstText(await callFeedback(tokenA, DEFAULT_TARGET, args));
      const textB = firstText(await callFeedback(tokenB, targetB, args));
      expect(textA, JSON.stringify(args)).not.toBe("");
      expect(textB, JSON.stringify(args)).toBe(textA);
      for (const s of sentinels) {
        expect(textA, `${JSON.stringify(args)} に ${s}`).not.toContain(s);
      }
    }
    // read_only で絞っても同じ応答
    const ro = firstText(await callFeedback(tokenB, targetB, {}, "?read_only=true"));
    expect(ro).toBe(firstText(await callFeedback(tokenA, DEFAULT_TARGET, {})));
    expect(calls).toEqual([]);
  });

  it("不正な kind は argument_error のエンベロープで、値をそのまま返さない", async () => {
    const token = await loginA();
    const { calls } = mockOutboundFetch({});
    const rpc = await callFeedback(token, DEFAULT_TARGET, {
      kind: "sentinel-kind-https://example.backlog.com",
    });
    expect(rpc.result?.isError).toBe(true);
    const text = firstText(rpc);
    expect(JSON.parse(text)).toMatchObject({
      schema_version: "1",
      error: { code: "argument_error", retryable: false },
    });
    expect(text).not.toContain("sentinel");
    expect(text).not.toContain("example.backlog.com");
    expect(calls).toEqual([]);
  });

  it("宣言していない引数(廃止した tool_name・下書きの title / body)は無視され、応答に出ない(P5)", async () => {
    const token = await loginA();
    const { calls } = mockOutboundFetch({});
    const plain = firstText(await callFeedback(token, DEFAULT_TARGET, { kind: "bug" }));
    const extra = firstText(
      await callFeedback(token, DEFAULT_TARGET, {
        kind: "bug",
        tool_name: "sentinel_tool_q1",
        title: "sentinel-title-q2",
        body: "sentinel-body-q3",
      }),
    );
    expect(extra).toBe(plain);
    expect(extra).not.toContain("sentinel");
    expect(calls).toEqual([]);
  });
});
