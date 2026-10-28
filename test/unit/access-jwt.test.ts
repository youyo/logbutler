import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessJwtError, clearJwksCache, verifyAccessJwt } from "../../src/auth/access-jwt";
import { createTestKey, jwksResponse, signAccessJwt, type TestKey } from "../helpers/access";
import { mockOutboundFetch } from "../helpers/mock-fetch";

const TEAM = "logbutler-test.cloudflareaccess.com";
const AUD = "test-access-aud";
const CERTS = `GET https://${TEAM}/cdn-cgi/access/certs`;
const cfg = { teamDomain: TEAM, aud: AUD };

let key: TestKey;
let otherKey: TestKey;

beforeEach(async () => {
  clearJwksCache();
  key = await createTestKey("kid-1");
  otherKey = await createTestKey("kid-1"); // 同じ kid だが別の鍵(署名不正の検証用)
});
afterEach(() => vi.restoreAllMocks());

async function expectRejected(token: string | null | undefined, reason?: string) {
  const err = await verifyAccessJwt(token, cfg).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AccessJwtError);
  if (reason) expect((err as AccessJwtError).reason).toBe(reason);
}

describe("verifyAccessJwt", () => {
  it("正しい JWT を受け入れ、メールアドレスを返す", async () => {
    mockOutboundFetch({ [CERTS]: () => jwksResponse(key) });
    const token = await signAccessJwt(key, { email: "bob@example.com" });
    const identity = await verifyAccessJwt(token, cfg);
    expect(identity.email).toBe("bob@example.com");
  });

  it("JWT がない(ヘッダー欠落)なら拒否する", async () => {
    mockOutboundFetch({ [CERTS]: () => jwksResponse(key) });
    await expectRejected(undefined, "missing");
    await expectRejected(null, "missing");
    await expectRejected("", "missing");
  });

  it("期限切れを拒否する", async () => {
    mockOutboundFetch({ [CERTS]: () => jwksResponse(key) });
    const past = Math.floor(Date.now() / 1000) - 3600;
    await expectRejected(await signAccessJwt(key, { iat: past, exp: past + 300 }), "invalid");
  });

  it("exp クレームのない JWT を拒否する(必須クレーム)", async () => {
    mockOutboundFetch({ [CERTS]: () => jwksResponse(key) });
    await expectRejected(await signAccessJwt(key, { exp: null }), "invalid");
  });

  it("aud 違いを拒否する", async () => {
    mockOutboundFetch({ [CERTS]: () => jwksResponse(key) });
    await expectRejected(await signAccessJwt(key, { aud: "another-app" }), "invalid");
  });

  it("issuer 違い(別チーム)を拒否する", async () => {
    mockOutboundFetch({ [CERTS]: () => jwksResponse(key) });
    await expectRejected(
      await signAccessJwt(key, { teamDomain: "evil.cloudflareaccess.com" }),
      "invalid",
    );
  });

  it("署名不正(同じ kid の別の鍵で署名)を拒否する", async () => {
    mockOutboundFetch({ [CERTS]: () => jwksResponse(key) });
    await expectRejected(await signAccessJwt(otherKey), "invalid");
  });

  it("JWKS を取得できなければ拒否する(fail closed)", async () => {
    mockOutboundFetch({ [CERTS]: () => new Response("boom", { status: 500 }) });
    await expectRejected(await signAccessJwt(key), "jwks_unavailable");
  });

  it("JWKS をキャッシュし、2 回目以降は取得しない", async () => {
    const m = mockOutboundFetch({ [CERTS]: () => jwksResponse(key) });
    const token = await signAccessJwt(key);
    await verifyAccessJwt(token, cfg);
    await verifyAccessJwt(token, cfg);
    expect(m.callsTo(CERTS)).toHaveLength(1);
  });

  it("未知の kid が来たら鍵ローテーションとみなして JWKS を取り直す(取得から 60 秒以上たっていれば)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const rotated = await createTestKey("kid-2");
      let current = [key];
      const m = mockOutboundFetch({ [CERTS]: () => jwksResponse(...current) });
      await verifyAccessJwt(await signAccessJwt(key), cfg);
      vi.setSystemTime(Date.now() + 61_000);
      current = [key, rotated];
      await verifyAccessJwt(await signAccessJwt(rotated), cfg);
      expect(m.callsTo(CERTS)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("キャッシュ取得から 60 秒未満なら、未知の kid でも強制再取得しない(取得直後の再取得を省く)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const unknown = await createTestKey("kid-unknown");
      const m = mockOutboundFetch({ [CERTS]: () => jwksResponse(key) });
      await verifyAccessJwt(await signAccessJwt(key), cfg); // 取得 1 回
      vi.setSystemTime(Date.now() + 59_000);
      await expectRejected(await signAccessJwt(unknown), "invalid");
      expect(m.callsTo(CERTS)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("初回取得の直後に未知の kid が来ても、すぐには取り直さない(取得が 1 回で済む)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const unknown = await createTestKey("kid-unknown");
      let current = [key];
      const m = mockOutboundFetch({ [CERTS]: () => jwksResponse(...current) });
      const token = await signAccessJwt(unknown);
      await expectRejected(token, "invalid"); // 初回取得のみ
      expect(m.callsTo(CERTS)).toHaveLength(1);
      await expectRejected(token, "invalid"); // 60 秒以内: 再取得しない
      await expectRejected(token, "invalid");
      expect(m.callsTo(CERTS)).toHaveLength(1);

      // 60 秒たてば、鍵ローテーションに追従するため再び取り直せる
      vi.setSystemTime(Date.now() + 61_000);
      current = [key, unknown];
      const identity = await verifyAccessJwt(token, cfg);
      expect(identity.email).toBe("alice@example.com");
      expect(m.callsTo(CERTS)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
