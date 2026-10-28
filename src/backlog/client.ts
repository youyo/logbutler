/**
 * Backlog API クライアント(ADR 0003)。
 *
 * - 認証は OAuth の `Authorization: Bearer`。GET はクエリ、POST/PATCH/PUT/DELETE は form 本文。
 * - HTTP リクエストはクライアントごとに直列(同時に 1 本)。Backlog の「1 ユーザーのリクエストは直列に」に従う。
 * - 429 は Retry-After に従って最大 2 回まで再試行する。
 * - 1 クライアント(= 1 回のツール呼び出し)あたりの呼び出し回数に上限がある。
 * - 自動ページングは持たない(`paging.ts` を呼び出し側が使う)。
 */
import {
  BacklogApiError,
  type BacklogApiErrorDetail,
  BacklogCallLimitError,
  BacklogUnauthorizedError,
} from "./errors";
import type { BacklogErrorBody, BacklogUser } from "./types";

export { BacklogApiError, BacklogCallLimitError, BacklogUnauthorizedError };

/** 1 リクエストのタイムアウト。Workers の実時間制限と MCP クライアントの待ち時間を考えた値。 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 429 のリトライ回数の上限。 */
export const DEFAULT_MAX_RETRIES = 2;
/** これを超える Retry-After はリトライせずにエラーにする(MCP クライアントを待たせすぎない)。 */
export const DEFAULT_MAX_RETRY_WAIT_SECONDS = 10;
/** Retry-After がない・読めないときの待ち時間。 */
const FALLBACK_RETRY_WAIT_SECONDS = 1;
/** 1 回のツール呼び出しで許す HTTP リクエスト数(リトライ含む)。Workers 無料プランの subrequest 上限と同じ。 */
export const DEFAULT_MAX_API_CALLS = 50;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ParamValue = string | number | boolean | null | undefined;
/** 値が配列なら `key[]=v` の繰り返しで送る。undefined と null は送らない。 */
export type Params = Record<string, ParamValue | readonly ParamValue[]>;

export interface RequestOptions {
  query?: Params;
  form?: Params;
}

export interface BacklogClient {
  /** 低レベルのリクエスト。応答本文が空なら undefined。 */
  request<T = unknown>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;
  getMyself(): Promise<BacklogUser>;
}

export interface BacklogClientOptions {
  spaceHost: string;
  accessToken: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryWaitSeconds?: number;
  maxApiCalls?: number;
  /** 待機の差し替え口(テスト用)。既定は setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function appendParams(target: URLSearchParams, params: Params | undefined): void {
  if (!params) return;
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value)
        if (v !== undefined && v !== null) target.append(`${key}[]`, String(v));
    } else if (value !== undefined && value !== null) {
      target.append(key, String(value));
    }
  }
}

/** Retry-After(秒)を読む。読めなければ undefined。 */
function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim());
}

export function createBacklogClient(opts: BacklogClientOptions): BacklogClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxRetryWaitSeconds = opts.maxRetryWaitSeconds ?? DEFAULT_MAX_RETRY_WAIT_SECONDS;
  const maxApiCalls = opts.maxApiCalls ?? DEFAULT_MAX_API_CALLS;
  const sleep = opts.sleep ?? defaultSleep;
  const baseUrl = `https://${opts.spaceHost}/api/v2`;

  let apiCalls = 0;
  // 直列化: 前のリクエスト(リトライの待機を含む)が終わるまで次を始めない。失敗しても後続は続ける。
  let tail: Promise<unknown> = Promise.resolve();

  /** Backlog の本文や例外に紛れたアクセストークンを伏せる。 */
  const redact = (text: string): string =>
    opts.accessToken ? text.split(opts.accessToken).join("[REDACTED]") : text;

  async function sendOnce(
    method: HttpMethod,
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    if (apiCalls >= maxApiCalls) throw new BacklogCallLimitError(maxApiCalls);
    apiCalls++;

    const url = new URL(`${baseUrl}${path}`);
    appendParams(url.searchParams, options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.accessToken}`,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (options.form) {
      const form = new URLSearchParams();
      appendParams(form, options.form);
      body = form.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await fetch(url.toString(), { method, headers, body, signal: controller.signal });
    } catch {
      // 例外の文面にトークンやヘッダーが混ざらないよう、原因は捨てて固定文にする。
      throw new BacklogApiError(0, {
        reason: timedOut
          ? `Backlog request timed out after ${timeoutMs}ms.`
          : "Backlog is unreachable.",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function errorFrom(res: Response): Promise<BacklogApiError> {
    const detail: BacklogApiErrorDetail = {};
    try {
      const parsed = (await res.json()) as BacklogErrorBody;
      const first = parsed?.errors?.[0];
      if (first) {
        if (typeof first.code === "number") detail.backlogCode = first.code;
        if (typeof first.message === "string") detail.backlogMessage = redact(first.message);
      }
    } catch {
      // JSON でない本文は無視して status だけで変換する。
    }
    return res.status === 401
      ? new BacklogUnauthorizedError(detail)
      : new BacklogApiError(res.status, detail);
  }

  async function execute<T>(method: HttpMethod, path: string, options: RequestOptions): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await sendOnce(method, path, options);
      if (res.ok) {
        const text = await res.text();
        return (text === "" ? undefined : JSON.parse(text)) as T;
      }
      const err = await errorFrom(res);
      if (res.status !== 429 || attempt >= maxRetries) throw err;
      const waitSeconds =
        parseRetryAfterSeconds(res.headers.get("Retry-After")) ?? FALLBACK_RETRY_WAIT_SECONDS;
      if (waitSeconds > maxRetryWaitSeconds) throw err;
      await sleep(waitSeconds * 1000);
    }
  }

  function request<T = unknown>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const run = tail.then(() => execute<T>(method, path, options));
    tail = run.catch(() => undefined);
    return run;
  }

  return {
    request,
    getMyself: () => request<BacklogUser>("GET", "/users/myself"),
  };
}
