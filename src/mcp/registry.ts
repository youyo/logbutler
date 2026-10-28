/**
 * ツール登録の仕組み(ADR 0004)。1 ツール = 名前・説明・入力スキーマ(zod)・カテゴリ・toolset・ハンドラ。
 * M03 以降のツールは `defineTool` で定義し、`tools/index.ts` に足すだけで載る。
 */
import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { type BacklogClient, BacklogUnauthorizedError } from "../backlog/client";
import { ArgumentError, ConfigError, LogbutlerError, toErrorEnvelope } from "../errors";
import {
  explicitKeyFrom,
  type IdempotencyDeps,
  idempotencyCacheKey,
  withIdempotency,
} from "./idempotency";

/** logvalet の 4 区分(`internal/mcp/tool_categories.go`)。 */
export type ToolCategory = "ReadOnly" | "WriteIdempotent" | "WriteNonIdempotent" | "Destructive";

/** リソース単位のグループ。`LOGBUTLER_TOOLSETS` で有効にするものを選ぶ。 */
export const TOOLSETS = [
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
] as const;
export type Toolset = (typeof TOOLSETS)[number];

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** logvalet の annotations.go と同じ値。title は日本語。 */
export function annotationsFor(category: ToolCategory, title: string): ToolAnnotations {
  switch (category) {
    case "ReadOnly":
      return { title, readOnlyHint: true, idempotentHint: true, openWorldHint: true };
    case "WriteIdempotent":
      return {
        title,
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      };
    case "WriteNonIdempotent":
      return {
        title,
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      };
    case "Destructive":
      return {
        title,
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      };
  }
}

/** 「今日」の基準タイムゾーンの既定値。Workers は UTC で動くため、利用者の暮らす時刻に合わせる。 */
export const DEFAULT_TIMEZONE = "Asia/Tokyo";

export interface ToolContext {
  /** このツール呼び出し専用の Backlog クライアント(直列化・呼び出し回数上限はこの単位)。 */
  client: BacklogClient;
  /** 現在時刻(テストで差し替える)。ツールは `Date.now()` を直接呼ばない。 */
  now: () => Date;
  /** 「今日」「今週」の基準になる IANA タイムゾーン(`LOGBUTLER_TIMEZONE`。既定 Asia/Tokyo)。 */
  timezone: string;
}

