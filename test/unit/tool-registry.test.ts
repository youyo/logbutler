import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BacklogApiError, BacklogUnauthorizedError } from "../../src/backlog/client";
import { ArgumentError } from "../../src/errors";
import {
  annotationsFor,
  defineTool,
  parseToolConfig,
  registerTools,
  selectTools,
  TOOLSETS,
  type ToolConfig,
} from "../../src/mcp/registry";
import { createMcpServer } from "../../src/mcp/server";
import { fakeClient, rpcTo } from "../helpers/mcp";
import { firstText } from "../helpers/oauth-flow";

const ALL: ToolConfig = { toolsets: "all", readOnly: false };

const sample = {
  read: defineTool({
    name: "logbutler_issue_get",
    title: "課題詳細取得",
    description: "Get an issue",
    category: "ReadOnly",
    toolset: "issue",
    inputSchema: z.object({ issue_key: z.string(), count: z.number().int().optional() }),
    handler: async (args, ctx) => ({
      got: args.issue_key,
      count: args.count ?? null,
      hasClient: !!ctx.client,
    }),
  }),
  create: defineTool({
    name: "logbutler_issue_create",
    title: "課題作成",
    description: "Create an issue",
    category: "WriteNonIdempotent",
    toolset: "issue",
    inputSchema: z.object({ summary: z.string() }),
    handler: async () => ({ ok: true }),
  }),
  update: defineTool({
    name: "logbutler_issue_update",
    title: "課題更新",
    description: "Update an issue",
    category: "WriteIdempotent",
    toolset: "issue",
    inputSchema: z.object({}),
    handler: async () => ({ ok: true }),
  }),
  del: defineTool({
    name: "logbutler_watching_delete",
    title: "ウォッチ削除",
    description: "Delete a watching",
    category: "Destructive",
    toolset: "watching",
    inputSchema: z.object({}),
    handler: async () => ({ ok: true }),
  }),
  user: defineTool({
    name: "logbutler_user_list",
    title: "ユーザー一覧取得",
    description: "List users",
    category: "ReadOnly",
    toolset: "user",
    inputSchema: z.object({}),
    handler: async () => [],
  }),
};
const TOOLS = Object.values(sample);

function server(
  tools = TOOLS,
  config = ALL,
  onUnauthorized = () => {},
  client = fakeClient(),
): McpServer {
  const s = new McpServer({ name: "test", version: "0" });
  registerTools(s, tools, config, {
    getClient: () => client,
    onBacklogUnauthorized: onUnauthorized,
  });
  return s;
}

