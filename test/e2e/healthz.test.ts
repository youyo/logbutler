import { describe, expect, it } from "vitest";
import { worker } from "../helpers/oauth-flow";

describe("E2E: /healthz", () => {
  it("認証なしで {status:'ok'} を返す", async () => {
    const res = await worker.fetch("https://logbutler.test/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
