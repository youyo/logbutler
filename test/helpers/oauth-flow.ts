import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import { jsonResponse, mockOutboundFetch, type RecordedCall } from "./mock-fetch";

export const ORIGIN = "https://logbutler.test";
export const MCP_URL = `${ORIGIN}/mcp`;
export const CLIENT_REDIRECT = "https://client.example/cb";
export const BACKLOG_HOST = "https://example.backlog.com";
export const BACKLOG_TOKEN = `POST ${BACKLOG_HOST}/api/v2/oauth2/token`;
export const BACKLOG_MYSELF = `GET ${BACKLOG_HOST}/api/v2/users/myself`;

// wrangler.jsonc の main (src/index.ts) の default export。Worker 全体への HTTP 入口(SELF.fetch 相当)。
const entry = exports as unknown as { default: Fetcher };

export const worker = {
  fetch: (url: string, init: RequestInit = {}) =>
    entry.default.fetch(url, { redirect: "manual", ...init }),
};

/**
 * OAuth の通しを流す相手(Worker の入口と、その公開 URL のオリジン)。既定はテストの wrangler 設定の Worker。
 * env を変えた Worker(`import worker from "../../src/index"` に別の env を渡す)で通すときに差し替える。
 */
export interface FlowTarget {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** PUBLIC_BASE_URL と同じオリジン。`/mcp` がリソース識別子になる。 */
  origin: string;
}
export const DEFAULT_TARGET: FlowTarget = { fetch: worker.fetch, origin: ORIGIN };

/** Backlog の outbound fetch モックを用意する。 */
export async function setupMocks(
  opts: {
    backlogToken?: (call: RecordedCall) => Response;
    /** Backlog スペースのオリジン(既定 BACKLOG_HOST)。env の BACKLOG_SPACE_HOST を変えた Worker 用。 */
    backlogHost?: string;
    /** /users/myself の応答(既定は alice)。 */
    myself?: Record<string, unknown>;
  } = {},
) {
  const host = opts.backlogHost ?? BACKLOG_HOST;
  const backlogToken =
    opts.backlogToken ??
    (() =>
      jsonResponse({
        access_token: "backlog-at-1",
        refresh_token: "backlog-rt-1",
        token_type: "Bearer",
        expires_in: 3600,
      }));
  const mocks = mockOutboundFetch({
    [`POST ${host}/api/v2/oauth2/token`]: (call) => backlogToken(call),
    [`GET ${host}/api/v2/users/myself`]: (call) =>
      call.headers.get("authorization") === "Bearer backlog-at-1" ||
      call.headers.get("authorization")?.startsWith("Bearer backlog-at-")
        ? jsonResponse(
            opts.myself ?? {
              id: 42,
              userId: "alice",
              name: "Alice",
              mailAddress: "alice@example.com",
            },
          )
        : jsonResponse({}, 401),
  });
  return mocks;
}

/** Set-Cookie を Cookie ヘッダーに畳む最小のジャー。 */
export class CookieJar {
  private cookies = new Map<string, string>();
  update(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (/;\s*max-age=0/i.test(line) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function pkcePair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export async function registerClient(
  clientName = "Test MCP Client",
  target: FlowTarget = DEFAULT_TARGET,
): Promise<string> {
  const res = await target.fetch(`${target.origin}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

/** /register → /authorize(同意)→ Backlog(モック)→ /callback → /token を通しで行う。 */
export async function runAuthorizationFlow(target: FlowTarget = DEFAULT_TARGET) {
  const { origin } = target;
  const clientId = await registerClient(undefined, target);
  const { verifier, challenge } = await pkcePair();
  const jar = new CookieJar();

  const authorizeUrl = new URL(`${origin}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    state: "client-state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  }).toString();

  const consent = await target.fetch(authorizeUrl.toString());
  expect(consent.status).toBe(200);
  jar.update(consent);
  const html = await consent.clone().text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  expect(handle).not.toBe("");

  const backlogRedirect = await target.fetch(`${origin}/authorize`, {
    method: "POST",
    headers: {
      Cookie: jar.header(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ handle, decision: "approve" }),
  });
  jar.update(backlogRedirect);
  const backlogLocation = backlogRedirect.headers.get("Location") ?? "";
  const state = new URL(backlogLocation, origin).searchParams.get("state") ?? "";

  const callbackResponse = await target.fetch(
    `${origin}/callback?code=backlog-code&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: jar.header() } },
  );
  const back = callbackResponse.headers.get("Location") ?? "";
  const clientCode = new URL(back, origin).searchParams.get("code") ?? "";

  const tokenResponse = await target.fetch(`${origin}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: clientCode,
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }),
  });

  return { clientId, consent, html, backlogRedirect, callbackResponse, tokenResponse, clientCode };
}

export function mcpRequest(
  accessToken: string | null,
  method: string,
  params: Record<string, unknown> = {},
  url: string = MCP_URL,
  fetch: FlowTarget["fetch"] = worker.fetch,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

export interface RpcResponse {
  result?: {
    tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[];
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

/** tools/call の最初の text content を取り出す。 */
export function firstText(rpc: RpcResponse): string {
  return rpc.result?.content?.[0]?.text ?? "";
}

export async function readRpc(res: Response): Promise<RpcResponse> {
  const text = await res.text();
  const data = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim();
  return JSON.parse(data ?? "null");
}

export const MODERN_VERSION = "2026-07-28";

/**
 * MCP 2026-07-28 レーンのリクエスト(initialize なし)。ルーティング用ヘッダー(MCP-Protocol-Version / Mcp-Method /
 * Mcp-Name)と、params._meta のプロトコルバージョン・クライアント情報・機能を付ける。
 * `headers` の値が null のヘッダーは外す(欠落のテスト用)。`meta` で _meta を上書きできる。
 */
export function modernRequest(
  accessToken: string | null,
  method: string,
  params: Record<string, unknown> = {},
  opts: {
    url?: string;
    headers?: Record<string, string | null>;
    meta?: Record<string, unknown>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MODERN_VERSION,
    "Mcp-Method": method,
    ...(typeof params.name === "string" && method === "tools/call"
      ? { "Mcp-Name": params.name }
      : {}),
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  return worker.fetch(opts.url ?? MCP_URL, {
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
          "io.modelcontextprotocol/clientInfo": { name: "logbutler-e2e", version: "0.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
          ...opts.meta,
        },
      },
    }),
  });
}
