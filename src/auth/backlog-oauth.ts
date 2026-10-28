/**
 * Backlog OAuth 2.0 (上流 IdP)。
 * - 認可: https://{host}/OAuth2AccessRequest.action
 * - トークン: POST https://{host}/api/v2/oauth2/token (client_secret はフォームで送る)
 *
 * トークン・client_secret をログやエラーメッセージに出さない。
 */

export interface BacklogOAuthConfig {
  spaceHost: string;
  clientId: string;
  clientSecret: string;
}

export interface BacklogTokens {
  accessToken: string;
  refreshToken: string;
  /** アクセストークンの期限(エポックミリ秒)。 */
  expiresAt: number;
}

export type BacklogOAuthErrorKind =
  /** コードやリフレッシュトークンが無効(失効・取り消し)。再認可が必要。 */
  | "invalid_grant"
  /** 一時的な障害(5xx・429・通信失敗)。リトライ可能。 */
  | "temporarily_unavailable"
  /** 成功応答だが形式が想定と違う。 */
  | "invalid_response";

export class BacklogOAuthError extends Error {
  constructor(
    readonly kind: BacklogOAuthErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "BacklogOAuthError";
  }
}

export function buildAuthorizeUrl(
  cfg: BacklogOAuthConfig,
  params: { redirectUri: string; state: string },
): string {
  const url = new URL(`https://${cfg.spaceHost}/OAuth2AccessRequest.action`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

export function exchangeCode(
  cfg: BacklogOAuthConfig,
  params: { code: string; redirectUri: string },
  now: number = Date.now(),
): Promise<BacklogTokens> {
  return requestTokens(
    cfg,
    { grant_type: "authorization_code", code: params.code, redirect_uri: params.redirectUri },
    undefined,
    now,
  );
}

/**
 * リフレッシュトークンでアクセストークンを更新する。
 * 応答に refresh_token があれば差し替え(ローテーションあり)、なければ元のものを維持する(なし)。
 */
export function refreshTokens(
  cfg: BacklogOAuthConfig,
  refreshToken: string,
  now: number = Date.now(),
): Promise<BacklogTokens> {
  return requestTokens(
    cfg,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    refreshToken,
    now,
  );
}

async function requestTokens(
  cfg: BacklogOAuthConfig,
  grant: Record<string, string>,
  fallbackRefreshToken: string | undefined,
  now: number,
): Promise<BacklogTokens> {
  const form = new URLSearchParams({
    ...grant,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });

  let res: Response;
  try {
    res = await fetch(`https://${cfg.spaceHost}/api/v2/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
  } catch {
    throw new BacklogOAuthError("temporarily_unavailable", "Backlog token endpoint unreachable");
  }

  if (res.status === 400 || res.status === 401) {
    throw new BacklogOAuthError(
      "invalid_grant",
      `Backlog token endpoint rejected the grant (${res.status})`,
    );
  }
  if (!res.ok) {
    throw new BacklogOAuthError(
      "temporarily_unavailable",
      `Backlog token endpoint returned ${res.status}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new BacklogOAuthError("invalid_response", "Backlog token response is not JSON");
  }
  const b = body as Record<string, unknown> | null;
  const accessToken = typeof b?.access_token === "string" ? b.access_token : undefined;
  const refreshToken =
    typeof b?.refresh_token === "string" && b.refresh_token !== ""
      ? b.refresh_token
      : fallbackRefreshToken;
  const expiresIn = typeof b?.expires_in === "number" ? b.expires_in : undefined;
  if (!accessToken || !refreshToken || expiresIn === undefined) {
    throw new BacklogOAuthError("invalid_response", "Backlog token response is missing fields");
  }
  return { accessToken, refreshToken, expiresAt: now + expiresIn * 1000 };
}
