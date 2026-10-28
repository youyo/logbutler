/**
 * 分析系ツールの共通出力(logvalet の `AnalysisEnvelope` / `DigestEnvelope` / `domain.Warning`)。
 * キーは snake_case(ADR 0004)。`generated_at` を含む時刻はすべて `ToolContext.now` から取る。
 */
import { BacklogApiError, BacklogUnauthorizedError } from "../backlog/errors";
import type { ToolContext } from "../mcp/registry";

export interface Warning {
  code: string;
  message: string;
  component?: string;
  retryable: boolean;
}

export interface LlmHints {
  primary_entities: string[];
  open_questions: string[];
  suggested_next_actions: string[];
}

export const llmHints = (
  primary_entities: string[] = [],
  open_questions: string[] = [],
  suggested_next_actions: string[] = [],
): LlmHints => ({ primary_entities, open_questions, suggested_next_actions });

export interface AnalysisEnvelope<T> {
  schema_version: "1";
  resource: string;
  generated_at: string;
  profile: string;
  space: string;
  base_url: string;
  warnings: Warning[];
  analysis: T;
}

/** Backlog スペースの Web の URL(`https://<host>`)。ホスト不明なら空文字(URL を組み立てない)。 */
export const baseUrlOf = (ctx: Pick<ToolContext, "spaceHost">): string =>
  ctx.spaceHost === "" ? "" : `https://${ctx.spaceHost}`;

/** 空でも warnings は `[]`。profile は Logbutler にはないので空文字(logvalet はキーを落とさない)。 */
export function analysisEnvelope<T>(
  ctx: Pick<ToolContext, "now" | "spaceHost">,
  resource: string,
  analysis: T,
  warnings: Warning[] = [],
): AnalysisEnvelope<T> {
  return {
    schema_version: "1",
    resource,
    generated_at: ctx.now().toISOString(),
    profile: "",
    space: ctx.spaceHost.split(".")[0] ?? "",
    base_url: baseUrlOf(ctx),
    warnings,
    analysis,
  };
}

/** logvalet の `DigestEnvelope`(M05B の digest 系)。`AnalysisEnvelope` と同じで、最後のキーだけ `digest`。 */
export interface DigestEnvelope<T> {
  schema_version: "1";
  resource: string;
  generated_at: string;
  profile: string;
  space: string;
  base_url: string;
  warnings: Warning[];
  digest: T;
}

export function digestEnvelope<T>(
  ctx: Pick<ToolContext, "now" | "spaceHost">,
  resource: string,
  digest: T,
  warnings: Warning[] = [],
): DigestEnvelope<T> {
  const { analysis: _omit, ...head } = analysisEnvelope(ctx, resource, null, warnings);
  return { ...head, digest };
}

/**
 * Backlog の失敗を warning にする(logvalet の「部分失敗は warning に留める」)。
 * 401 はトークン更新の合図なので、Backlog 以外の例外(バグ)や呼び出し回数の上限超過と同じく投げ直す。
 * retryable は logvalet が常に true だったが、404 などを再試行可能と言わないようエラーに従う。
 */
export function warningFromError(
  e: unknown,
  code: string,
  messagePrefix: string,
  component: string,
): Warning {
  if (e instanceof BacklogUnauthorizedError || !(e instanceof BacklogApiError)) throw e;
  return { code, message: `${messagePrefix}: ${e.message}`, component, retryable: e.retryable };
}
