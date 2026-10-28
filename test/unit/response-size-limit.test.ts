/**
 * M06: 応答サイズの上限(安全網)。ツール引数 max_response_tokens(既定 50000、0 で無効)。
 * 超えたら切り詰めず response_too_large(retryable: false)のエンベロープを返す。
 * 対象は読み取りツール(ダウンロード系を除く)。書き込みの成功は超過でもエラーにしない。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ERROR_CODES } from "../../src/errors";
import { defineTool, type ToolDefinition } from "../../src/mcp/registry";
import { DEFAULT_MAX_RESPONSE_TOKENS, estimateTokens } from "../../src/mcp/response-limit";
import { createMcpServer } from "../../src/mcp/server";
import { ALL_TOOLS } from "../../src/mcp/tools";
import { FakeKv } from "../helpers/fake-kv";
import { fakeClient, rpcTo } from "../helpers/mcp";
import { firstText } from "../helpers/oauth-flow";
import { callTool } from "../helpers/tool-call";

/** text が n 文字の ASCII を返す読み取りツール。 */
const reader = defineTool({
  name: "logbutler_issue_big",
  title: "大きな応答",
  description: "Returns a big payload",
  category: "ReadOnly",
  toolset: "issue",
  inputSchema: z.object({ chars: z.number() }),
  handler: async ({ chars }) => ({ text: "a".repeat(chars) }),
});

const noLimitReader = defineTool({
  name: "logbutler_issue_big_nolimit",
  title: "上限なし",
  description: "Returns a big payload without the limit",
  category: "ReadOnly",
  toolset: "issue",
  responseLimit: false,
  inputSchema: z.object({ chars: z.number() }),
  handler: async ({ chars }) => ({ text: "a".repeat(chars) }),
});

const writer = defineTool({
  name: "logbutler_issue_big_create",
  title: "大きな応答の書き込み",
  description: "Writes and returns a big payload",
  category: "WriteNonIdempotent",
  toolset: "issue",
  inputSchema: z.object({ chars: z.number() }),
  handler: async ({ chars }) => ({ text: "a".repeat(chars) }),
});

const idempotentWriter = defineTool({
  name: "logbutler_issue_big_update",
  title: "大きな応答の更新",
  description: "Updates and returns a big payload",
  category: "WriteIdempotent",
  toolset: "issue",
  inputSchema: z.object({ chars: z.number() }),
  handler: async ({ chars }) => ({ text: "a".repeat(chars) }),
});

async function call(tool: ToolDefinition, args: Record<string, unknown>, kv?: FakeKv) {
  const res = await rpcTo(
    () =>
      createMcpServer({
        tools: [tool],
        getClient: () => fakeClient(),
        onBacklogUnauthorized: () => {},
        ...(kv ? { idempotency: { kv, userId: 1 } } : {}),
      }),
    "tools/call",
    { name: tool.name, arguments: args },
  );
  const text = firstText(res);
  return { text, isError: res.result?.isError === true, json: JSON.parse(text) };
}

const payload = (chars: number) => JSON.stringify({ text: "a".repeat(chars) });

describe("estimateTokens(近似: ASCII は 4 文字 1 トークン、ASCII 以外は 1 文字 1 トークン)", () => {
  it("ASCII は 4 文字ごとに 1(切り上げ)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("日本語など ASCII 以外は 1 文字 1 トークンで数える(文字数 / 4 では過小評価になるため)", () => {
    expect(estimateTokens("あいうえお")).toBe(5);
    expect(estimateTokens("abcdあい")).toBe(3);
  });
});

