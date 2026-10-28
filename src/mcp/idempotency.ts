/**
 * 冪等キャッシュ(ADR 0005)。WriteNonIdempotent のツール(create 系)の重複実行を防ぐ。
 *
 * MCP クライアントは接続断のあとに同じ呼び出しを再送しうる。同じキーの呼び出しは、成功した最初の
 * 結果を 5 分間 KV に置き、2 回目以降はそれを返す。best-effort: KV は結果整合で排他制御もないので、
 * ほぼ同時の 2 回の呼び出しは両方実行されうる(Durable Objects を使わない方針のため受け入れる)。
 */
import { ArgumentError } from "../errors";

/** 結果を置いておく時間(秒)。KV の最小 TTL(60 秒)以上。 */
export const IDEMPOTENCY_TTL_SECONDS = 300;
/** 明示キーの最大長（UTF-8 のバイト数）。`idem:<ユーザーID>:<ツール名>:explicit:` を足しても KV のキーの上限（512 バイト）に収まる値。 */
export const MAX_EXPLICIT_KEY_BYTES = 200;

/** KVNamespace の、ここで使う部分。 */
export interface IdempotencyKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}

export interface IdempotencyDeps {
  kv: IdempotencyKv;
  /** Backlog のユーザー ID(grant の props)。別ユーザーの同一引数の呼び出しを衝突させない。 */
  userId: number;
}

/** キーをソートした JSON(オブジェクトのキー順に依存しないハッシュのため)。 */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, sort(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 明示キー: params._meta.idempotency_key → 引数の idempotency_key の順。
 * 空文字・文字列でない値は無いものとして扱う。長すぎるものは argument_error。
 */
export function explicitKeyFrom(
  meta: Record<string, unknown> | undefined,
  rawArgs: unknown,
): string | undefined {
  const fromArgs =
    rawArgs && typeof rawArgs === "object"
      ? (rawArgs as Record<string, unknown>).idempotency_key
      : undefined;
  for (const candidate of [meta?.idempotency_key, fromArgs]) {
    if (typeof candidate !== "string" || candidate === "") continue;
    const bytes = new TextEncoder().encode(candidate).length;
    if (bytes > MAX_EXPLICIT_KEY_BYTES) {
      throw new ArgumentError(
        `idempotency_key must be at most ${MAX_EXPLICIT_KEY_BYTES} bytes in UTF-8, got ${bytes}`,
      );
    }
    return candidate;
  }
  return undefined;
}

/** `idem:<backlogUserId>:<toolName>:<explicit|hash>:<値>` */
export async function idempotencyCacheKey(
  userId: number,
  toolName: string,
  explicit: string | undefined,
  args: unknown,
): Promise<string> {
  return explicit !== undefined
    ? `idem:${userId}:${toolName}:explicit:${explicit}`
    : `idem:${userId}:${toolName}:hash:${await sha256Hex(canonicalJson(args))}`;
}

/**
 * 保存済みの結果(JSON 文字列)があればそれを返し、なければ run を実行して成功した結果だけ保存する。
 * KV の失敗は呼び出しを止めない(読めなければ実行、書けなくても結果は返す)。
 */
export async function withIdempotency(
  deps: IdempotencyDeps,
  key: string,
  run: () => Promise<unknown>,
): Promise<string> {
  let cached: string | null = null;
  try {
    cached = await deps.kv.get(key);
  } catch (e) {
    console.error(`idempotency cache read failed: ${e instanceof Error ? e.name : typeof e}`);
  }
  if (cached !== null) return cached;

  const text = JSON.stringify((await run()) ?? null);
  try {
    await deps.kv.put(key, text, { expirationTtl: IDEMPOTENCY_TTL_SECONDS });
  } catch (e) {
    console.error(`idempotency cache write failed: ${e instanceof Error ? e.name : typeof e}`);
  }
  return text;
}
