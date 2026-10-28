// 実物のループバック受信(node:http)。Node 環境で実際に 127.0.0.1 へ HTTP を送って確かめる。
import { describe, expect, it } from "vitest";
import { startLoopbackReceiver } from "../../scripts/verify-oauth/loopback";

describe("ループバックのコールバック受信", () => {
  it("127.0.0.1 の空きポートで待ち受け、コールバックの URL(クエリつき)を返し、ブラウザには完了ページを返す", async () => {
    const receiver = await startLoopbackReceiver();
    try {
      const uri = new URL(receiver.redirectUri);
      expect(uri.hostname).toBe("127.0.0.1");
      expect(uri.pathname).toBe("/callback");
      expect(Number(uri.port)).toBeGreaterThan(0);

      const waiting = receiver.wait();
      const res = await fetch(
        `${receiver.redirectUri}?code=abc&state=xyz&iss=https%3A%2F%2Fh.example.com`,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("verify:oauth");
      const received = new URL(await waiting);
      expect(received.origin + received.pathname).toBe(receiver.redirectUri);
      expect(received.searchParams.get("code")).toBe("abc");
      expect(received.searchParams.get("state")).toBe("xyz");
      expect(received.searchParams.get("iss")).toBe("https://h.example.com");
    } finally {
      receiver.close();
    }
  });

  it("/callback 以外のパスは 404 で、待ちを完了させない", async () => {
    const receiver = await startLoopbackReceiver();
    try {
      const base = new URL(receiver.redirectUri).origin;
      expect((await fetch(`${base}/favicon.ico`)).status).toBe(404);
      const outcome = await Promise.race([
        receiver.wait().then(() => "done"),
        new Promise((r) => setTimeout(() => r("pending"), 100)),
      ]);
      expect(outcome).toBe("pending");
    } finally {
      receiver.close();
    }
  });

  it("タイムアウトすると wait が失敗する", async () => {
    const receiver = await startLoopbackReceiver({ timeoutMs: 50 });
    try {
      await expect(receiver.wait()).rejects.toThrow(/タイムアウト|timeout/i);
    } finally {
      receiver.close();
    }
  });
});
