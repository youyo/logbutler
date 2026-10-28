import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { checkConfig } from "../../src/config-check";

const valid = {
  OAUTH_KV: env.OAUTH_KV,
  BACKLOG_SPACE_HOST: "example.backlog.com",
  PUBLIC_BASE_URL: "https://logbutler.example.com",
  BACKLOG_CLIENT_ID: "client-id-value",
  BACKLOG_CLIENT_SECRET: "client-secret-value",
};

describe("checkConfig", () => {
  it("すべてそろっていれば ok", () => {
    expect(checkConfig(valid)).toEqual({ ok: true, missing: [], invalid: [] });
  });

  it.each([
    "OAUTH_KV",
    "BACKLOG_SPACE_HOST",
    "PUBLIC_BASE_URL",
    "BACKLOG_CLIENT_ID",
    "BACKLOG_CLIENT_SECRET",
  ] as const)("%s が無ければ missing に項目名だけが入る", (name) => {
    const { [name]: _removed, ...rest } = valid;
    expect(checkConfig(rest)).toEqual({ ok: false, missing: [name], invalid: [] });
  });

  it("空文字・空白だけの値は未設定として扱う", () => {
    const result = checkConfig({ ...valid, BACKLOG_CLIENT_ID: "", BACKLOG_CLIENT_SECRET: "  " });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["BACKLOG_CLIENT_ID", "BACKLOG_CLIENT_SECRET"]);
  });

  it("KV バインディングが KV でない値(文字列など)なら missing", () => {
    expect(checkConfig({ ...valid, OAUTH_KV: "not-a-kv" }).missing).toEqual(["OAUTH_KV"]);
  });

  it("プレースホルダ(<...>)のまま残っている値は invalid", () => {
    const result = checkConfig({
      ...valid,
      PUBLIC_BASE_URL: "https://<domain>",
      BACKLOG_SPACE_HOST: "<space>.backlog.com",
      BACKLOG_CLIENT_ID: "<client-id>",
    });
    expect(result.missing).toEqual([]);
    expect(result.invalid).toEqual(["BACKLOG_SPACE_HOST", "PUBLIC_BASE_URL", "BACKLOG_CLIENT_ID"]);
  });

  it.each([
    ["http://logbutler.example.com", false],
    ["logbutler.example.com", false],
    ["https://logbutler.example.com/mcp", false],
    ["https://logbutler.example.com?x=1", false],
    ["https://logbutler.example.com/", true],
    ["http://localhost:8787", true],
    ["http://127.0.0.1:8787", true],
  ])("PUBLIC_BASE_URL %s の妥当性は %s", (url, isValid) => {
    const result = checkConfig({ ...valid, PUBLIC_BASE_URL: url });
    expect(result.invalid.includes("PUBLIC_BASE_URL")).toBe(!isValid);
  });

  it.each([
    ["https://example.backlog.com", false],
    ["example.backlog.com/", false],
    ["example backlog.com", false],
    ["example.backlog.com", true],
  ])("BACKLOG_SPACE_HOST %s の妥当性は %s", (host, isValid) => {
    const result = checkConfig({ ...valid, BACKLOG_SPACE_HOST: host });
    expect(result.invalid.includes("BACKLOG_SPACE_HOST")).toBe(!isValid);
  });

  it("結果に値(秘密を含む)を載せない", () => {
    const result = checkConfig({
      ...valid,
      PUBLIC_BASE_URL: "https://<domain>/secret-path",
      BACKLOG_CLIENT_SECRET: "<super-secret>",
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain("super-secret");
    expect(json).not.toContain("secret-path");
  });
});