export interface ToolDefinitionInput<S extends z.ZodObject> {
  /** `logbutler_<resource>_<action>` */
  name: string;
  /** annotation の title(日本語)。 */
  title: string;
  description: string;
  category: ToolCategory;
  toolset: Toolset;
  inputSchema: S;
  /** 戻り値は JSON にして text content に入れる。構造化出力(structuredContent)は使わない。 */
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly toolset: Toolset;
  readonly inputSchema: z.ZodObject;
  readonly annotations: ToolAnnotations;
  /** 引数は SDK が inputSchema で検証済みのものだけが来る。 */
  readonly handler: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

const TOOL_NAME = /^logbutler_[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

export function defineTool<S extends z.ZodObject>(input: ToolDefinitionInput<S>): ToolDefinition {
  if (!TOOL_NAME.test(input.name)) {
    throw new Error(`ツール名は logbutler_<resource>_<action> の形式にする: ${input.name}`);
  }
  return {
    name: input.name,
    description: input.description,
    category: input.category,
    toolset: input.toolset,
    inputSchema: input.inputSchema,
    annotations: annotationsFor(input.category, input.title),
    handler: (args, ctx) => input.handler(args as z.infer<S>, ctx),
  };
}

export interface ToolConfig {
  /** 有効にする toolset。"all" ですべて。 */
  toolsets: "all" | ReadonlySet<Toolset>;
  /** true なら書き込み・破壊的ツールを登録しない。 */
  readOnly: boolean;
}

export interface ToolConfigEnv {
  LOGBUTLER_TOOLSETS?: string;
  LOGBUTLER_READ_ONLY?: string;
}

/**
 * 環境変数からツール設定を作る。未知の toolset 名や読めない真偽値は ConfigError にする
 * (typo で黙って全ツールが消えたり、読み取り専用のつもりで書き込めたりしないため)。
 */
export function parseToolConfig(env: ToolConfigEnv): ToolConfig {
  const raw = (env.LOGBUTLER_TOOLSETS ?? "").trim().toLowerCase();
  let toolsets: ToolConfig["toolsets"] = "all";
  if (raw !== "" && raw !== "all") {
    const names = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const known = new Set<string>(TOOLSETS);
    const unknown = names.filter((n) => !known.has(n));
    if (unknown.length > 0) {
      throw new ConfigError(
        `LOGBUTLER_TOOLSETS に未知の toolset がある: ${unknown.join(", ")}(有効: all, ${TOOLSETS.join(", ")})`,
      );
    }
    toolsets = new Set(names as Toolset[]);
  }

  const ro = (env.LOGBUTLER_READ_ONLY ?? "").trim().toLowerCase();
  if (ro !== "" && ro !== "true" && ro !== "false") {
    throw new ConfigError(`LOGBUTLER_READ_ONLY は true か false: ${env.LOGBUTLER_READ_ONLY}`);
  }
  return { toolsets, readOnly: ro === "true" };
}

export function selectTools(
  tools: readonly ToolDefinition[],
  config: ToolConfig,
): ToolDefinition[] {
  return tools.filter(
    (t) =>
      (config.toolsets === "all" || config.toolsets.has(t.toolset)) &&
      !(config.readOnly && t.category !== "ReadOnly"),
  );
}

export interface RegisterDeps {
  /** tools/call ごとに呼ぶ。1 回のツール呼び出しにつき 1 クライアント。 */
  getClient: () => BacklogClient;
  /** Backlog が 401 を返したとき(MCP の応答も HTTP 401 にするための合図)。 */
  onBacklogUnauthorized: () => void;
  /** 現在時刻。省略時は `new Date()`。 */
  now?: () => Date;
  /** 「今日」の基準タイムゾーン。省略時は DEFAULT_TIMEZONE。 */
  timezone?: string;
  /** WriteNonIdempotent ツールの冪等キャッシュ(KV とユーザー ID)。省略時はキャッシュしない。 */
  idempotency?: IdempotencyDeps;
}

function textResult(text: string, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text" as const, text }] };
}

/** zod の検証エラーを、どの引数が悪いか分かる 1 行にする。 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(input)"}: ${i.message}`)
    .join("; ");
}

/**
 * SDK には「公開用のスキーマ」だけを渡し、検証は自前で行う。SDK の検証エラーはプレーンテキストの
 * isError になり、spec §9 のエンベロープにならないため。JSON Schema は zod のものをそのまま使う。
 */
function advertiseOnly(schema: z.ZodObject): StandardSchemaWithJSON {
  const standard = schema["~standard"];
  return {
    "~standard": { ...standard, validate: (value: unknown) => ({ value }) },
  } as unknown as StandardSchemaWithJSON;
}

/**
 * 想定外の例外(generic_error にするもの)を調べられるよう、例外名と message をログに残す。
 * 応答には出さない。message にはトークンが混ざりうるので、クライアントが知るトークンと Bearer を伏せる。
 */
function logUnexpected(toolName: string, e: unknown, client: BacklogClient | undefined): void {
  const name = e instanceof Error ? e.name : typeof e;
  const raw = e instanceof Error ? e.message : String(e);
  const redacted = (client ? client.redact(raw) : raw).replace(
    /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
    "Bearer [REDACTED]",
  );
  console.error(`tool ${toolName} failed unexpectedly: ${name}: ${redacted}`);
}

export function registerTools(
  server: McpServer,
  tools: readonly ToolDefinition[],
  config: ToolConfig,
  deps: RegisterDeps,
): void {
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`ツール名が重複している: ${t.name}`);
    seen.add(t.name);
  }

  for (const tool of selectTools(tools, config)) {
    server.registerTool(
      tool.name,
      {
        title: tool.annotations.title,
        description: tool.description,
        inputSchema: advertiseOnly(tool.inputSchema),
        annotations: tool.annotations,
      },
      async (args: unknown, mcpCtx) => {
        let client: BacklogClient | undefined;
        try {
          const parsed = tool.inputSchema.safeParse(args ?? {});
          if (!parsed.success) throw new ArgumentError(describeIssues(parsed.error));
          client = deps.getClient();
          const toolCtx: ToolContext = {
            client,
            now: deps.now ?? (() => new Date()),
            timezone: deps.timezone || DEFAULT_TIMEZONE,
          };
          if (tool.category === "WriteNonIdempotent" && deps.idempotency) {
            // 明示キーは inputSchema に宣言しないので、zod の検証前の生の引数と params._meta から取る。
            const explicit = explicitKeyFrom(mcpCtx?.mcpReq?._meta, args);
            const key = await idempotencyCacheKey(
              deps.idempotency.userId,
              tool.name,
              explicit,
              parsed.data,
            );
            return textResult(
              await withIdempotency(deps.idempotency, key, () =>
                tool.handler(parsed.data, toolCtx),
              ),
            );
          }
          const result = await tool.handler(parsed.data, toolCtx);
          return textResult(JSON.stringify(result ?? null));
        } catch (e) {
          if (e instanceof BacklogUnauthorizedError) deps.onBacklogUnauthorized();
          if (!(e instanceof LogbutlerError)) logUnexpected(tool.name, e, client);
          return textResult(JSON.stringify(toErrorEnvelope(e)), true);
        }
      },
    );
  }
}
