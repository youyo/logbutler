/**
 * ツールのエラー。logvalet の spec §9 エンベロープ
 * `{"schema_version":"1","error":{"code","message","retryable"}}` に変換する(ADR 0004)。
 */

/** logvalet の列挙(argument/authentication/permission/not_found/api/generic)+ `rate_limited`。 */
export const ERROR_CODES = [
  "argument_error",
  "authentication_error",
  "permission_error",
  "not_found",
  "api_error",
  "rate_limited",
  "generic_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** ツールの応答に載せてよいエラー。message は利用者(AI)にそのまま見える。トークンを含めないこと。 */
export class LogbutlerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 入力が不正(スキーマでは表せない検証。例: 期間の前後逆転)。 */
export class ArgumentError extends LogbutlerError {
  constructor(message: string) {
    super("argument_error", message, false);
  }
}

/** デプロイ設定の誤り(未知の toolset 名など)。リクエストではなく運用者が直すもの。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ErrorEnvelope {
  schema_version: "1";
  error: { code: ErrorCode; message: string; retryable: boolean };
}

export function errorEnvelope(code: ErrorCode, message: string, retryable: boolean): ErrorEnvelope {
  return { schema_version: "1", error: { code, message, retryable } };
}

export function toErrorEnvelope(e: unknown): ErrorEnvelope {
  if (e instanceof LogbutlerError) return errorEnvelope(e.code, e.message, e.retryable);
  // 想定外の例外は内部情報を漏らさない。
  return errorEnvelope("generic_error", "Unexpected error.", false);
}