describe("annotation ヘルパー(logvalet と同じ 4 種)", () => {
  it("ReadOnly: readOnly / idempotent / openWorld", () => {
    expect(annotationsFor("ReadOnly", "t")).toEqual({
      title: "t",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
  it("WriteIdempotent", () => {
    expect(annotationsFor("WriteIdempotent", "t")).toEqual({
      title: "t",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
  it("WriteNonIdempotent", () => {
    expect(annotationsFor("WriteNonIdempotent", "t")).toEqual({
      title: "t",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
  it("Destructive", () => {
    expect(annotationsFor("Destructive", "t")).toEqual({
      title: "t",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
});

describe("defineTool", () => {
  const base = {
    title: "t",
    description: "d",
    category: "ReadOnly",
    toolset: "issue",
    inputSchema: z.object({}),
    handler: async () => null,
  } as const;

  it("名前は logbutler_<resource>_<action> でなければならない", () => {
    expect(() => defineTool({ ...base, name: "logvalet_issue_get" })).toThrow(/logbutler_/);
    expect(() => defineTool({ ...base, name: "logbutler_issue" })).toThrow(/logbutler_/);
    expect(() => defineTool({ ...base, name: "logbutler_Issue_Get" })).toThrow(/logbutler_/);
    expect(() => defineTool({ ...base, name: "logbutler_shared_file_list" })).not.toThrow();
  });

  it("annotation の title は日本語を渡す想定で、そのまま載る", () => {
    expect(sample.read.annotations.title).toBe("課題詳細取得");
  });
});

describe("toolset と環境変数", () => {
  it("toolset の一覧は仕様どおり", () => {
    expect([...TOOLSETS]).toEqual([
      "issue",
      "project",
      "user",
      "activity",
      "document",
      "team",
      "space",
      "meta",
      "shared_file",
      "star",
      "watching",
      "wiki",
      "analysis",
      "digest",
      "search",
      "notification",
    ]);
  });

  it("既定(未設定)は all・書き込みあり", () => {
    expect(parseToolConfig({})).toEqual({ toolsets: "all", readOnly: false });
    expect(parseToolConfig({ LOGBUTLER_TOOLSETS: "all" })).toEqual({
      toolsets: "all",
      readOnly: false,
    });
    expect(parseToolConfig({ LOGBUTLER_TOOLSETS: "" })).toEqual({
      toolsets: "all",
      readOnly: false,
    });
  });

  it("LOGBUTLER_TOOLSETS はカンマ区切り(空白・大文字を許す)", () => {
    const c = parseToolConfig({ LOGBUTLER_TOOLSETS: " Issue, user ,shared_file" });
    expect(c.toolsets).toEqual(new Set(["issue", "user", "shared_file"]));
  });

  it("未知の toolset 名は設定ミスとして例外にする(黙って全部消さない)", () => {
    expect(() => parseToolConfig({ LOGBUTLER_TOOLSETS: "issue,isue" })).toThrow(/isue/);
  });

  it("LOGBUTLER_READ_ONLY=true で読み取り専用。false・空は無効。他の値は例外", () => {
    expect(parseToolConfig({ LOGBUTLER_READ_ONLY: "true" }).readOnly).toBe(true);
    expect(parseToolConfig({ LOGBUTLER_READ_ONLY: "TRUE" }).readOnly).toBe(true);
    expect(parseToolConfig({ LOGBUTLER_READ_ONLY: "false" }).readOnly).toBe(false);
    expect(parseToolConfig({ LOGBUTLER_READ_ONLY: "" }).readOnly).toBe(false);
    expect(() => parseToolConfig({ LOGBUTLER_READ_ONLY: "yes" })).toThrow(/LOGBUTLER_READ_ONLY/);
  });

  it("selectTools: toolset で絞る", () => {
    const names = selectTools(TOOLS, {
      toolsets: new Set(["user", "watching"]),
      readOnly: false,
    }).map((t) => t.name);
    expect(names).toEqual(["logbutler_watching_delete", "logbutler_user_list"]);
  });

  it("selectTools: readOnly なら ReadOnly 以外(書き込み・破壊的)を登録しない", () => {
    const names = selectTools(TOOLS, { toolsets: "all", readOnly: true }).map((t) => t.name);
    expect(names).toEqual(["logbutler_issue_get", "logbutler_user_list"]);
  });

  it("selectTools: toolset と readOnly の併用", () => {
    const names = selectTools(TOOLS, { toolsets: new Set(["issue"]), readOnly: true }).map(
      (t) => t.name,
    );
    expect(names).toEqual(["logbutler_issue_get"]);
  });

  it("tools/list は設定で選ばれたツールだけを返す", async () => {
    const { result } = await rpcTo(
      () => server(TOOLS, { toolsets: "all", readOnly: true }),
      "tools/list",
    );
    expect((result?.tools ?? []).map((t) => t.name).sort()).toEqual([
      "logbutler_issue_get",
      "logbutler_user_list",
    ]);
  });

  it("読み取り専用でも、登録されていない書き込みツールは呼べない", async () => {
    const res = await rpcTo(
      () => server(TOOLS, { toolsets: "all", readOnly: true }),
      "tools/call",
      { name: "logbutler_issue_create", arguments: { summary: "x" } },
    );
    expect(res.result?.isError === true || res.error !== undefined).toBe(true);
  });
});

describe("registerTools", () => {
  it("tools/list: 名前・説明・日本語 title の annotation・入力スキーマを公開する", async () => {
    const { result } = await rpcTo(() => server(), "tools/list");
    const get = (result?.tools ?? []).find((t) => t.name === "logbutler_issue_get") as unknown as {
      description: string;
      annotations: Record<string, unknown>;
      inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
    };
    expect(get.description).toBe("Get an issue");
    expect(get.annotations).toEqual({
      title: "課題詳細取得",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(get.inputSchema.type).toBe("object");
    expect(Object.keys(get.inputSchema.properties).sort()).toEqual(["count", "issue_key"]);
    expect(get.inputSchema.required).toEqual(["issue_key"]);
  });

  it("tools/call: 検証済みの引数と ctx を渡し、戻り値を JSON 文字列の text content にする(structuredContent なし)", async () => {
    const res = await rpcTo(() => server(), "tools/call", {
      name: "logbutler_issue_get",
      arguments: { issue_key: "PROJ-1" },
    });
    expect(res.result?.isError).toBeFalsy();
    expect(res.result?.content).toHaveLength(1);
    expect(res.result?.content?.[0]?.type).toBe("text");
    expect(JSON.parse(firstText(res))).toEqual({ got: "PROJ-1", count: null, hasClient: true });
    expect((res.result as Record<string, unknown>).structuredContent).toBeUndefined();
  });

  it("ハンドラが undefined を返したら null の JSON にする", async () => {
    const t = defineTool({
      name: "logbutler_star_add",
      title: "スター追加",
      description: "d",
      category: "WriteIdempotent",
      toolset: "star",
      inputSchema: z.object({}),
      handler: async () => undefined,
    });
    const res = await rpcTo(() => server([t]), "tools/call", {
      name: "logbutler_star_add",
      arguments: {},
    });
    expect(firstText(res)).toBe("null");
  });

  async function callError(thrown: unknown, onUnauthorized = () => {}) {
    const t = defineTool({
      name: "logbutler_issue_get",
      title: "課題詳細取得",
      description: "d",
      category: "ReadOnly",
      toolset: "issue",
      inputSchema: z.object({}),
      handler: async () => {
        throw thrown;
      },
    });
    const res = await rpcTo(() => server([t], ALL, onUnauthorized), "tools/call", {
      name: "logbutler_issue_get",
      arguments: {},
    });
    expect(res.result?.isError).toBe(true);
    return JSON.parse(firstText(res)) as {
      schema_version: string;
      error: { code: string; message: string; retryable: boolean };
    };
  }

  it("Backlog の 404 は not_found のエンベロープ(isError=true)", async () => {
    const body = await callError(
      new BacklogApiError(404, { backlogCode: 6, backlogMessage: "No such issue." }),
    );
    expect(body.schema_version).toBe("1");
    expect(body.error.code).toBe("not_found");
    expect(body.error.retryable).toBe(false);
    expect(body.error.message).toContain("No such issue.");
  });

  it("429 と 5xx だけ retryable=true", async () => {
    expect((await callError(new BacklogApiError(429))).error).toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
    expect((await callError(new BacklogApiError(502))).error).toMatchObject({
      code: "api_error",
      retryable: true,
    });
    expect((await callError(new BacklogApiError(403))).error).toMatchObject({
      code: "permission_error",
      retryable: false,
    });
    expect((await callError(new BacklogApiError(422))).error).toMatchObject({
      code: "argument_error",
      retryable: false,
    });
    expect((await callError(new BacklogApiError(400))).error).toMatchObject({
      code: "api_error",
      retryable: false,
    });
  });

  it("Backlog の 401 は authentication_error で返し、onBacklogUnauthorized を呼ぶ", async () => {
    let called = 0;
    const body = await callError(new BacklogUnauthorizedError(), () => {
      called++;
    });
    expect(called).toBe(1);
    expect(body.error.code).toBe("authentication_error");
    expect(body.error.retryable).toBe(false);
  });

  it("ArgumentError は argument_error", async () => {
    const body = await callError(new ArgumentError("since must be before until"));
    expect(body.error).toEqual({
      code: "argument_error",
      message: "since must be before until",
      retryable: false,
    });
  });

  it("想定外の例外は generic_error で、内部のメッセージを漏らさない", async () => {
    const body = await callError(new Error("secret internal detail at-1"));
    expect(body.error.code).toBe("generic_error");
    expect(body.error.message).not.toContain("secret");
    expect(body.error.retryable).toBe(false);
  });

  describe("想定外の例外のログ", () => {
    afterEach(() => vi.restoreAllMocks());

    const throwing = (thrown: unknown) =>
      defineTool({
        name: "logbutler_issue_get",
        title: "課題詳細取得",
        description: "d",
        category: "ReadOnly",
        toolset: "issue",
        inputSchema: z.object({}),
        handler: async () => {
          throw thrown;
        },
      });

    it("generic_error にするとき、例外名とトークンを伏せた message を console.error に残す(応答には出さない)", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = fakeClient({ redact: (t) => t.split("at-secret").join("[REDACTED]") });
      const res = await rpcTo(
        () =>
          createMcpServer({
            tools: [throwing(new TypeError("bad at-secret value"))],
            getClient: () => client,
            onBacklogUnauthorized: () => {},
          }),
        "tools/call",
        { name: "logbutler_issue_get", arguments: {} },
      );
      expect(JSON.parse(firstText(res)).error.code).toBe("generic_error");
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = spy.mock.calls.flat().join(" ");
      expect(logged).toContain("TypeError");
      expect(logged).toContain("logbutler_issue_get");
      expect(logged).toContain("bad [REDACTED] value");
      expect(logged).not.toContain("at-secret");
      expect(firstText(res)).not.toContain("bad");
    });

    it("Error でない値が投げられても落ちずに記録する", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await rpcTo(
        () =>
          createMcpServer({
            tools: [throwing("plain string at-secret")],
            getClient: () => fakeClient(),
            onBacklogUnauthorized: () => {},
          }),
        "tools/call",
        { name: "logbutler_issue_get", arguments: {} },
      );
      expect(JSON.parse(firstText(res)).error.code).toBe("generic_error");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("想定内のエラー(Backlog のエラーや引数エラー)は記録しない", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      await rpcTo(
        () =>
          createMcpServer({
            tools: [throwing(new BacklogApiError(404))],
            getClient: () => fakeClient(),
            onBacklogUnauthorized: () => {},
          }),
        "tools/call",
        { name: "logbutler_issue_get", arguments: {} },
      );
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("入力がスキーマに合わないときもエンベロープ(argument_error)の isError で返す", async () => {
    const res = await rpcTo(() => server(), "tools/call", {
      name: "logbutler_issue_get",
      arguments: { issue_key: 123 },
    });
    expect(res.error).toBeUndefined();
    expect(res.result?.isError).toBe(true);
    const body = JSON.parse(firstText(res));
    expect(body.schema_version).toBe("1");
    expect(body.error.code).toBe("argument_error");
    expect(body.error.retryable).toBe(false);
    expect(body.error.message).toContain("issue_key");
  });

  it("必須引数が欠けているときも argument_error", async () => {
    const res = await rpcTo(() => server(), "tools/call", {
      name: "logbutler_issue_get",
      arguments: {},
    });
    expect(res.result?.isError).toBe(true);
    expect(JSON.parse(firstText(res)).error.code).toBe("argument_error");
  });

  it("名前が重複していたら登録時に例外", () => {
    expect(() => server([sample.read, sample.read])).toThrow(/logbutler_issue_get/);
  });

  it("クライアントは tools/call ごとに getClient で作る(呼び出し間で回数上限などの状態を共有しない)", async () => {
    let made = 0;
    const s = () => {
      const m = new McpServer({ name: "t", version: "0" });
      registerTools(m, [sample.read], ALL, {
        getClient: () => {
          made++;
          return fakeClient();
        },
        onBacklogUnauthorized: () => {},
      });
      return m;
    };
    await rpcTo(s, "tools/call", { name: "logbutler_issue_get", arguments: { issue_key: "A" } });
    expect(made).toBe(1);
    await rpcTo(s, "tools/list");
    expect(made).toBe(1);
  });
});
