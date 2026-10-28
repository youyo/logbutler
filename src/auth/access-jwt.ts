import { createLocalJWKSet, errors, type JSONWebKeySet, jwtVerify } from "jose";

/**
 * Cloudflare Access の `Cf-Access-Jwt-Assertion` を検証する。
 * Access が前段で保護していても、Worker 側で署名・iss・aud・期限を必ず検証する(多層防御)。
 * JWKS は https://{team}/cdn-cgi/access/certs から取得し、isolate 内でキャッシュする。
 */

export interface AccessJwtConfig {
  /** 例 your-team.cloudflareaccess.com */
  teamDomain: string;
  /** Access アプリケーションの AUD タグ */
  aud: string;
}

export interface AccessIdentity {
  email: string;
  subject: string;
}

export type AccessJwtErrorReason = "missing" | "invalid" | "jwks_unavailable";

export class AccessJwtError extends Error {
  constructor(
    readonly reason: AccessJwtErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "AccessJwtError";
  }
}

const JWKS_TTL_MS = 5 * 60 * 1000;

interface CachedJwks {
  jwks: JSONWebKeySet;
  fetchedAt: number;
}
const cache = new Map<string, CachedJwks>();

export function clearJwksCache(): void {
  cache.clear();
}

async function fetchJwks(teamDomain: string): Promise<JSONWebKeySet> {
  let res: Response;
  try {
    res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  } catch {
    throw new AccessJwtError("jwks_unavailable", "Access JWKS unreachable");
  }
  if (!res.ok) {
    throw new AccessJwtError("jwks_unavailable", `Access JWKS returned ${res.status}`);
  }
  const body = (await res.json()) as JSONWebKeySet;
  if (!body || !Array.isArray(body.keys)) {
    throw new AccessJwtError("jwks_unavailable", "Access JWKS is malformed");
  }
  cache.set(teamDomain, { jwks: body, fetchedAt: Date.now() });
  return body;
}

async function getJwks(teamDomain: string, forceRefresh: boolean): Promise<JSONWebKeySet> {
  const hit = cache.get(teamDomain);
  if (!forceRefresh && hit && Date.now() - hit.fetchedAt < JWKS_TTL_MS) return hit.jwks;
  return fetchJwks(teamDomain);
}

async function verifyOnce(token: string, cfg: AccessJwtConfig, forceRefresh: boolean) {
  const jwks = await getJwks(cfg.teamDomain, forceRefresh);
  return jwtVerify(token, createLocalJWKSet(jwks), {
    issuer: `https://${cfg.teamDomain}`,
    audience: cfg.aud,
    algorithms: ["RS256"],
  });
}

export async function verifyAccessJwt(
  token: string | null | undefined,
  cfg: AccessJwtConfig,
): Promise<AccessIdentity> {
  if (!token) throw new AccessJwtError("missing", "Cf-Access-Jwt-Assertion is missing");

  let result: Awaited<ReturnType<typeof verifyOnce>>;
  try {
    try {
      result = await verifyOnce(token, cfg, false);
    } catch (e) {
      // 未知の kid は鍵ローテーションの可能性があるので、JWKS を 1 回だけ取り直す。
      // (署名不一致では取り直さない: 不正な JWT を連投されても JWKS への通信が増えないようにする)
      if (e instanceof errors.JWKSNoMatchingKey) {
        result = await verifyOnce(token, cfg, true);
      } else {
        throw e;
      }
    }
  } catch (e) {
    if (e instanceof AccessJwtError) throw e;
    throw new AccessJwtError("invalid", "Access JWT verification failed");
  }

  const email = result.payload.email;
  if (typeof email !== "string" || email === "" || !result.payload.sub) {
    throw new AccessJwtError("invalid", "Access JWT has no identity");
  }
  return { email, subject: result.payload.sub };
}
