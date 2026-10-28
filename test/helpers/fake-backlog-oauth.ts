import { jsonResponse, type RecordedCall } from "./mock-fetch";

/**
 * 状態と時刻を持つ Backlog OAuth の fake(E2E 用。実 Backlog には通信しない)。
 *
 * 2026-10-29 の実環境の観測(ADR 0001 / 0014)に合わせる:
 * - 有効期限内のリフレッシュは、同じアクセストークンを残り寿命(expires_in = 残り秒数)つきで返すだけで、
 *   期限は延びない。リフレッシュトークンも返さない(ローテーションしない)
 * - 失効後のリフレッシュは新しいアクセストークン(expires_in 約 3600)を発行し、refresh_token は変えない(2026-10-29 05:00 実測。ADR 0014)
 * - /users/myself は、現在のトークンで期限内のときだけ 200、それ以外(失効・古いトークン)は 401
 *
 * 毎回新しいトークンを返すモックでは「期限内の更新で期限が延びない」ことを再現できず、
 * 事前更新が効かない問題を見逃した。時刻は Date.now()(vi.useFakeTimers の Date)で判定する。
 */
export interface FakeBacklogOAuthOptions {
  /** 失効後の更新でリフレッシュトークンも新しくする(ローテーションありの実装の確認用)。 */
  rotate?: boolean;
  /** リフレッシュに常にこのステータスで失敗する(例: 400 invalid_grant)。 */
  refreshStatus?: number;
  /** アクセストークンの寿命(秒)。既定 3600。 */
  lifetimeSeconds?: number;
}

export function createFakeBacklogOAuth(opts: FakeBacklogOAuthOptions = {}) {
  const lifetime = opts.lifetimeSeconds ?? 3600;
  let accessSeq = 0;
  let refreshSeq = 1;
  let current: { accessToken: string; expiresAt: number } | undefined;
  let refreshToken = "backlog-rt-1";
  let revoked = false;
  let refreshCalls = 0;
  let refreshesReturningSameToken = 0;

  function issue() {
    accessSeq += 1;
    current = { accessToken: `backlog-at-${accessSeq}`, expiresAt: Date.now() + lifetime * 1000 };
    revoked = false;
    return current;
  }

  function isValid(token: string | undefined): boolean {
    return (
      current !== undefined &&
      !revoked &&
      token === current.accessToken &&
      Date.now() < current.expiresAt
    );
  }

  return {
    /** POST /api/v2/oauth2/token */
    token(call: RecordedCall): Response {
      const form = new URLSearchParams(call.body);
      if (form.get("grant_type") === "authorization_code") {
        const t = issue();
        return jsonResponse({
          access_token: t.accessToken,
          refresh_token: refreshToken,
          token_type: "Bearer",
          expires_in: lifetime,
        });
      }
      refreshCalls += 1;
      if (opts.refreshStatus && opts.refreshStatus !== 200) {
        return jsonResponse({ error: "invalid_grant" }, opts.refreshStatus);
      }
      if (form.get("refresh_token") !== refreshToken) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      if (current && !revoked && Date.now() < current.expiresAt) {
        // 期限内: 同じトークンと残り秒数だけ(観測どおり)
        refreshesReturningSameToken += 1;
        return jsonResponse({
          access_token: current.accessToken,
          token_type: "Bearer",
          expires_in: Math.floor((current.expiresAt - Date.now()) / 1000),
        });
      }
      const t = issue();
      if (opts.rotate) {
        refreshSeq += 1;
        refreshToken = `backlog-rt-${refreshSeq}`;
      }
      return jsonResponse({
        access_token: t.accessToken,
        ...(opts.rotate ? { refresh_token: refreshToken } : {}),
        token_type: "Bearer",
        expires_in: lifetime,
      });
    },
    /** GET /api/v2/users/myself */
    myself(call: RecordedCall): Response {
      const token = call.headers.get("authorization")?.replace(/^Bearer /, "");
      return isValid(token)
        ? jsonResponse({ id: 42, userId: "alice", name: "Alice", mailAddress: "alice@example.com" })
        : jsonResponse({}, 401);
    },
    /** 期限前に Backlog 側でトークンが取り消された状態にする。次のリフレッシュは新しいトークンを発行する。 */
    revoke() {
      revoked = true;
    },
    get refreshCalls() {
      return refreshCalls;
    },
    get refreshesReturningSameToken() {
      return refreshesReturningSameToken;
    },
    get currentAccessToken() {
      return current?.accessToken;
    },
  };
}
