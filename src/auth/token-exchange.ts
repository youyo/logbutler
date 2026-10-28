import {
  type GrantType,
  OAuthError,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { BacklogOAuthError, refreshTokens } from "./backlog-oauth";
import { clearBacklogStale, isBacklogStale } from "./backlog-stale";
import type { GrantProps } from "./props";

/**
 * MCP アクセストークンの寿命。Backlog のアクセストークン(約 1 時間)より短くする。
 * こうすると MCP のリフレッシュ 1 回につき Backlog のリフレッシュが高々 1 回になり、
 * 並列リフレッシュの競合を避けられる。
 */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 30 * 60;
/** Backlog から新しいトークンを得たとき、その期限より手前に MCP の次の更新を置く余裕。 */
const SKEW_SECONDS = 60;
/**
 * Backlog のトークンが新しくならなかった(呼ばなかった・同じトークンが返った)ときに、MCP の寿命を
 * Backlog の残り寿命より少しだけ長くする余裕。次の MCP の更新を Backlog の失効「直後」に来させ、
 * そこで Backlog から新しいトークンを得る(ADR 0014)。
 * 数秒でよい根拠: 保存期限は「応答を受けた時刻 + expires_in」なので Backlog 側の実際の期限以後になる。
 * 残り秒数は floor で切り捨て、ライブラリも自分の now で秒を数えるので ±1 秒ずれる。それを吸収できれば足りる。
 * 長くすると、失効から次の更新までの間に Backlog の 401(→ stale 印で回復)が出る時間が延びるだけ。
 */
export const BACKLOG_EXPIRY_GRACE_SECONDS = 5;
/** KV の最小 TTL(workers-oauth-provider も 60 秒未満を拒否する)。 */
const MIN_TTL_SECONDS = 60;

export interface TokenExchangeOptions {
  now?: () => number;
}

type Callback = (
  options: TokenExchangeCallbackOptions<Env>,
) => Promise<TokenExchangeCallbackResult | undefined>;

/**
 * MCP のトークンを発行・更新するたびに呼ばれる(ADR 0001 / 0014)。
 *
 * Backlog は有効期限内のリフレッシュでは同じアクセストークンを残り寿命(expires_in = 残り秒数)つきで
 * 返すだけで、期限は延びない(2026-10-29 の観測)。そのため Backlog を呼ぶのは次のときだけにする:
 * - 保存した期限(backlogExpiresAt)を過ぎている(残り 0 以下)
 * - /mcp で Backlog が 401 を返した印(backlog-stale)がある。期限に関係なく更新し、成功したら印を消す
 *
 * MCP アクセストークンの寿命:
 * - Backlog から新しいトークンを得た: min(MCP_ACCESS_TOKEN_TTL_SECONDS, 残り - SKEW_SECONDS)
 * - それ以外(呼ばなかった・同じトークンが返った): min(MCP_ACCESS_TOKEN_TTL_SECONDS, 残り + BACKLOG_EXPIRY_GRACE_SECONDS)。
 *   次の MCP の更新が Backlog の失効直後に来て、そこで新しいトークンを得る
 * どちらも下限は KV の最小 60 秒。失効と次の更新の隙間の 401 は stale 印で回復する。
 *
 * Backlog 側で失効していたら invalid_grant(grant を失効させる)、一時障害なら temporarily_unavailable(grant は残す)。
 * 応答に refresh_token があれば差し替え、なければ維持する(backlog-oauth.ts。観測ではローテーションしない)。
 */
export function createTokenExchangeCallback(opts: TokenExchangeOptions = {}): Callback {
  const now = opts.now ?? (() => Date.now());

  return async ({ grantType, props, env, userId, grantId }) => {
    if (!isRefreshableGrant(grantType)) return undefined;
    const previous = props as GrantProps;
    let current = previous;
    let refreshed = false;

    const remainingMs = current.backlogExpiresAt - now();
    // 期限内に更新しても同じトークンが返るだけなので、期限切れ(残り 0 以下)のときだけ更新する。
    const needsRefresh = remainingMs <= 0;
    // /mcp で Backlog が 401 を返した grant は、期限に関係なく更新する(backlog-stale.ts)。
    // 認可コードの直後は取りたてなので見ない。
    const stale = grantType === "refresh_token" && (await readStale(env.OAUTH_KV, userId, grantId));
    if (needsRefresh || stale) {
      try {
        const tokens = await refreshTokens(
          {
            spaceHost: env.BACKLOG_SPACE_HOST,
            clientId: env.BACKLOG_CLIENT_ID,
            clientSecret: env.BACKLOG_CLIENT_SECRET,
          },
          current.backlogRefreshToken,
          now(),
        );
        current = {
          ...current,
          backlogAccessToken: tokens.accessToken,
          backlogRefreshToken: tokens.refreshToken,
          backlogExpiresAt: tokens.expiresAt,
        };
        refreshed = true;
      } catch (e) {
        throw toOAuthError(e);
      }
    }

    if (refreshed && stale) await clearStale(env.OAUTH_KV, userId, grantId);

    const accessTokenChanged =
      refreshed && current.backlogAccessToken !== previous.backlogAccessToken;
    const remainingSeconds = Math.floor((current.backlogExpiresAt - now()) / 1000);
    const ttlBasis = accessTokenChanged ? "new_token" : "backlog_remaining";
    const accessTokenTTL = Math.max(
      MIN_TTL_SECONDS,
      Math.min(
        MCP_ACCESS_TOKEN_TTL_SECONDS,
        accessTokenChanged
          ? remainingSeconds - SKEW_SECONDS
          : remainingSeconds + BACKLOG_EXPIRY_GRACE_SECONDS,
      ),
    );

    // 診断ログ(値は出さない)。access_token_changed は Backlog が更新で同じトークンを返したか、
    // ttl_basis は MCP の寿命の決め方(new_token: 新しい期限 - SKEW、backlog_remaining: 残り + 余裕)。
    console.log(
      JSON.stringify({
        event: "token_exchange",
        grant_type: grantType,
        backlog_remaining_seconds: Math.floor(remainingMs / 1000),
        needs_refresh: needsRefresh,
        stale_marker: stale,
        refreshed,
        ...(refreshed ? { access_token_changed: accessTokenChanged } : {}),
        ttl_basis: ttlBasis,
        access_token_ttl: accessTokenTTL,
      }),
    );

    return refreshed
      ? { accessTokenProps: current, newProps: current, accessTokenTTL }
      : { accessTokenTTL };
  };
}

/** 印の読み取りに失敗しても MCP の更新は止めない(期限による判定だけで続ける)。 */
async function readStale(kv: KVNamespace, userId: string, grantId: string): Promise<boolean> {
  try {
    return await isBacklogStale(kv, userId, grantId);
  } catch {
    console.warn(JSON.stringify({ event: "backlog_stale_read_failed" }));
    return false;
  }
}

async function clearStale(kv: KVNamespace, userId: string, grantId: string): Promise<void> {
  try {
    await clearBacklogStale(kv, userId, grantId);
  } catch {
    // 消し損ねても、次の更新で Backlog をもう一度更新するだけ(TTL で消える)。
    console.warn(JSON.stringify({ event: "backlog_stale_clear_failed" }));
  }
}

function isRefreshableGrant(grantType: GrantType | string): boolean {
  return grantType === "authorization_code" || grantType === "refresh_token";
}

function toOAuthError(e: unknown): OAuthError {
  if (e instanceof BacklogOAuthError && e.kind === "invalid_grant") {
    return new OAuthError("invalid_grant", {
      description: "Backlog access was revoked or expired. Re-authorize.",
    });
  }
  return new OAuthError("temporarily_unavailable", {
    description: "Backlog is temporarily unavailable. Retry later.",
    statusCode: 503,
  });
}
