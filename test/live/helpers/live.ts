/**
 * 実環境(デプロイ済み Worker + 実 Backlog)に対する E2E のクライアント(`mise run test:live`)。
 *
 * - 認証は `verify:oauth` が保存した状態ファイルのリフレッシュトークン。接続時に更新し、
 *   ローテーション後の値を同じファイルへ 0600 で書き戻す。得たアクセストークンは使い回す。
 * - 実際の MCP クライアントと同じく、/mcp が 401 を返したら MCP のトークンを 1 回だけ更新して再試行する
 *   (Backlog 側の失効を Logbutler が 401 で伝え、更新で Backlog も更新させるため)。2 回目も 401 ならエラー。
 * - トークンは出力・エラーメッセージに出さない(redact)。応答にトークンが含まれていたら失敗にする。
 * - 呼び出しは直列(Backlog のレート制限のため)。呼び出し回数を数える。
 * - MCP 2026-07-28 レーン(`MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` ヘッダー)で呼ぶ。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PROTOCOL_VERSION = "2026-07-28";
const REQUEST_TIMEOUT_MS = 90_000;

export interface LiveConfig {
  projectKey: string;
  stateFile: string;
}

/** 環境変数から設定を読む。必須の LOGBUTLER_LIVE_PROJECT_KEY がなければ、黙らずに例外にする。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const projectKey = env.LOGBUTLER_LIVE_PROJECT_KEY?.trim();
  if (!projectKey) {
    throw new Error(
      "LOGBUTLER_LIVE_PROJECT_KEY が未設定。書き込みを許可したテスト用プロジェクトのキーを指定する" +
        "(例: LOGBUTLER_LIVE_PROJECT_KEY=LOGBUTLER mise run test:live)。このスイートは実 Backlog に書き込むため、既定値は置かない。",
    );
  }
  const stateFile = resolve(env.LOGBUTLER_LIVE_STATE_FILE?.trim() || ".verify-oauth.local.json");
  return { projectKey, stateFile };
}

export interface ConnectOptions {
  /** テスト用に差し替える fetch(既定は globalThis.fetch)。 */
  fetch?: typeof fetch;
}

interface State {
  mcpUrl: string;
  clientId: string;
  refreshToken: string;
  savedAt?: string;
}

export interface ToolCall {
  isError: boolean;
  text: string;
  /** text を JSON として読んだもの。読めなければ undefined。 */
  // biome-ignore lint/suspicious/noExplicitAny: 応答の形はテストごとに検証する
  data: any;
}

export interface RpcResult {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC 応答
  body: any;
  text: string;
}

export class LiveClient {
  readonly mcpUrl: URL;
  /** 呼んだツール名(カバレッジの確認用)。 */
  readonly called = new Set<string>();
  /** Worker への HTTP リクエスト数(トークン更新・tools/list・tools/call・その他)。 */
  requests = 0;
  /** tools/call の数。 */
  toolCalls = 0;
  private readonly secrets: string[] = [];

  private state: State;
  private accessToken = "";

  private constructor(
    state: State,
    private readonly stateFile: string,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.state = state;
    this.mcpUrl = new URL(state.mcpUrl);
    this.secrets.push(state.refreshToken, state.clientId);
  }

  static async connect(config: LiveConfig, opts: ConnectOptions = {}): Promise<LiveClient> {
    if (!existsSync(config.stateFile)) {
      throw new Error(
        `状態ファイルがない: ${config.stateFile}(先に mise run verify:oauth で認証し、LOGBUTLER_LIVE_STATE_FILE で場所を指定する)`,
      );
    }
    const state = JSON.parse(readFileSync(config.stateFile, "utf8")) as State;
    for (const k of ["mcpUrl", "clientId", "refreshToken"] as const) {
      if (typeof state[k] !== "string" || state[k] === "") {
        throw new Error(`状態ファイルに ${k} がない: ${config.stateFile}`);
      }
    }
    const client = new LiveClient(state, config.stateFile, opts.fetch ?? fetch);
    await client.refresh();
    return client;
  }

