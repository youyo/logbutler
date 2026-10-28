import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export async function createTestKey(kid: string): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return { kid, privateKey, publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" } };
}

export interface SignOptions {
  teamDomain?: string;
  aud?: string;
  email?: string;
  /** 発行時刻(エポック秒)。 */
  iat?: number;
  /** 期限(エポック秒)。 */
  exp?: number;
}

export async function signAccessJwt(key: TestKey, opts: SignOptions = {}): Promise<string> {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  return new SignJWT({ email: opts.email ?? "alice@example.com", type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuer(`https://${opts.teamDomain ?? "logbutler-test.cloudflareaccess.com"}`)
    .setAudience(opts.aud ?? "test-access-aud")
    .setSubject("access-user-1")
    .setIssuedAt(iat)
    .setExpirationTime(opts.exp ?? iat + 300)
    .sign(key.privateKey);
}

export function jwksResponse(...keys: TestKey[]): Response {
  return new Response(JSON.stringify({ keys: keys.map((k) => k.publicJwk) }), {
    headers: { "Content-Type": "application/json" },
  });
}
