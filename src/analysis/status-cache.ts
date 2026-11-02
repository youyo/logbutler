/**
 * 状態一覧の KV キャッシュ(ADR 0016 §1)。`GET /projects/:key/statuses` の `{id, name}` だけを、
 * `OAUTH_KV` の `statuses:<backlogUserId>` に 1 ユーザー 1 値の JSON で置く(ADR 0005 と同じ namespace・接頭辞方式)。
 *
 * - 値はプロジェクトキー → `{ fetched_at(ミリ秒), statuses }`。鮮度は項目ごとに `fetched_at` で見る(KV の TTL だけに
 *   頼ると、書き足すたびに古い項目の寿命が延びるため)。KV の `expirationTtl` も同じ 600 秒。
 * - キーにユーザー ID を含める: 参加していないプロジェクトの状態名が別ユーザーのキャッシュ経由で見えないようにする。
 * - 値に Backlog のトークン・クライアント情報は含めない。
 * - KV の読み書きの失敗・壊れた値はツールを止めない(キャッシュなしとして続ける)。
 */
import type { BacklogClient } from "../backlog/client";
import { seg } from "../mcp/args";

/** キャッシュの鮮度(秒)。KV の expirationTtl にも使う。 */
export const STATUS_CACHE_TTL_SECONDS = 600;

/** KVNamespace の、ここで使う部分。 */
export interface StatusCacheKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface StatusCacheDeps {
  kv: StatusCacheKv;
  /** Backlog のユーザー ID(grant の props)。 */
  userId: number;
}

export interface BacklogStatus {
  id: number;
  name: string;
}

interface Entry {
  fetched_at: number;
  statuses: BacklogStatus[];
}

export const statusCacheKey = (userId: number) => `statuses:${userId}`;

function isStatus(v: unknown): v is BacklogStatus {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.id === "number" && typeof s.name === "string";
}

/** 壊れた値・形の違う項目は捨てる。鮮度が切れた項目も捨てる(fetched_at が未来のものも信用しない)。 */
function parseFresh(raw: string, nowMs: number): Map<string, Entry> {
  const out = new Map<string, Entry>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const e = value as Record<string, unknown>;
    if (typeof e.fetched_at !== "number" || !Array.isArray(e.statuses)) continue;
    if (!e.statuses.every(isStatus)) continue;
    const ageMs = nowMs - e.fetched_at;
    if (ageMs < 0 || ageMs > STATUS_CACHE_TTL_SECONDS * 1000) continue;
    out.set(key, {
      fetched_at: e.fetched_at,
      statuses: e.statuses.map(({ id, name }) => ({ id, name })),
    });
  }
  return out;
}

/**
 * 1 回のツール呼び出しの間だけ使う状態一覧の取得器。KV の読み取りは最初の `get` で 1 回、
 * 書き込みは Backlog から引いたプロジェクトがあったときに `flush` で 1 回だけ。
 * `cache` が無ければ毎回 Backlog から引く(従来どおり)。
 */
export function createStatusLookup(
  client: BacklogClient,
  cache: StatusCacheDeps | undefined,
  now: () => Date,
) {
  let entries: Map<string, Entry> | undefined;
  let dirty = false;

  const load = async (): Promise<Map<string, Entry>> => {
    if (entries) return entries;
    entries = new Map();
    if (!cache) return entries;
    try {
      const raw = await cache.kv.get(statusCacheKey(cache.userId));
      if (raw) entries = parseFresh(raw, now().getTime());
    } catch {
      entries = new Map();
    }
    return entries;
  };

  return {
    /** GET /projects/:key/statuses(キャッシュにあって新しければ Backlog を呼ばない)。 */
    async get(projectKey: string): Promise<BacklogStatus[]> {
      const map = await load();
      const hit = map.get(projectKey);
      if (hit) return hit.statuses;
      const fetched =
        (await client.request<BacklogStatus[]>("GET", `/projects/${seg(projectKey)}/statuses`)) ??
        [];
      const statuses = fetched.map(({ id, name }) => ({ id, name }));
      map.set(projectKey, { fetched_at: now().getTime(), statuses });
      dirty = true;
      return statuses;
    },
    /** 引き直した分があれば、鮮度の残っている項目と合わせて 1 回だけ書く。失敗は無視する。 */
    async flush(): Promise<void> {
      if (!cache || !dirty || !entries) return;
      dirty = false;
      try {
        await cache.kv.put(
          statusCacheKey(cache.userId),
          JSON.stringify(Object.fromEntries(entries)),
          { expirationTtl: STATUS_CACHE_TTL_SECONDS },
        );
      } catch {
        // キャッシュなしとして続ける
      }
    },
  };
}

/** 状態の追加・更新・削除のあと、そのユーザーの値を消す(自分の変更をすぐ反映する)。失敗は無視する。 */
export async function invalidateStatusCache(cache: StatusCacheDeps | undefined): Promise<void> {
  if (!cache) return;
  try {
    await cache.kv.delete(statusCacheKey(cache.userId));
  } catch {
    // 最大 600 秒古い一覧が残るだけ
  }
}
