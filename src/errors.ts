import { BacklogApiError, BacklogUnauthorizedError } from "./backlog/client";

/** logvalet spec §9 のエラーエンベロープ(キーは snake_case)。 */
export interface ErrorEnvelope {
  schema_version: "1";
  error: { code: string; message: string; retryable: boolean };
}

export function errorEnvelope(code: string, message: string, retryable: boolean): ErrorEnvelope {
  return { schema_version: "1", error: { code, message, retryable } };
}

export function toErrorEnvelope(e: unknown): ErrorEnvelope {
  if (e instanceof BacklogUnauthorizedError) {
    return errorEnvelope(
      "backlog_unauthorized",
      "Backlog rejected the access token. Refresh the MCP token and retry.",
      true,
    );
  }
  if (e instanceof BacklogApiError) {
    const retryable = e.status === 0 || e.status === 429 || e.status >= 500;
    return errorEnvelope(
      "backlog_api_error",
      e.status === 0 ? "Backlog is unreachable." : `Backlog API returned ${e.status}.`,
      retryable,
    );
  }
  return errorEnvelope("internal_error", "Unexpected error.", false);
}
