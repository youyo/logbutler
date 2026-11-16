// upstream の wrangler.jsonc と環境変数から、デプロイ用の wrangler 設定(フラット)を作る純粋なコア(ADR 0011)。
// 入出力(ファイル・process.env)は main.ts が担う。ここは文字列とオブジェクトだけを扱う。
// 検証エラーには項目名と理由だけを載せ、入力値は決して載せない。
// 差し替えるのは name・OAUTH_KV の id・vars の 2 つ・routes / workers_dev と、R2 の UPLOAD_BUCKET(任意。名前が無ければ要素ごと除く。ADR 0018)。

export type ErrorReason = "missing" | "invalid" | "placeholder";
export interface RenderError {
  name: string;
  reason: ErrorReason;
}
export type RenderResult =
  | { ok: true; config: Record<string, unknown>; text: string }
  | { ok: false; errors: RenderError[] };

export const ENV_NAMES = {
  workerName: "LOGBUTLER_WORKER_NAME",
  kvNamespaceId: "LOGBUTLER_KV_NAMESPACE_ID",
  spaceHost: "LOGBUTLER_BACKLOG_SPACE_HOST",
  publicBaseUrl: "LOGBUTLER_PUBLIC_BASE_URL",
  customDomain: "LOGBUTLER_CUSTOM_DOMAIN",
  uploadBucketName: "LOGBUTLER_UPLOAD_BUCKET_NAME",
} as const;

/** `deploy:check`(dry-run)用のダミー。実在しない値で、Cloudflare には届かない。 */
export const EXAMPLE_ENV: Record<string, string> = {
  LOGBUTLER_WORKER_NAME: "logbutler-example",
  LOGBUTLER_KV_NAMESPACE_ID: "00000000000000000000000000000000",
  LOGBUTLER_BACKLOG_SPACE_HOST: "example.backlog.com",
  LOGBUTLER_PUBLIC_BASE_URL: "https://logbutler.example.com",
  LOGBUTLER_CUSTOM_DOMAIN: "logbutler.example.com",
  LOGBUTLER_UPLOAD_BUCKET_NAME: "logbutler-uploads-example",
};

const KV_BINDING = "OAUTH_KV";
/** 添付アップロードの URL 経路の R2(任意。ADR 0018)。 */
const UPLOAD_BUCKET_BINDING = "UPLOAD_BUCKET";
/** R2 のバケット名: 小文字・数字・ハイフン、3〜63 文字、先頭と末尾は英数字。 */
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const PLACEHOLDER = /<[^>]*>/;
const WORKER_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const KV_ID = /^[0-9a-f]{32}$/i;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** JSONC(コメント・末尾カンマ)を読む。文字列の中の `//` や `/*` は壊さない。 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(removeTrailingCommas(stripComments(text)));
}

function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      out += text.slice(start, i);
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      out += text.slice(start, i);
    } else if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      if (text[j] !== "}" && text[j] !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function isValidBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // https のオリジンだけ。末尾スラッシュ・パス・クエリ・フラグメント・大文字ホストは不可。
  return url.protocol === "https:" && url.origin === value;
}

type Validator = (v: string) => boolean;

export function renderWranglerConfig(
  baseText: string,
  env: Record<string, string | undefined>,
): RenderResult {
  const errors: RenderError[] = [];

  const read = (name: string, valid: Validator, required: boolean): string | undefined => {
    const raw = env[name]?.trim() ?? "";
    if (raw === "") {
      if (required) errors.push({ name, reason: "missing" });
      return undefined;
    }
    if (PLACEHOLDER.test(raw)) errors.push({ name, reason: "placeholder" });
    else if (!valid(raw)) errors.push({ name, reason: "invalid" });
    else return raw;
    return undefined;
  };

  const workerName = read(ENV_NAMES.workerName, (v) => WORKER_NAME.test(v), true);
  const kvId = read(ENV_NAMES.kvNamespaceId, (v) => KV_ID.test(v), true);
  const spaceHost = read(ENV_NAMES.spaceHost, (v) => HOSTNAME.test(v), true);
  const baseUrl = read(ENV_NAMES.publicBaseUrl, isValidBaseUrl, true);
  const customDomain = read(ENV_NAMES.customDomain, (v) => HOSTNAME.test(v), false);
  const uploadBucket = read(ENV_NAMES.uploadBucketName, (v) => BUCKET_NAME.test(v), false);

  let base: Record<string, unknown> | undefined;
  try {
    const parsed = parseJsonc(baseText);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      base = parsed as Record<string, unknown>;
    }
  } catch {
    // 下で報告する
  }
  if (!base) errors.push({ name: "wrangler.jsonc", reason: "invalid" });

  if (errors.length > 0 || !base) return { ok: false, errors };

  // env ブロックは持ち越さない(フラットな設定にする)。
  const { env: _env, routes: _routes, ...rest } = base;
  const config: Record<string, unknown> = { ...rest, name: workerName };

  const kv = Array.isArray(rest.kv_namespaces)
    ? (rest.kv_namespaces as Record<string, unknown>[])
    : [];
  const hasBinding = kv.some((e) => e.binding === KV_BINDING);
  const replaced = kv.map((e) => (e.binding === KV_BINDING ? { ...e, id: kvId } : e));
  config.kv_namespaces = hasBinding ? replaced : [...replaced, { binding: KV_BINDING, id: kvId }];

  const vars = (typeof rest.vars === "object" && rest.vars !== null ? rest.vars : {}) as Record<
    string,
    unknown
  >;
  config.vars = { ...vars, BACKLOG_SPACE_HOST: spaceHost, PUBLIC_BASE_URL: baseUrl };

  // R2 の UPLOAD_BUCKET は任意(ADR 0018)。名前があれば差し替え、無ければ要素ごと取り除く
  // (ADR 0011 の「それ以外はそのまま届く」への例外。ダミー名のバケットを下流にデプロイさせない)。
  const r2 = Array.isArray(rest.r2_buckets) ? (rest.r2_buckets as Record<string, unknown>[]) : [];
  const others = r2.filter((e) => e.binding !== UPLOAD_BUCKET_BINDING);
  if (uploadBucket) {
    const hasUpload = r2.some((e) => e.binding === UPLOAD_BUCKET_BINDING);
    config.r2_buckets = hasUpload
      ? r2.map((e) =>
          e.binding === UPLOAD_BUCKET_BINDING ? { ...e, bucket_name: uploadBucket } : e,
        )
      : [...r2, { binding: UPLOAD_BUCKET_BINDING, bucket_name: uploadBucket }];
  } else if (others.length > 0) {
    config.r2_buckets = others;
  } else {
    delete config.r2_buckets;
  }

  if (customDomain) {
    config.routes = [{ pattern: customDomain, custom_domain: true }];
    config.workers_dev = false;
  } else {
    config.workers_dev = true;
  }

  return { ok: true, config, text: `${JSON.stringify(config, null, 2)}\n` };
}

/** 標準エラー用。項目名と理由だけ(値は含めない)。 */
export function formatErrors(errors: RenderError[]): string[] {
  const label: Record<ErrorReason, string> = {
    missing: "未設定",
    invalid: "形式が正しくない",
    placeholder: "プレースホルダ(<...>)のまま",
  };
  return errors.map((e) => `${e.name}: ${label[e.reason]}`);
}
