/**
 * verify:oauth の中核。実環境(ユーザーが用意する検証環境)で Logbutler の OAuth を確かめる、小さな MCP クライアント。
 * Web 標準 API(fetch / crypto / URL)だけを使い、入出力(fetch・ブラウザ・ループバック受信・状態の保存・ログ)は VerifyIo で受け取る。
 * そのため workerd 上の E2E テストから、Worker とモック Backlog に対してそのまま動かせる(test/e2e/verify-oauth.test.ts)。
 * 実際の入出力は main.ts / loopback.ts。
 *
 * トークンは出力しない(maskToken で先頭数文字だけ)。
 */

export interface CallbackReceiver {
  /** DCR に登録し、認可リクエストの redirect_uri に使う URL(http://127.0.0.1:<port>/callback)。 */
  redirectUri: string;
  /** ブラウザが戻ってきたときのリダイレクト先 URL 全体(クエリつき)を返す。 */
  wait(): Promise<string>;
  close(): void;
}

/** --refresh-only 用に保存する状態。リフレッシュトークンを含むので、gitignore 済みのローカルファイルに置く。 */
export interface SavedState {
  mcpUrl: string;
  clientId: string;
  refreshToken: string;
  savedAt: string;
}

export interface VerifyIo {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  log(line: string): void;
  /** ブラウザのリダイレクトを受ける準備をする(DCR の前に呼ばれる)。 */
  startReceiver(): Promise<CallbackReceiver>;
  /** 認可 URL をブラウザで開く。 */
  openBrowser(url: string): Promise<void> | void;
  loadState(): Promise<SavedState | undefined>;
  saveState(state: SavedState): Promise<void>;
}

export interface VerifyOptions {
  /** 例 https://<domain>/mcp。クエリ(?toolsets=...&read_only=true)つきでもよい。 */
  mcpUrl: string;
  refreshOnly: boolean;
}

export type StepName =
  | "metadata"
  | "register"
  | "authorize"
  | "token"
  | "tools_list"
  | "user_me"
  | "refresh"
  | "user_me_after_refresh";

export interface StepResult {
  name: StepName;
  ok: boolean;
  detail: string;
}

export interface VerifyFacts {
  issuer?: string;
  toolCount?: number;
  userId?: number;
  tokenExpiresInSeconds?: number;
  accessTokenChangedOnRefresh?: boolean;
  refreshTokenRotated?: boolean;
  refreshedExpiresInSeconds?: number;
}

export interface VerifyReport {
  ok: boolean;
  steps: StepResult[];
  facts: VerifyFacts;
}

const MODERN_VERSION = "2026-07-28";
const CLIENT_NAME = "logbutler verify:oauth";
const USER_ME_TOOL = "logbutler_user_me";

/** トークンは先頭 4 文字と長さだけ。 */
export function maskToken(token: string): string {
  return `${token.slice(0, 4)}…(${token.length}文字)`;
}

class StepError extends Error {}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** サーバーのエラー応答から、人に見せてよい部分(error / error_description)だけを取り出す。 */
function describeError(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    const parts = [body.error, body.error_description].filter((v) => typeof v === "string");
    if (parts.length > 0) return `HTTP ${status} ${parts.join(": ").slice(0, 200)}`;
  } catch {
    // JSON でない応答は本文を出さない。
  }
  return `HTTP ${status}`;
}

