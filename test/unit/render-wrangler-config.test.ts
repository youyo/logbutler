import { describe, expect, it } from "vitest";
import {
  EXAMPLE_ENV,
  parseJsonc,
  renderWranglerConfig,
} from "../../scripts/render-wrangler-config/core";

type Config = Record<string, unknown> & {
  vars: Record<string, string>;
  kv_namespaces: unknown[];
};

// upstream の wrangler.jsonc に近い入力(コメント・末尾カンマ・env ブロックを含む)。
const BASE = `{
  // コメント
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "logbutler",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-13",
  "compatibility_flags": ["nodejs_compat",],
  "observability": { "enabled": true },
  "kv_namespaces": [
    /* ローカル用 */
    { "binding": "OAUTH_KV", "id": "00000000000000000000000000000000" },
  ],
  "vars": {
    "BACKLOG_SPACE_HOST": "example.backlog.com", // 末尾コメント
    "PUBLIC_BASE_URL": "https://logbutler.example.com",
    "EXTRA": "http://not-a-comment.example/*x*/",
  },
  "env": { "old": { "name": "x" } },
}`;

const VALID = {
  LOGBUTLER_WORKER_NAME: "my-logbutler",
  LOGBUTLER_KV_NAMESPACE_ID: "0123456789abcdef0123456789abcdef",
  LOGBUTLER_BACKLOG_SPACE_HOST: "myspace.backlog.com",
  LOGBUTLER_PUBLIC_BASE_URL: "https://my-logbutler.me.workers.dev",
};

