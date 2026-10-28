import {
  type GrantType,
  OAuthError,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { BacklogOAuthError, refreshTokens } from "./backlog-oauth";
import type { GrantProps } from "./props";

/**
 * MCP アクセストークンの寿命。Backlog のアクセストークン(約 1 時間)より短くする。
 * こうすると MCP のリフレッシュ 1 回につき Backlog のリフレッシュが高々 1 回になり、
 * 並列リフレッシュの競合を避けられる。
 */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 30 * 60;
/** Backlog トークンの期限に持たせる余裕。 */
const SKEW_SECONDS = 60;
/** KV の最小 TTL。 */
const MIN_TTL_SECONDS = 60;

export interface TokenExchangeOptions {
  now?: () => number;
}

type Callback = (
  options: TokenExchangeCallbackOptions<Env>,
) => Promise<TokenExchangeCallbackResult | undefined>;

/**
 * MCP のトークンを発行・更新するたびに呼ばれる。
 * Backlog のアクセストークンが次の MCP トークンの寿命より先に切れるなら、Backlog のトークンも更新し、
 * grant の props を差し替える。Backlog 側で失効していたら invalid_grant(grant を失効させる)、
 * 一時障害なら temporarily_unavailable(grant は残す)。
 *
 * Backlog がリフレッシュトークンをローテーションするかは未検証。応答に refresh_token があれば差し替え、
 * なければ維持する(backlog-oauth.ts)。
 */
export function createTokenExchangeCallback(opts: TokenExchangeOptions = {}): Callback {
  const now = opts.now ?? (() => Date.now());

  return async ({ grantType, props, env }) => {
    if (!isRefreshableGrant(grantType)) return undefined;
    let current = props as GrantProps;
    let refreshed = false;

    const needsRefresh =
      current.backlogExpiresAt - now() < (MCP_ACCESS_TOKEN_TTL_SECONDS + SKEW_SECONDS) * 1000;
    if (needsRefresh) {
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

    const remainingSeconds = Math.floor((current.backlogExpiresAt - now()) / 1000) - SKEW_SECONDS;
    const accessTokenTTL = Math.max(
      MIN_TTL_SECONDS,
      Math.min(MCP_ACCESS_TOKEN_TTL_SECONDS, remainingSeconds),
    );

    return refreshed
      ? { accessTokenProps: current, newProps: current, accessTokenTTL }
      : { accessTokenTTL };
  };
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
