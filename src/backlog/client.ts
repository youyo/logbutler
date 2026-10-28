/**
 * Backlog API クライアント(ADR 0003)。
 *
 * - 認証は OAuth の `Authorization: Bearer`。GET はクエリ、POST/PATCH/PUT/DELETE は form 本文。
 * - HTTP リクエストはクライアントごとに直列(同時に 1 本)。Backlog の「1 ユーザーのリクエストは直列に」に従う。
 * - 429 は Retry-After に従って最大 2 回まで再試行する。
 * - 1 クライアント(= 1 回のツール呼び出し)あたりの呼び出し回数に上限がある。
 * - 自動ページングは持たない(`paging.ts` を呼び出し側が使う)。
 */

import { LogbutlerError } from "../errors";
import {
  BacklogApiError,
  type BacklogApiErrorDetail,
  BacklogCallLimitError,
  BacklogUnauthorizedError,
  DownloadTooLargeError,
} from "./errors";
import type { BacklogErrorBody, BacklogUser } from "./types";

export { BacklogApiError, BacklogCallLimitError, BacklogUnauthorizedError, DownloadTooLargeError };

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

export interface DownloadedFile {
  data: Uint8Array;
  filename: string;
  contentType: string;
}

export interface BacklogClient {
  /** 低レベルのリクエスト。応答本文が空なら undefined。 */
  request<T = unknown>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;
  /**
   * GET でファイルを取得する。上限 + 1 バイトまで読んで判定し、超えたら DownloadTooLargeError
   * (本文を全部読んでから判定しない)。タイムアウトと直列化・呼び出し回数上限は request と同じ。
   */
  download(path: string, options: { maxBytes: number; query?: Params }): Promise<DownloadedFile>;
  getMyself(): Promise<BacklogUser>;
  /** 文字列に紛れたアクセストークンを伏せる(ログ用)。 */
  redact(text: string): string;
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

const abortError = () => new DOMException("aborted", "AbortError");

/** 本文を読む。signal が中断されたら即座に失敗し、ストリームを cancel する。maxBytes を超えたら DownloadTooLargeError。 */
async function readBody(
  res: Response,
  signal: AbortSignal,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(abortError());
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      // 上限 + 1 バイトまで読んだ時点で判定する。
      if (total > maxBytes) throw new DownloadTooLargeError(maxBytes);
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Content-Disposition(RFC 6266 / 5987)からファイル名を取る。なければパスの末尾。 */
function filenameFrom(header: string | null, path: string): string {
  if (header) {
    const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
    if (star?.[2]) {
      try {
        return decodeURIComponent(star[2].trim());
      } catch {
        // 壊れた符号化は次の候補へ。
      }
    }
    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
    const name = plain?.[1]?.replace(/\\(.)/g, "$1") ?? plain?.[2]?.trim();
    if (name) return name;
  }
  return decodeURIComponent(path.split("?")[0]?.split("/").filter(Boolean).pop() ?? "");
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

  /** 本文を読み終えるまで同じ期限(timeoutMs)で守る。応答ヘッダーが来てから本文が止まるケースを防ぐ。 */
  async function attempt<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions,
    accept: string,
    read: (res: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: BacklogApiError; res: Response }> {
    if (apiCalls >= maxApiCalls) throw new BacklogCallLimitError(maxApiCalls);
    apiCalls++;

    const url = new URL(`${baseUrl}${path}`);
    appendParams(url.searchParams, options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.accessToken}`,
      Accept: accept,
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
    // 例外の文面にトークンやヘッダーが混ざらないよう、通信の原因は捨てて固定文にする。
    const transportError = () =>
      new BacklogApiError(0, {
        reason: timedOut
          ? `Backlog request timed out after ${timeoutMs}ms.`
          : "Backlog is unreachable.",
      });
    try {
      let res: Response;
      try {
        res = await fetch(url.toString(), {
          method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch {
        throw transportError();
      }
      if (!res.ok) return { ok: false, error: await errorFrom(res, controller.signal), res };
      try {
        return { ok: true, value: await read(res, controller.signal) };
      } catch (e) {
        if (e instanceof LogbutlerError) throw e;
        throw transportError();
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function errorFrom(res: Response, signal: AbortSignal): Promise<BacklogApiError> {
    const detail: BacklogApiErrorDetail = {};
    try {
      const text = new TextDecoder().decode(await readBody(res, signal));
      const parsed = JSON.parse(text) as BacklogErrorBody;
      const first = parsed?.errors?.[0];
      if (first) {
        if (typeof first.code === "number") detail.backlogCode = first.code;
        if (typeof first.message === "string") detail.backlogMessage = redact(first.message);
      }
    } catch {
      // JSON でない本文・読み取りの失敗(期限切れを含む)は無視して status だけで変換する。
    }
    return res.status === 401
      ? new BacklogUnauthorizedError(detail)
      : new BacklogApiError(res.status, detail);
  }

  async function execute<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions,
    accept: string,
    read: (res: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    for (let n = 0; ; n++) {
      const r = await attempt(method, path, options, accept, read);
      if (r.ok) return r.value;
      if (r.res.status !== 429 || n >= maxRetries) throw r.error;
      const waitSeconds =
        parseRetryAfterSeconds(r.res.headers.get("Retry-After")) ?? FALLBACK_RETRY_WAIT_SECONDS;
      if (waitSeconds > maxRetryWaitSeconds) throw r.error;
      await sleep(waitSeconds * 1000);
    }
  }

  /** 前のリクエスト(リトライの待機を含む)が終わるまで次を始めない。失敗しても後続は続ける。 */
  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const p = tail.then(run);
    tail = p.catch(() => undefined);
    return p;
  }

  function request<T = unknown>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    return serialize(() =>
      execute<T>(method, path, options, "application/json", async (res, signal) => {
        const text = new TextDecoder().decode(await readBody(res, signal));
        return (text === "" ? undefined : JSON.parse(text)) as T;
      }),
    );
  }

  function download(
    path: string,
    o: { maxBytes: number; query?: Params },
  ): Promise<DownloadedFile> {
    return serialize(() =>
      execute("GET", path, { query: o.query }, "*/*", async (res, signal) => {
        const declared = Number(res.headers.get("Content-Length"));
        if (Number.isFinite(declared) && declared > o.maxBytes) {
          await res.body?.cancel().catch(() => undefined);
          throw new DownloadTooLargeError(o.maxBytes);
        }
        const data = await readBody(res, signal, o.maxBytes);
        return {
          data,
          filename: filenameFrom(res.headers.get("Content-Disposition"), path),
          contentType: res.headers.get("Content-Type") ?? "",
        };
      }),
    );
  }

  return {
    request,
    download,
    getMyself: () => request<BacklogUser>("GET", "/users/myself"),
    redact,
  };
}
