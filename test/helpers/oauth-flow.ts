import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import { createTestKey, jwksResponse, signAccessJwt, type TestKey } from "./access";
import { jsonResponse, mockOutboundFetch, type RecordedCall } from "./mock-fetch";

export const ORIGIN = "https://logbutler.test";
export const MCP_URL = `${ORIGIN}/mcp`;
export const CLIENT_REDIRECT = "https://client.example/cb";
export const BACKLOG_HOST = "https://example.backlog.com";
export const BACKLOG_TOKEN = `POST ${BACKLOG_HOST}/api/v2/oauth2/token`;
export const BACKLOG_MYSELF = `GET ${BACKLOG_HOST}/api/v2/users/myself`;
export const ACCESS_CERTS = "GET https://logbutler-test.cloudflareaccess.com/cdn-cgi/access/certs";

// wrangler.jsonc の main (src/index.ts) の default export。Worker 全体への HTTP 入口(SELF.fetch 相当)。
const entry = exports as unknown as { default: Fetcher };

export const worker = {
  fetch: (url: string, init: RequestInit = {}) =>
    entry.default.fetch(url, { redirect: "manual", ...init }),
};

/** Backlog と Access JWKS の outbound fetch モックを用意する。 */
export async function setupMocks(opts: { backlogToken?: (call: RecordedCall) => Response } = {}) {
  const accessKey: TestKey = await createTestKey("access-kid");
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
    [ACCESS_CERTS]: () => jwksResponse(accessKey),
    [BACKLOG_TOKEN]: (call) => backlogToken(call),
    [BACKLOG_MYSELF]: (call) =>
      call.headers.get("authorization") === "Bearer backlog-at-1" ||
      call.headers.get("authorization")?.startsWith("Bearer backlog-at-")
        ? jsonResponse({ id: 42, userId: "alice", name: "Alice", mailAddress: "alice@example.com" })
        : jsonResponse({}, 401),
  });
  return { accessKey, ...mocks };
}

export async function accessHeaders(key: TestKey, email = "alice@example.com") {
  return { "Cf-Access-Jwt-Assertion": await signAccessJwt(key, { email }) };
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

export async function registerClient(clientName = "Test MCP Client"): Promise<string> {
  const res = await worker.fetch(`${ORIGIN}/register`, {
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
export async function runAuthorizationFlow(access: Record<string, string>) {
  const clientId = await registerClient();
  const { verifier, challenge } = await pkcePair();
  const jar = new CookieJar();

  const authorizeUrl = new URL(`${ORIGIN}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    state: "client-state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_URL,
  }).toString();

  const consent = await worker.fetch(authorizeUrl.toString(), { headers: access });
  expect(consent.status).toBe(200);
  jar.update(consent);
  const html = await consent.clone().text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  expect(handle).not.toBe("");

  const backlogRedirect = await worker.fetch(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: {
      ...access,
      Cookie: jar.header(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ handle, decision: "approve" }),
  });
  jar.update(backlogRedirect);
  const backlogLocation = backlogRedirect.headers.get("Location") ?? "";
  const state = new URL(backlogLocation, ORIGIN).searchParams.get("state") ?? "";

  const callbackResponse = await worker.fetch(
    `${ORIGIN}/callback?code=backlog-code&state=${encodeURIComponent(state)}`,
    { headers: { ...access, Cookie: jar.header() } },
  );
  const back = callbackResponse.headers.get("Location") ?? "";
  const clientCode = new URL(back, ORIGIN).searchParams.get("code") ?? "";

  const tokenResponse = await worker.fetch(`${ORIGIN}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: clientCode,
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      code_verifier: verifier,
      resource: MCP_URL,
    }),
  });

  return { clientId, consent, html, backlogRedirect, callbackResponse, tokenResponse, clientCode };
}

export function mcpRequest(
  accessToken: string | null,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Response> {
  return worker.fetch(MCP_URL, {
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