  /**
   * MCP のトークンを更新する。ローテーションした新しいリフレッシュトークンは、他の処理より先に
   * 状態ファイルへ 0600 で書き戻す(失うと以降の認証ができない)。
   */
  private async refresh(): Promise<void> {
    this.requests++;
    const origin = new URL(this.state.mcpUrl).origin;
    const res = await this.fetchImpl(`${origin}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.state.refreshToken,
        client_id: this.state.clientId,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      throw new Error(
        `トークン更新に失敗: HTTP ${res.status} ${body.error ?? ""} ${body.error_description ?? ""}`.trim(),
      );
    }
    if (body.refresh_token) {
      const next: State = {
        ...this.state,
        refreshToken: body.refresh_token,
        savedAt: new Date().toISOString(),
      };
      writeFileSync(this.stateFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      chmodSync(this.stateFile, 0o600);
      this.state = next;
      this.secrets.push(body.refresh_token);
    }
    this.accessToken = body.access_token;
    this.secrets.push(body.access_token);
  }

  /** メッセージからトークン類を伏せる。 */
  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) if (s) out = out.split(s).join("[REDACTED]");
    return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]");
  }

  /** 応答にトークンが含まれていないことを確かめる(含まれていたらその事実だけを例外にする)。 */
  private assertNoLeak(where: string, text: string): void {
    for (const s of [this.accessToken, this.state.refreshToken]) {
      if (s && text.includes(s)) throw new Error(`応答にトークンが含まれている: ${where}`);
    }
  }

  /** 任意のパスへ HTTP を送る(認証ヘッダーは options で制御)。 */
  async http(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string; auth?: boolean } = {},
  ): Promise<{ status: number; headers: Headers; text: string }> {
    this.requests++;
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.auth !== false) headers.Authorization = `Bearer ${this.accessToken}`;
    const res = await this.fetchImpl(new URL(path, this.mcpUrl.origin), {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "manual",
    });
    const text = await res.text();
    this.assertNoLeak(path, text);
    return { status: res.status, headers: res.headers, text };
  }

  /** JSON-RPC を 1 回送る。url を渡せば、その MCP エンドポイント(クエリ付きなど)へ送る。 */
  async rpc(
    method: string,
    params: Record<string, unknown> = {},
    opts: { url?: string; auth?: boolean; token?: string } = {},
  ): Promise<RpcResult> {
    const first = await this.rpcOnce(method, params, opts);
    // 自分のトークンで呼んだときだけ、401 で 1 回更新して再試行する(明示したトークン・認証なしは 401 自体を確かめる)。
    if (first.status !== 401 || opts.auth === false || opts.token !== undefined) return first;
    await this.refresh();
    return this.rpcOnce(method, params, opts);
  }

  private async rpcOnce(
    method: string,
    params: Record<string, unknown>,
    opts: { url?: string; auth?: boolean; token?: string },
  ): Promise<RpcResult> {
    this.requests++;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Method": method,
    };
    if (opts.auth !== false) headers.Authorization = `Bearer ${opts.token ?? this.accessToken}`;
    const name = params.name;
    if (method === "tools/call" && typeof name === "string") headers["Mcp-Name"] = name;
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const res = await this.fetchImpl(opts.url ?? this.mcpUrl.href, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "logbutler-live-e2e", version: "0.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
            ...meta,
          },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    this.assertNoLeak(`${method} ${name ?? ""}`, text);
    const payload = text.startsWith("{")
      ? text
      : text
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim();
    let body: unknown = null;
    try {
      body = payload ? JSON.parse(payload) : null;
    } catch {
      body = null;
    }
    return { status: res.status, headers: res.headers, body, text };
  }

  async listTools(url?: string): Promise<RpcResult> {
    return this.rpc("tools/list", {}, url ? { url } : {});
  }

  /** ツールを呼ぶ。JSON-RPC エラー・HTTP エラーは例外にする(ツールの isError は結果として返す)。 */
  async call(
    name: string,
    args: Record<string, unknown> = {},
    opts: { url?: string; meta?: Record<string, unknown> } = {},
  ): Promise<ToolCall> {
    this.called.add(name);
    this.toolCalls++;
    const r = await this.rpc(
      "tools/call",
      { name, arguments: args, ...(opts.meta ? { _meta: opts.meta } : {}) },
      opts.url ? { url: opts.url } : {},
    );
    if (r.status !== 200 || !r.body || r.body.error || !r.body.result) {
      const detail = r.body?.error ? JSON.stringify(r.body.error) : r.text.slice(0, 300);
      throw new Error(`${name}: 呼び出しに失敗 HTTP ${r.status} ${this.redact(detail)}`);
    }
    const content = r.body.result.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.find((c) => c.type === "text")?.text ?? "";
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    return { isError: r.body.result.isError === true, text, data };
  }

  /** 成功を期待して呼ぶ。isError ならエラーエンベロープを添えて失敗させる。 */
  async ok(
    name: string,
    args: Record<string, unknown> = {},
    opts?: Parameters<LiveClient["call"]>[2],
  ) {
    const r = await this.call(name, args, opts);
    if (r.isError) {
      throw new Error(`${name} がエラーを返した: ${this.redact(r.text.slice(0, 600))}`);
    }
    if (r.data === undefined) {
      throw new Error(`${name} の応答が JSON として読めない: ${this.redact(r.text.slice(0, 200))}`);
    }
    return r.data;
  }
}

/** spec §9 のエラーエンベロープを期待する。 */
export function errorOf(r: ToolCall): { code: string; message: string; retryable: boolean } | null {
  if (!r.isError || !r.data || r.data.schema_version !== "1" || typeof r.data.error !== "object") {
    return null;
  }
  return r.data.error;
}

/** 実行ごとの目印。課題の summary に `[live <時刻>]` を付ける。 */
export const RUN_STAMP = new Date().toISOString().replace(/\.\d+Z$/, "Z");
export const MARK = `[live ${RUN_STAMP}]`;

/**
 * Backlog の名前の長さ上限(文字数)。公式 docs に記載はなく、2026-10-29 に実 Backlog で 1 文字ずつ確認した値。
 * 超えると `HTTP 400 code=7 error.maxLength : name`。Logbutler 本体(src)は長さを検証せず Backlog の応答に任せる。
 */
export const NAME_LIMITS = { category: 40, version: 40, milestone: 40, status: 20 } as const;

/**
 * カテゴリー・バージョン・状態など「名前に上限がある作成物」に付ける短い実行の印(`lv` + 実行時刻の HHMMSS = 8 文字)。
 * 例 `lv041003 category renamed`。課題の summary・ドキュメントのタイトルは長くてよいので MARK のまま。
 */
export const NAME_MARK = `lv${RUN_STAMP.slice(11, 19).replaceAll(":", "")}`;