async function getJson(io: VerifyIo, url: string, init?: RequestInit) {
  const res = await io.fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new StepError(`${describeError(res.status, text)} (${url})`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new StepError(`JSON として読めない応答 (${url})`);
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function postToken(
  io: VerifyIo,
  tokenEndpoint: string,
  form: Record<string, string>,
): Promise<TokenResponse> {
  const body = await getJson(io, tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  if (typeof body.access_token !== "string") throw new StepError("応答に access_token がない");
  return {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expires_in: typeof body.expires_in === "number" ? body.expires_in : undefined,
  };
}

/** MCP 2026-07-28 レーン(initialize なし)で JSON-RPC を 1 件送る。 */
async function modernRpc(
  io: VerifyIo,
  mcpUrl: string,
  accessToken: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MODERN_VERSION,
    "Mcp-Method": method,
    Authorization: `Bearer ${accessToken}`,
  };
  if (method === "tools/call" && typeof params.name === "string") headers["Mcp-Name"] = params.name;
  const res = await io.fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
          "io.modelcontextprotocol/clientInfo": {
            name: "logbutler-verify-oauth",
            version: "0.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new StepError(`${describeError(res.status, text)} (${method})`);
  const data = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim();
  let rpc: { result?: Record<string, unknown>; error?: { code?: number; message?: string } };
  try {
    rpc = JSON.parse(data ?? "null");
  } catch {
    throw new StepError(`${method} の応答を JSON として読めない`);
  }
  if (rpc?.error)
    throw new StepError(`${method} が JSON-RPC エラー ${rpc.error.code}: ${rpc.error.message}`);
  return rpc?.result ?? {};
}

async function callUserMe(io: VerifyIo, mcpUrl: string, accessToken: string) {
  const result = await modernRpc(io, mcpUrl, accessToken, "tools/call", {
    name: USER_ME_TOOL,
    arguments: {},
  });
  const text = (result.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
  if (result.isError) {
    let code = "不明";
    try {
      code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? code;
    } catch {}
    throw new StepError(`${USER_ME_TOOL} がエラーを返した (error.code=${code})`);
  }
  let me: { id?: number; name?: string };
  try {
    me = JSON.parse(text);
  } catch {
    throw new StepError(`${USER_ME_TOOL} の結果を JSON として読めない`);
  }
  if (typeof me.id !== "number") throw new StepError(`${USER_ME_TOOL} の結果に id がない`);
  return { id: me.id, name: me.name };
}

export async function runVerification(opts: VerifyOptions, io: VerifyIo): Promise<VerifyReport> {
  const steps: StepResult[] = [];
  const facts: VerifyFacts = {};
  const mcp = new URL(opts.mcpUrl);
  const canonicalResource = `${mcp.origin}${mcp.pathname}`;

  /** 1 段階を実行して記録する。失敗したら false(以降の段階は実行しない)。 */
  async function step(name: StepName, fn: () => Promise<string>): Promise<boolean> {
    try {
      const detail = await fn();
      steps.push({ name, ok: true, detail });
      io.log(`[OK]   ${name}: ${detail}`);
      return true;
    } catch (e) {
      const detail = e instanceof Error ? e.message : "不明なエラー";
      steps.push({ name, ok: false, detail });
      io.log(`[失敗] ${name}: ${detail}`);
      return false;
    }
  }
  const finish = (): VerifyReport => ({
    ok: steps.length > 0 && steps.every((s) => s.ok),
    steps,
    facts,
  });

  // --- 1. メタデータ(RFC 9728 → RFC 8414) ---
  let authzEndpoint = "";
  let tokenEndpoint = "";
  let registrationEndpoint = "";
  let issuer = "";
  let issParamSupported = false;
  let resource = canonicalResource;
  const metadataOk = await step("metadata", async () => {
    const prm = await getJson(
      io,
      `${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname}`,
    );
    if (prm.resource !== canonicalResource) {
      throw new StepError(
        `保護リソースメタデータの resource (${String(prm.resource)}) が接続先 (${canonicalResource}) と違う。PUBLIC_BASE_URL を確認`,
      );
    }
    resource = prm.resource;
    const servers = prm.authorization_servers;
    const first = Array.isArray(servers) ? servers[0] : undefined;
    if (typeof first !== "string") throw new StepError("authorization_servers がない");
    const as = await getJson(
      io,
      `${first.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`,
    );
    if (as.issuer !== first) {
      throw new StepError(
        `認可サーバーの issuer (${String(as.issuer)}) が authorization_servers (${first}) と違う`,
      );
    }
    for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
      if (typeof as[key] !== "string")
        throw new StepError(`認可サーバーのメタデータに ${key} がない`);
    }
    const methods = as.code_challenge_methods_supported;
    if (!Array.isArray(methods) || !methods.includes("S256")) {
      throw new StepError("認可サーバーが PKCE S256 を宣言していない");
    }
    issuer = first;
    authzEndpoint = as.authorization_endpoint as string;
    tokenEndpoint = as.token_endpoint as string;
    registrationEndpoint = as.registration_endpoint as string;
    issParamSupported = as.authorization_response_iss_parameter_supported === true;
    facts.issuer = issuer;
    return `issuer=${issuer} resource=${resource} (iss 応答: ${issParamSupported ? "宣言あり" : "宣言なし"})`;
  });
  if (!metadataOk) return finish();

  let clientId = "";
  let accessToken = "";
  let refreshToken = "";

  if (!opts.refreshOnly) {
    const receiver = await io.startReceiver();
    try {
      // --- 2. DCR ---
      const registered = await step("register", async () => {
        const body = await getJson(io, registrationEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: CLIENT_NAME,
            application_type: "native",
            redirect_uris: [receiver.redirectUri],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          }),
        });
        if (typeof body.client_id !== "string") throw new StepError("応答に client_id がない");
        clientId = body.client_id;
        return `client_id=${clientId} redirect_uri=${receiver.redirectUri}`;
      });
      if (!registered) return finish();

      // --- 3. 認可(PKCE S256。人がブラウザで Backlog のログインと同意をする) ---
      const { verifier, challenge } = await pkcePair();
      const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
      let code = "";
      const authorized = await step("authorize", async () => {
        const authUrl = new URL(authzEndpoint);
        for (const [k, v] of Object.entries({
          response_type: "code",
          client_id: clientId,
          redirect_uri: receiver.redirectUri,
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
          resource,
        })) {
          authUrl.searchParams.set(k, v);
        }
        io.log("ブラウザで次の URL を開き、Backlog でログインして同意してください:");
        io.log(authUrl.toString());
        await io.openBrowser(authUrl.toString());
        let back: URL;
        try {
          back = new URL(await receiver.wait());
        } catch (e) {
          throw new StepError(e instanceof Error ? e.message : "ブラウザの応答を受け取れなかった");
        }
        if (`${back.origin}${back.pathname}` !== receiver.redirectUri) {
          throw new StepError("コールバックの宛先が登録した redirect_uri と違う");
        }
        const p = back.searchParams;
        if (p.get("state") !== state) {
          throw new StepError("コールバックの state が送ったものと一致しない(CSRF の疑い)");
        }
        const iss = p.get("iss");
        if (iss === null ? issParamSupported : iss !== issuer) {
          throw new StepError(
            iss === null
              ? "コールバックに iss がない(メタデータは iss の返却を宣言している)"
              : `コールバックの iss (${iss}) が issuer (${issuer}) と一致しない(RFC 9207)`,
          );
        }
        const error = p.get("error");
        if (error) {
          throw new StepError(
            `認可が拒否された error=${error}${p.get("error_description") ? ` (${p.get("error_description")})` : ""}`,
          );
        }
        const c = p.get("code");
        if (!c) throw new StepError("コールバックに code がない");
        code = c;
        return "state と iss を検証し、認可コードを受け取った";
      });
      if (!authorized) return finish();

      // --- 4. /token ---
      const tokenOk = await step("token", async () => {
        const t = await postToken(io, tokenEndpoint, {
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: receiver.redirectUri,
          code_verifier: verifier,
          resource,
        });
        accessToken = t.access_token;
        refreshToken = t.refresh_token ?? "";
        facts.tokenExpiresInSeconds = t.expires_in;
        if (!refreshToken) throw new StepError("応答に refresh_token がない");
        await io.saveState({
          mcpUrl: opts.mcpUrl,
          clientId,
          refreshToken,
          savedAt: new Date().toISOString(),
        });
        return `access_token=${maskToken(accessToken)} refresh_token=${maskToken(refreshToken)} expires_in=${t.expires_in}秒`;
      });
      if (!tokenOk) return finish();

      // --- 5. MCP 2026-07-28 レーン: tools/list・user_me ---
      const listed = await step("tools_list", async () => {
        const result = await modernRpc(io, opts.mcpUrl, accessToken, "tools/list");
        const tools = result.tools as unknown[] | undefined;
        if (!Array.isArray(tools) || tools.length === 0) throw new StepError("tools が空");
        facts.toolCount = tools.length;
        return `${tools.length} 個のツール`;
      });
      if (!listed) return finish();
      const meOk = await step("user_me", async () => {
        const me = await callUserMe(io, opts.mcpUrl, accessToken);
        facts.userId = me.id;
        return `${USER_ME_TOOL}: id=${me.id}${me.name ? ` name=${me.name}` : ""}`;
      });
      if (!meOk) return finish();
    } finally {
      receiver.close();
    }
  } else {
    // --refresh-only: 保存済みの状態から更新だけを試す(ブラウザも DCR も使わない)。
    const saved = await io.loadState();
    const problem = !saved
      ? "保存済みの状態がない。先に --refresh-only なしで実行し、ブラウザで認可して状態を保存してください"
      : saved.mcpUrl !== opts.mcpUrl
        ? `保存済みの状態は別の URL (${saved.mcpUrl}) のもの。この URL で先にフル検証を実行してください`
        : undefined;
    if (problem || !saved) {
      steps.push({ name: "refresh", ok: false, detail: problem ?? "" });
      io.log(`[失敗] refresh: ${problem}`);
      return finish();
    }
    clientId = saved.clientId;
    refreshToken = saved.refreshToken;
  }

  // --- 6. refresh ---
  const previousAccess = accessToken;
  const previousRefresh = refreshToken;
  const refreshed = await step("refresh", async () => {
    const t = await postToken(io, tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: previousRefresh,
      client_id: clientId,
    });
    accessToken = t.access_token;
    facts.refreshedExpiresInSeconds = t.expires_in;
    facts.accessTokenChangedOnRefresh = previousAccess ? accessToken !== previousAccess : undefined;
    facts.refreshTokenRotated =
      t.refresh_token !== undefined && t.refresh_token !== previousRefresh;
    const nextRefresh = t.refresh_token ?? previousRefresh;
    await io.saveState({
      mcpUrl: opts.mcpUrl,
      clientId,
      refreshToken: nextRefresh,
      savedAt: new Date().toISOString(),
    });
    return `access_token=${maskToken(accessToken)} expires_in=${t.expires_in}秒 リフレッシュトークンは${facts.refreshTokenRotated ? "ローテーションした" : "同じものが続く"}`;
  });
  if (!refreshed) return finish();

  await step("user_me_after_refresh", async () => {
    const me = await callUserMe(io, opts.mcpUrl, accessToken);
    facts.userId = me.id;
    return `更新後のアクセストークンで ${USER_ME_TOOL}: id=${me.id}`;
  });
  return finish();
}

