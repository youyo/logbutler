/**
 * 起動時の設定チェック(ADR 0010)。必須の vars / secrets / KV が欠けている、
 * またはプレースホルダ(`<...>`)のまま・形式が違う場合に、項目名だけを返す。値は結果にも例外にも載せない。
 */
export interface ConfigCheckResult {
  ok: boolean;
  /** 未設定(未定義・空・KV でない)の項目名。 */
  missing: string[];
  /** 設定されているが使えない(プレースホルダのまま・形式違い)項目名。 */
  invalid: string[];
}

const PLACEHOLDER = /<[^>]*>/;
const SPACE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/i;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

function isKvNamespace(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { get?: unknown }).get === "function" &&
    typeof (value as { put?: unknown }).put === "function"
  );
}

/** PUBLIC_BASE_URL は https のオリジンだけ(ローカル開発の loopback は http も可)。パス・クエリ・フラグメントは不可。 */
function isValidBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const schemeOk =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  return schemeOk && url.pathname === "/" && url.search === "" && url.hash === "";
}

export function checkConfig(env: Record<string, unknown>): ConfigCheckResult {
  const missing: string[] = [];
  const invalid: string[] = [];

  if (!isKvNamespace(env.OAUTH_KV)) missing.push("OAUTH_KV");

  const text = (name: string, valid?: (v: string) => boolean) => {
    const value = env[name];
    if (isBlank(value)) {
      missing.push(name);
      return;
    }
    const v = (value as string).trim();
    if (PLACEHOLDER.test(v) || (valid && !valid(v))) invalid.push(name);
  };
  text("BACKLOG_SPACE_HOST", (v) => SPACE_HOST.test(v));
  text("PUBLIC_BASE_URL", isValidBaseUrl);
  text("BACKLOG_CLIENT_ID");
  text("BACKLOG_CLIENT_SECRET");

  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}
