/**
 * ツール登録の仕組み(ADR 0004)。1 ツール = 名前・説明・入力スキーマ(zod)・カテゴリ・toolset・ハンドラ。
 * M03 以降のツールは `defineTool` で定義し、`tools/index.ts` に足すだけで載る。
 */
import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { type BacklogClient, BacklogUnauthorizedError } from "../backlog/client";
import { ArgumentError, LogbutlerError, QueryError, toErrorEnvelope } from "../errors";
import { assertTimezone } from "./args";
import {
  explicitKeyFrom,
  type IdempotencyDeps,
  idempotencyCacheKey,
  withIdempotency,
} from "./idempotency";
import {
  assertWithinResponseLimit,
  maxResponseTokensShape,
  resolveResponseLimit,
} from "./response-limit";

/** logvalet の 4 区分(`internal/mcp/tool_categories.go`)。 */
export type ToolCategory = "ReadOnly" | "WriteIdempotent" | "WriteNonIdempotent" | "Destructive";

/** リソース単位のグループ。/mcp の URL クエリ `?toolsets=` で有効にするものを選ぶ。 */
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
  /** 「今日」「今週」の基準になる IANA タイムゾーン。ツール引数 `timezone` があればそれ、なければ既定(Asia/Tokyo)。 */
  timezone: string;
  /** Backlog スペースのホスト(例 `example.backlog.com`)。分析系の出力の `space` / `base_url` の材料。 */
  spaceHost: string;
}