export function formatReport(report: VerifyReport): string[] {
  const { facts } = report;
  const lines = [`verify:oauth の結果: ${report.ok ? "すべて成功" : "失敗あり"}`];
  for (const s of report.steps) lines.push(`  ${s.name}: ${s.ok ? "OK" : "NG"} - ${s.detail}`);
  if (facts.issuer) lines.push(`issuer: ${facts.issuer}`);
  if (facts.toolCount !== undefined) lines.push(`ツール数: ${facts.toolCount}`);
  if (facts.tokenExpiresInSeconds !== undefined) {
    lines.push(`MCP アクセストークンの有効期限(expires_in): ${facts.tokenExpiresInSeconds} 秒`);
  }
  if (facts.refreshedExpiresInSeconds !== undefined) {
    lines.push(`更新後の有効期限(expires_in): ${facts.refreshedExpiresInSeconds} 秒`);
  }
  if (facts.accessTokenChangedOnRefresh !== undefined) {
    lines.push(
      `リフレッシュでアクセストークンが${facts.accessTokenChangedOnRefresh ? "変わった" : "変わらなかった"}`,
    );
  }
  if (facts.refreshTokenRotated !== undefined) {
    lines.push(
      `MCP のリフレッシュトークンは${facts.refreshTokenRotated ? "ローテーションした(新しいものに差し替わった)" : "ローテーションしなかった(同じものが続く)"}`,
    );
  }
  lines.push(
    "注意: Backlog 側のリフレッシュトークンのローテーションは、この CLI からは見えない(Worker 内部の挙動)。docs/manual-verification.md を参照。",
  );
  return lines;
}
