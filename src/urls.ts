import type { Env } from "./env";

/** /mcp の正規 URL(RFC 9728 の resource 識別子であり、トークンの audience)。 */
export const MCP_PATH = "/mcp";

export function baseUrl(env: Pick<Env, "PUBLIC_BASE_URL">): string {
  return env.PUBLIC_BASE_URL.replace(/\/+$/, "");
}

export function mcpResource(env: Pick<Env, "PUBLIC_BASE_URL">): string {
  return `${baseUrl(env)}${MCP_PATH}`;
}

/** workers-oauth-provider が公開する RFC 9728 メタデータの URL(resource のパスが後ろに付く)。 */
export function protectedResourceMetadataUrl(env: Pick<Env, "PUBLIC_BASE_URL">): string {
  return `${baseUrl(env)}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

export function callbackUrl(env: Pick<Env, "PUBLIC_BASE_URL">): string {
  return `${baseUrl(env)}/callback`;
}
