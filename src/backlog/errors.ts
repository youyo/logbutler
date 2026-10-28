import { type ErrorCode, LogbutlerError } from "../errors";

/** HTTP ステータス → エラー code(ADR 0004)。logvalet との差分: 429 は `rate_limited`。 */
export function errorCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found";
    case 422:
      return "argument_error";
    case 429:
      return "rate_limited";
    default:
      return "api_error";
  }
}

/** rate_limited と 5xx は再試行で直る可能性がある。status 0(通信失敗・タイムアウト)も同様。 */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

export interface BacklogApiErrorDetail {
  /** Backlog の `errors[0].code`。 */
  backlogCode?: number;
  /** Backlog の `errors[0].message`(アクセストークンは伏せ済み)。 */
  backlogMessage?: string;
  /** 通信失敗・タイムアウトなど、HTTP 応答がないときの説明。 */
  reason?: string;
}

/**
 * Backlog API のエラー。status 0 は「HTTP 応答を得られなかった」(通信失敗・タイムアウト)。
 * message には Authorization ヘッダーもアクセストークンも含めない。
 */
export class BacklogApiError extends LogbutlerError {
  readonly backlogCode?: number;
  readonly backlogMessage?: string;

  constructor(
    readonly status: number,
    detail: BacklogApiErrorDetail = {},
  ) {
    super(errorCodeForStatus(status), describe(status, detail), isRetryableStatus(status));
    this.backlogCode = detail.backlogCode;
    this.backlogMessage = detail.backlogMessage;
  }
}

function describe(status: number, d: BacklogApiErrorDetail): string {
  if (status === 0) return d.reason ?? "Backlog is unreachable.";
  const code = d.backlogCode === undefined ? "" : `, code=${d.backlogCode}`;
  const head = `Backlog API error (HTTP ${status}${code})`;
  return d.backlogMessage ? `${head}: ${d.backlogMessage}` : `${head}.`;
}

/** Backlog が 401 を返した。MCP の応答も HTTP 401 にしてクライアントにリフレッシュさせる合図。 */
export class BacklogUnauthorizedError extends BacklogApiError {
  constructor(detail: BacklogApiErrorDetail = {}) {
    super(401, detail);
  }
}

/** 1 回のツール呼び出しで許す Backlog API 呼び出し回数を超えた。 */
export class BacklogCallLimitError extends LogbutlerError {
  constructor(readonly limit: number) {
    super(
      "api_error",
      `Backlog API call limit (${limit} per tool call) exceeded. Narrow the request (smaller range, fewer items) and retry.`,
      false,
    );
  }
}

/** ダウンロードが上限を超えた。上限 + 1 バイトまで読んで判定する(全体をメモリに読まない)。 */
export class DownloadTooLargeError extends LogbutlerError {
  constructor(readonly maxBytes: number) {
    super(
      "api_error",
      `File is too large to download (limit ${Math.floor(maxBytes / (1024 * 1024))} MiB). Download it from Backlog directly.`,
      false,
    );
  }
}
