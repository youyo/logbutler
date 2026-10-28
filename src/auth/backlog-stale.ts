/**
 * 「この grant の Backlog トークンは更新が必要」という印(OAUTH_KV の `backlog-stale:<userId>:<grantId>`)。
 *
 * /mcp のツール呼び出しで Backlog が 401 を返したら api-handler が置き、次の MCP トークン更新で
 * tokenExchangeCallback が期限に関係なく Backlog を更新する(成功したら消す)。
 * 保存期限(backlogExpiresAt)より先に Backlog 側でトークンが失効したときに、更新を待たずに回復するため。
 *
 * 値は目印の "1" だけ。トークンは置かない(トークンは grant の props にだけある)。
 * KV は結果整合なので、別の colo からは印がすぐ見えないことがある(ADR 0001)。
 */

/** 印の寿命。MCP クライアントは 401 の直後に更新するので短くてよい。 */
export const BACKLOG_STALE_TTL_SECONDS = 15 * 60;

export function backlogStaleKey(userId: string, grantId: string): string {
  return `backlog-stale:${userId}:${grantId}`;
}

export async function markBacklogStale(
  kv: KVNamespace,
  userId: string,
  grantId: string,
): Promise<void> {
  await kv.put(backlogStaleKey(userId, grantId), "1", {
    expirationTtl: BACKLOG_STALE_TTL_SECONDS,
  });
}

export async function isBacklogStale(
  kv: KVNamespace,
  userId: string,
  grantId: string,
): Promise<boolean> {
  return (await kv.get(backlogStaleKey(userId, grantId))) !== null;
}

export async function clearBacklogStale(
  kv: KVNamespace,
  userId: string,
  grantId: string,
): Promise<void> {
  await kv.delete(backlogStaleKey(userId, grantId));
}

/**
 * MCP アクセストークン(`{userId}:{grantId}:{secret}`。workers-oauth-provider の d.ts の Token に明記)から
 * userId と grantId を取り出す。形式が違えば undefined。トークン自体はログに出さないこと。
 */
export function grantRefFromAccessToken(
  token: string | undefined,
): { userId: string; grantId: string } | undefined {
  if (!token) return undefined;
  const parts = token.split(":");
  if (parts.length !== 3) return undefined;
  const [userId, grantId] = parts;
  if (!userId || !grantId) return undefined;
  return { userId, grantId };
}