function ok(env: Record<string, string | undefined>) {
  const r = renderWranglerConfig(BASE, env);
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r.errors)}`);
  return r.config as Config;
}

function errorsOf(env: Record<string, string | undefined>) {
  const r = renderWranglerConfig(BASE, env);
  if (r.ok) throw new Error("expected errors");
  return r.errors;
}

describe("parseJsonc", () => {
  it("コメントと末尾カンマを許し、文字列内の // や /* は壊さない", () => {
    const v = parseJsonc('{ "a": "http://x/*y*/", // c\n "b": [1,2,], /* d */ }') as Record<
      string,
      unknown
    >;
    expect(v).toEqual({ a: "http://x/*y*/", b: [1, 2] });
  });

  it("文字列内のエスケープされた引用符の後でも正しく読む", () => {
    expect(parseJsonc('{ "a": "q\\"//still", }')).toEqual({ a: 'q"//still' });
  });
});

describe("renderWranglerConfig: 全項目が埋まる", () => {
  it("名前・KV・vars を差し替え、workers_dev を有効にする(カスタムドメインなし)", () => {
    const c = ok(VALID);
    expect(c.name).toBe("my-logbutler");
    expect(c.kv_namespaces).toEqual([
      { binding: "OAUTH_KV", id: "0123456789abcdef0123456789abcdef" },
    ]);
    expect(c.vars.BACKLOG_SPACE_HOST).toBe("myspace.backlog.com");
    expect(c.vars.PUBLIC_BASE_URL).toBe("https://my-logbutler.me.workers.dev");
    expect(c.workers_dev).toBe(true);
    expect(c.routes).toBeUndefined();
  });

  it("カスタムドメインがあれば routes に custom_domain で入れ、workers_dev を無効にする", () => {
    const c = ok({ ...VALID, LOGBUTLER_CUSTOM_DOMAIN: "logbutler.example.org" });
    expect(c.routes).toEqual([{ pattern: "logbutler.example.org", custom_domain: true }]);
    expect(c.workers_dev).toBe(false);
  });

  it("カスタムドメインが空文字なら無いものとして扱う(GitHub の未設定 Variable は空文字になる)", () => {
    const c = ok({ ...VALID, LOGBUTLER_CUSTOM_DOMAIN: "  " });
    expect(c.workers_dev).toBe(true);
    expect(c.routes).toBeUndefined();
  });

  it("フラットな設定にする(env ブロックを持ち越さない)", () => {
    expect(ok(VALID).env).toBeUndefined();
  });

  it("上書き対象以外のトップレベル設定と vars を引き継ぐ", () => {
    const c = ok(VALID);
    expect(c.$schema).toBe("node_modules/wrangler/config-schema.json");
    expect(c.main).toBe("src/index.ts");
    expect(c.compatibility_date).toBe("2026-10-13");
    expect(c.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(c.observability).toEqual({ enabled: true });
    expect(c.vars.EXTRA).toBe("http://not-a-comment.example/*x*/");
  });

  it("upstream が追加した別の KV binding は残し、OAUTH_KV の id だけ差し替える", () => {
    const base = BASE.replace(
      '{ "binding": "OAUTH_KV", "id": "00000000000000000000000000000000" },',
      '{ "binding": "OAUTH_KV", "id": "00000000000000000000000000000000" }, { "binding": "OTHER", "id": "ffffffffffffffffffffffffffffffff" },',
    );
    const r = renderWranglerConfig(base, VALID);
    if (!r.ok) throw new Error("expected ok");
    expect((r.config as Config).kv_namespaces).toEqual([
      { binding: "OAUTH_KV", id: "0123456789abcdef0123456789abcdef" },
      { binding: "OTHER", id: "ffffffffffffffffffffffffffffffff" },
    ]);
  });

  it("出力テキストは JSON として読み戻せる", () => {
    const r = renderWranglerConfig(BASE, VALID);
    if (!r.ok) throw new Error("expected ok");
    expect(JSON.parse(r.text)).toEqual(r.config);
    expect(r.text.endsWith("\n")).toBe(true);
  });

  it("前後の空白は取り除く", () => {
    const c = ok({ ...VALID, LOGBUTLER_WORKER_NAME: "  my-logbutler\n" });
    expect(c.name).toBe("my-logbutler");
  });

  it("dry-run 用の EXAMPLE_ENV はそのまま検証を通る", () => {
    expect(renderWranglerConfig(BASE, EXAMPLE_ENV).ok).toBe(true);
  });
});

describe("renderWranglerConfig: 検証", () => {
  const REQUIRED = [
    "LOGBUTLER_WORKER_NAME",
    "LOGBUTLER_KV_NAMESPACE_ID",
    "LOGBUTLER_BACKLOG_SPACE_HOST",
    "LOGBUTLER_PUBLIC_BASE_URL",
  ] as const;

  for (const name of REQUIRED) {
    it(`${name} が未設定なら項目名つきの missing`, () => {
      const env: Record<string, string | undefined> = { ...VALID };
      delete env[name];
      expect(errorsOf(env)).toEqual([{ name, reason: "missing" }]);
    });
    it(`${name} が空文字でも missing`, () => {
      expect(errorsOf({ ...VALID, [name]: "" })).toEqual([{ name, reason: "missing" }]);
    });
  }

  it("複数の欠けをまとめて返す", () => {
    expect(errorsOf({}).map((e) => e.name)).toEqual([...REQUIRED]);
  });

  it.each([
    ["LOGBUTLER_PUBLIC_BASE_URL", "https://x.example.com/"],
    ["LOGBUTLER_PUBLIC_BASE_URL", "https://x.example.com/mcp"],
    ["LOGBUTLER_PUBLIC_BASE_URL", "http://x.example.com"],
    ["LOGBUTLER_PUBLIC_BASE_URL", "x.example.com"],
    ["LOGBUTLER_PUBLIC_BASE_URL", "https://x.example.com?a=1"],
    ["LOGBUTLER_KV_NAMESPACE_ID", "0123456789abcdef"],
    ["LOGBUTLER_KV_NAMESPACE_ID", "0123456789abcdef0123456789abcdeg"],
    ["LOGBUTLER_KV_NAMESPACE_ID", "0123456789abcdef0123456789abcdef0"],
    ["LOGBUTLER_BACKLOG_SPACE_HOST", "https://myspace.backlog.com"],
    ["LOGBUTLER_BACKLOG_SPACE_HOST", "myspace.backlog.com/"],
    ["LOGBUTLER_BACKLOG_SPACE_HOST", "myspace"],
    ["LOGBUTLER_WORKER_NAME", "My Worker"],
    ["LOGBUTLER_WORKER_NAME", "-bad"],
    ["LOGBUTLER_WORKER_NAME", "a".repeat(64)],
    ["LOGBUTLER_CUSTOM_DOMAIN", "https://logbutler.example.org"],
    ["LOGBUTLER_CUSTOM_DOMAIN", "logbutler.example.org/"],
  ])("%s の形式不正 (%s) は invalid", (name, value) => {
    expect(errorsOf({ ...VALID, [name]: value })).toEqual([{ name, reason: "invalid" }]);
  });

  it.each([
    ["LOGBUTLER_WORKER_NAME", "<name>"],
    ["LOGBUTLER_KV_NAMESPACE_ID", "<kv-id>"],
    ["LOGBUTLER_BACKLOG_SPACE_HOST", "<space>.backlog.com"],
    ["LOGBUTLER_PUBLIC_BASE_URL", "https://<domain>"],
    ["LOGBUTLER_CUSTOM_DOMAIN", "<domain>"],
  ])("%s にプレースホルダ (%s) が残っていれば placeholder", (name, value) => {
    expect(errorsOf({ ...VALID, [name]: value })).toEqual([{ name, reason: "placeholder" }]);
  });

  it("エラーに入力値を含めない", () => {
    const secretish = "SUPER-SECRET-VALUE-123";
    const errors = errorsOf({
      ...VALID,
      LOGBUTLER_KV_NAMESPACE_ID: secretish,
      LOGBUTLER_PUBLIC_BASE_URL: `https://${secretish}.example.com/`,
      LOGBUTLER_CUSTOM_DOMAIN: `<${secretish}>`,
    });
    expect(errors.length).toBe(3);
    expect(JSON.stringify(errors)).not.toContain(secretish);
  });

  it("元の wrangler.jsonc が壊れていれば例外ではなく base の項目で報告する", () => {
    const r = renderWranglerConfig("{ not json", VALID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual([{ name: "wrangler.jsonc", reason: "invalid" }]);
  });
});
