import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { app } from "../app";
import type { Env } from "../env";
import { createMcpApiHandler } from "../mcp/api-handler";
import { baseUrl, MCP_PATH, mcpResource } from "../urls";
import { createTokenExchangeCallback, MCP_ACCESS_TOKEN_TTL_SECONDS } from "./token-exchange";

/**
 * 認可サーバー + MCP リソースサーバーを 1 つの Worker に同居させる(`OAuthProvider`)。
 * - /mcp (apiRoute)        : Worker 発行のアクセストークンで保護。apiHandler = ステートレス MCP
 * - /token /register /.well-known/* : OAuthProvider が処理(Access を通さない)
 * - それ以外(/authorize /callback /healthz) : defaultHandler = Hono アプリ
 *
 * issuer・resource は固定の正規 URL が必要なので、PUBLIC_BASE_URL から最初のリクエストで組み立てる。
 */
export function createAuthorizationServer(env: Pick<Env, "PUBLIC_BASE_URL">) {
  return new OAuthProvider<Env>({
    apiRoute: MCP_PATH,
    apiHandler: createMcpApiHandler(),
    defaultHandler: { fetch: app.fetch },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    accessTokenTTL: MCP_ACCESS_TOKEN_TTL_SECONDS,
    tokenExchangeCallback: createTokenExchangeCallback(),
    resourceMetadata: {
      resource: mcpResource(env),
      authorization_servers: [baseUrl(env)],
      resource_name: "Logbutler",
    },
  });
}