describe("response_too_large", () => {
  it("エラーコードに response_too_large がある", () => {
    expect(ERROR_CODES).toContain("response_too_large");
  });

  it("既定値は 50000", () => {
    expect(DEFAULT_MAX_RESPONSE_TOKENS).toBe(50000);
  });

  it("上限ちょうどは通り、1 超えるとエラー(切り詰めない)", async () => {
    const chars = 400;
    const size = estimateTokens(payload(chars));
    const ok = await call(reader, { chars, max_response_tokens: size });
    expect(ok.isError).toBe(false);
    expect(ok.json.text).toBe("a".repeat(chars));

    const over = await call(reader, { chars, max_response_tokens: size - 1 });
    expect(over.isError).toBe(true);
    expect(over.json.schema_version).toBe("1");
    expect(over.json.error.code).toBe("response_too_large");
    expect(over.json.error.retryable).toBe(false);
    // 切り詰めた本文は返さない
    expect(over.text).not.toContain("aaaa");
  });

  it("message に推定サイズ・上限・絞り込みの手がかりを含む", async () => {
    const size = estimateTokens(payload(400));
    const over = await call(reader, { chars: 400, max_response_tokens: 10 });
    const msg: string = over.json.error.message;
    expect(msg).toContain(String(size));
    expect(msg).toContain("10");
    expect(msg.toLowerCase()).toContain("estimated");
    expect(msg.toLowerCase()).toContain("limit");
    for (const hint of ["count", "offset", "project_key", "max_response_tokens"]) {
      expect(msg, hint).toContain(hint);
    }
  });

  it("引数がなければ既定(50000)が効く: 50000 トークン分は通り、超えるとエラー", async () => {
    // JSON {"text":"..."} の枠 11 文字 + 本文。ちょうど 50000 トークン(= 200000 文字)になる本文長。
    const fit = 200000 - 11;
    expect(estimateTokens(payload(fit))).toBe(50000);
    expect((await call(reader, { chars: fit })).isError).toBe(false);
    const over = await call(reader, { chars: fit + 4 });
    expect(over.isError).toBe(true);
    expect(over.json.error.code).toBe("response_too_large");
  });

  it("0 で無効: 既定を超える応答も通る", async () => {
    const res = await call(reader, { chars: 250000, max_response_tokens: 0 });
    expect(res.isError).toBe(false);
    expect(res.json.text).toHaveLength(250000);
  });

  it("負の値・小数は argument_error", async () => {
    for (const v of [-1, 1.5]) {
      const res = await call(reader, { chars: 4, max_response_tokens: v });
      expect(res.isError, String(v)).toBe(true);
      expect(res.json.error.code).toBe("argument_error");
    }
  });

  it("読み取りツールには max_response_tokens が公開スキーマに載る(任意)", async () => {
    const props = reader.inputSchema.shape as Record<string, unknown>;
    expect(Object.keys(props)).toContain("max_response_tokens");
    const schema = z.toJSONSchema(reader.inputSchema) as {
      properties: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    expect(schema.properties.max_response_tokens?.type).toBe("number");
    expect(schema.required ?? []).not.toContain("max_response_tokens");
  });
});

describe("対象外", () => {
  it("responseLimit: false の読み取りツールは上限を超えても通り、引数も載らない", async () => {
    expect(Object.keys(noLimitReader.inputSchema.shape)).not.toContain("max_response_tokens");
    const res = await call(noLimitReader, { chars: 250000 });
    expect(res.isError).toBe(false);
  });

  it("ダウンロード系 2 ツールには引数がなく、上限を超える応答(base64)も通る", async () => {
    for (const name of ["logbutler_issue_attachment_download", "logbutler_shared_file_download"]) {
      const tool = ALL_TOOLS.find((t) => t.name === name);
      expect(Object.keys(tool?.inputSchema.shape ?? {}), name).not.toContain("max_response_tokens");
    }
    // 200 KB → base64 で約 267 KB(= 約 67000 トークン)。既定の 50000 を超える。
    const bytes = new Uint8Array(200 * 1024).fill(65);
    const run = await callTool(
      "logbutler_issue_attachment_download",
      { issue_key: "PROJ-1", attachment_id: 7 },
      {
        "GET /issues/PROJ-1/attachments/7": () =>
          new Response(bytes, {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": 'attachment; filename="big.bin"',
            },
          }),
      },
    );
    expect(run.isError, run.text.slice(0, 200)).toBe(false);
    expect(estimateTokens(run.text)).toBeGreaterThan(DEFAULT_MAX_RESPONSE_TOKENS);
  });

  it("書き込み(非冪等・冪等)は上限を超えてもエラーにしない: 成功を失敗に見せない", async () => {
    for (const tool of [writer, idempotentWriter]) {
      expect(Object.keys(tool.inputSchema.shape)).not.toContain("max_response_tokens");
      const res = await call(tool, { chars: 250000 }, new FakeKv());
      expect(res.isError, tool.name).toBe(false);
      expect(res.json.text).toHaveLength(250000);
    }
  });

  it("書き込みに max_response_tokens を渡しても効かない(超過でもそのまま返す)", async () => {
    const res = await call(writer, { chars: 400, max_response_tokens: 1 }, new FakeKv());
    expect(res.isError).toBe(false);
    expect(res.json.text).toHaveLength(400);
  });

  it("エラーエンベロープ(isError)は上限の対象にしない", async () => {
    // 引数エラーは大きさに関係なくそのまま返る(max_response_tokens: 1 でも argument_error のまま)
    const res = await call(reader, { chars: "x", max_response_tokens: 1 });
    expect(res.json.error.code).toBe("argument_error");
  });
});