export interface ToolDefinitionInput<S extends z.ZodObject> {
  /** `logbutler_<resource>_<action>` */
  name: string;
  /** annotation の title(日本語)。 */
  title: string;
  description: string;
  category: ToolCategory;
  /**
   * 注釈の idempotentHint をカテゴリの既定から上書きする。冪等キャッシュ(WriteNonIdempotent)は付けずに、
   * 注釈だけを実態に合わせたいとき用(例: star_add は同じ対象に 2 回付けるとスターが 2 個になる)。
   */
  idempotentHint?: boolean;
  toolset: Toolset;
  inputSchema: S;
  /**
   * このツール 1 回の呼び出しで許す Backlog API の回数(リトライ含む)。省略時はクライアントの既定(50)。
   * ページングや課題ごとの取得で膨らむツールは、最悪ケースの式から決めて明示する(ADR 0006)。
   */
  maxApiCalls?: number;
  /**
   * 応答サイズの上限(引数 max_response_tokens)を付けるか。読み取り(ReadOnly)ツールは既定で付け、
   * ダウンロード系は false にする。書き込み系には付けない(成功を失敗に見せないため。ADR 0007)。
   */
  responseLimit?: boolean;
  /** 戻り値は JSON にして text content に入れる。構造化出力(structuredContent)は使わない。 */
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly toolset: Toolset;
  readonly inputSchema: z.ZodObject;
  readonly maxApiCalls?: number;
  /** 応答サイズの上限(max_response_tokens)を適用するか。 */
  readonly responseLimit: boolean;
  readonly annotations: ToolAnnotations;
  /** 引数は SDK が inputSchema で検証済みのものだけが来る。 */
  readonly handler: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

/** `logbutler_<resource>_<action>`。例外は logvalet の baseline にある `logbutler_search`(action なし)だけ。 */
const TOOL_NAME = /^logbutler_(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|search)$/;

export function defineTool<S extends z.ZodObject>(input: ToolDefinitionInput<S>): ToolDefinition {
  if (!TOOL_NAME.test(input.name)) {
    throw new Error(`ツール名は logbutler_<resource>_<action> の形式にする: ${input.name}`);
  }
  const responseLimit = input.category === "ReadOnly" && input.responseLimit !== false;
  return {
    name: input.name,
    description: input.description,
    category: input.category,
    toolset: input.toolset,
    inputSchema: responseLimit
      ? input.inputSchema.extend(maxResponseTokensShape)
      : input.inputSchema,
    responseLimit,
    ...(input.maxApiCalls === undefined ? {} : { maxApiCalls: input.maxApiCalls }),
    annotations: {
      ...annotationsFor(input.category, input.title),
      ...(input.idempotentHint === undefined ? {} : { idempotentHint: input.idempotentHint }),
    },
    handler: (args, ctx) => input.handler(args as z.infer<S>, ctx),
  };
}

export interface ToolConfig {
  /** 有効にする toolset。"all" ですべて。 */
  toolsets: "all" | ReadonlySet<Toolset>;
  /** true なら書き込み・破壊的ツールを登録しない。 */
  readOnly: boolean;
}

const CONFIG_KEYS = ["read_only", "toolsets"] as const;
/** 小文字にして `_` と `-` を除く(`readOnly` `READ_ONLY` `read-only` を同じ綴りとして扱う)。 */
const squash = (key: string) => key.toLowerCase().replace(/[_\-\s]/g, "");
/** 設定キーの綴り違いとみなす接頭辞(`toolset` `tools` `readonlly` `readOnlyMode` など)。 */
const CONFIG_KEY_PREFIXES = ["read", "tool"] as const;

/**
 * `readonly` `readOnly` `read-only` `tool_sets` `toolset` `readonlly` のように、squash 後に
 * `read` か `tool` で始まる未知のキーは QueryError にする。無視すると、読み取り専用のつもりで
 * 書き込み可能なまま接続してしまう。それ以外の未知のキー(Portal の `optimize_context` など)は
 * 従来どおり無視する。`ro` `mode` のような短い別名は対象外(ADR 0008)。
 */
function rejectMisspelledKeys(params: URLSearchParams): void {
  for (const key of new Set(params.keys())) {
    if ((CONFIG_KEYS as readonly string[]).includes(key)) continue;
    const squashed = squash(key);
    if (CONFIG_KEY_PREFIXES.some((p) => squashed.startsWith(p))) {
      const intended = CONFIG_KEYS.find((k) => squash(k) === squashed);
      throw new QueryError(
        intended
          ? `クエリのキー "${key}" は綴り違い。正しいキーは "${intended}"`
          : `クエリのキー "${key}" は綴り違いの疑い。正しいキーは "read_only" と "toolsets"`,
      );
    }
  }
}

/**
 * /mcp の URL クエリからツール設定を作る(`?toolsets=issue,wiki&read_only=true`)。
 * 公開するツールは tools/list の時点で決まるため、ツール引数ではなく接続 URL で決める(ADR 0008)。
 * 未知の toolset 名や読めない真偽値は QueryError にする(typo で黙って全ツールが消えたり、
 * 読み取り専用のつもりで書き込めたりしないため)。`read_only` / `toolsets` のまぎらわしい綴り違いも QueryError。
 * それ以外の関係のないクエリは無視する。
 */
export function parseToolConfig(params: URLSearchParams): ToolConfig {
  rejectMisspelledKeys(params);
  const names = params
    .getAll("toolsets")
    .flatMap((v) => v.split(","))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  let toolsets: ToolConfig["toolsets"] = "all";
  if (names.length > 0 && !names.includes("all")) {
    const known = new Set<string>(TOOLSETS);
    const unknown = names.filter((n) => !known.has(n));
    if (unknown.length > 0) {
      throw new QueryError(
        `toolsets に未知の toolset がある: ${unknown.join(", ")}(有効: all, ${TOOLSETS.join(", ")})`,
      );
    }
    toolsets = new Set(names as Toolset[]);
  }

  const readOnlyValues = params.getAll("read_only");
  if (readOnlyValues.length > 1) {
    throw new QueryError("read_only は 1 回だけ指定できる(true か false)");
  }
  const ro = (readOnlyValues[0] ?? "").trim().toLowerCase();
  if (ro !== "" && ro !== "true" && ro !== "false") {
    throw new QueryError(`read_only は true か false: ${readOnlyValues[0]}`);
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
  /**
   * tools/call ごとに呼ぶ。1 回のツール呼び出しにつき 1 クライアント。
   * ツールが `maxApiCalls` を宣言していれば渡す(宣言がなければ空のオブジェクト)。
   */
  getClient: (options: { maxApiCalls?: number }) => BacklogClient;
  /** Backlog スペースのホスト。省略時は空文字。 */
  spaceHost?: string;
  /** Backlog が 401 を返したとき(MCP の応答も HTTP 401 にするための合図)。 */
  onBacklogUnauthorized: () => void;
  /** 現在時刻。省略時は `new Date()`。 */
  now?: () => Date;
  /** 「今日」の基準タイムゾーンの既定(ツール引数 `timezone` が優先)。省略時は DEFAULT_TIMEZONE。 */
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
          client = deps.getClient(
            tool.maxApiCalls === undefined ? {} : { maxApiCalls: tool.maxApiCalls },
          );
          // 引数 timezone があればそれを使う(不正な名前はクライアント由来なので argument_error)。
          const tzArg = (parsed.data as { timezone?: unknown }).timezone;
          const toolCtx: ToolContext = {
            client,
            spaceHost: deps.spaceHost ?? "",
            now: deps.now ?? (() => new Date()),
            timezone:
              typeof tzArg === "string" ? assertTimezone(tzArg) : deps.timezone || DEFAULT_TIMEZONE,
          };
          // 上限の引数は Backlog を呼ぶ前に検証する(負の値で API を無駄に叩かない)。
          const responseLimit = tool.responseLimit
            ? resolveResponseLimit(
                (parsed.data as { max_response_tokens?: number }).max_response_tokens,
              )
            : undefined;
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
          const text = JSON.stringify(result ?? null);
          if (responseLimit !== undefined) assertWithinResponseLimit(text, responseLimit);
          return textResult(text);
        } catch (e) {
          if (e instanceof BacklogUnauthorizedError) deps.onBacklogUnauthorized();
          if (!(e instanceof LogbutlerError)) logUnexpected(tool.name, e, client);
          return textResult(JSON.stringify(toErrorEnvelope(e)), true);
        }
      },
    );
  }
}
