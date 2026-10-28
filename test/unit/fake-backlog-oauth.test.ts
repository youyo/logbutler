import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeBacklogOAuth } from "../helpers/fake-backlog-oauth";
import type { RecordedCall } from "../helpers/mock-fetch";

afterEach(() => {
  vi.useRealTimers();
});

function tokenCall(grantType: "authorization_code" | "refresh_token", refreshToken?: string) {
  const body = new URLSearchParams({ grant_type: grantType });
  if (refreshToken) body.set("refresh_token", refreshToken);
  return {
    method: "POST",
    url: "x",
    headers: new Headers(),
    body: body.toString(),
  } as RecordedCall;
}

function myselfCall(token: string) {
  return {
    method: "GET",
    url: "x",
    headers: new Headers({ authorization: `Bearer ${token}` }),
    body: "",
  } as RecordedCall;
}

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("fake Backlog OAuth", () => {
  it("認可コード交換はアクセストークン・リフレッシュトークン・寿命を返す", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = createFakeBacklogOAuth();
    const body = await json(fake.token(tokenCall("authorization_code")));
    expect(body).toMatchObject({
      access_token: "backlog-at-1",
      refresh_token: "backlog-rt-1",
      expires_in: 3600,
    });
  });

  it("期限内の refresh は同じ access_token・expires_in=残り秒数で、refresh_token は返さない", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = createFakeBacklogOAuth();
    await fake.token(tokenCall("authorization_code"));
    vi.setSystemTime(Date.now() + 600_500);
    const body = await json(fake.token(tokenCall("refresh_token", "backlog-rt-1")));
    expect(body.access_token).toBe("backlog-at-1");
    expect(body.expires_in).toBe(2999); // 3600 - 600.5 を切り捨て
    expect(body).not.toHaveProperty("refresh_token");
    expect(fake.refreshCalls).toBe(1);
    expect(fake.refreshesReturningSameToken).toBe(1);
    // 期限は延びない: 元の期限(3600 秒後)の 1 秒前もまだ有効
    vi.setSystemTime(Date.now() + 2_998_000);
    expect(fake.myself(myselfCall("backlog-at-1")).status).toBe(200);
  });

  it("失効後の refresh は新しいトークンを発行する(推定の挙動。実測は未確認)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = createFakeBacklogOAuth();
    await fake.token(tokenCall("authorization_code"));
    vi.setSystemTime(Date.now() + 3600_000);
    const body = await json(fake.token(tokenCall("refresh_token", "backlog-rt-1")));
    expect(body.access_token).toBe("backlog-at-2");
    expect(body.expires_in).toBe(3600);
    expect(body).not.toHaveProperty("refresh_token");
    expect(fake.refreshesReturningSameToken).toBe(0);
    expect(fake.currentAccessToken).toBe("backlog-at-2");
  });

  it("rotate: true の失効後 refresh は新しい refresh_token も返し、古いものは invalid_grant", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = createFakeBacklogOAuth({ rotate: true });
    await fake.token(tokenCall("authorization_code"));
    vi.setSystemTime(Date.now() + 3600_000);
    const body = await json(fake.token(tokenCall("refresh_token", "backlog-rt-1")));
    expect(body.refresh_token).toBe("backlog-rt-2");
    const old = fake.token(tokenCall("refresh_token", "backlog-rt-1"));
    expect(old.status).toBe(400);
  });

  it("revoke() 後は期限内でも /users/myself が 401 になり、次の refresh は新しいトークンを発行する", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = createFakeBacklogOAuth();
    await fake.token(tokenCall("authorization_code"));
    expect(fake.myself(myselfCall("backlog-at-1")).status).toBe(200);
    fake.revoke();
    expect(fake.myself(myselfCall("backlog-at-1")).status).toBe(401);
    const body = await json(fake.token(tokenCall("refresh_token", "backlog-rt-1")));
    expect(body.access_token).toBe("backlog-at-2");
    expect(body.expires_in).toBe(3600);
    expect(fake.refreshesReturningSameToken).toBe(0);
    expect(fake.myself(myselfCall("backlog-at-2")).status).toBe(200);
  });

  it("/users/myself は現在のトークンで期限内なら 200、古いトークン・不明なトークン・期限切れは 401", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = createFakeBacklogOAuth();
    await fake.token(tokenCall("authorization_code"));
    const ok = fake.myself(myselfCall("backlog-at-1"));
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ userId: "alice" });
    expect(fake.myself(myselfCall("other")).status).toBe(401);
    expect(fake.myself({ ...myselfCall(""), headers: new Headers() }).status).toBe(401);

    vi.setSystemTime(Date.now() + 3600_000);
    expect(fake.myself(myselfCall("backlog-at-1")).status).toBe(401);
    await fake.token(tokenCall("refresh_token", "backlog-rt-1"));
    expect(fake.myself(myselfCall("backlog-at-1")).status).toBe(401); // 古いトークン
    expect(fake.myself(myselfCall("backlog-at-2")).status).toBe(200);
  });
});
