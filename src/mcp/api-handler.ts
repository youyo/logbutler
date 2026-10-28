import { createMcpHandler } from "agents/mcp/server";
import type { GrantProps } from "../auth/props";
import { createBacklogClient } from "../backlog/client";
import type { Env } from "../env";
import { ConfigError } from "../errors";
import { MCP_PATH, protectedResourceMetadataUrl } from "../urls";
import { parseToolConfig } from "./registry";
import { callMcpHandler } from "./request-body";
import { createMcpServer } from "./server";

/**
 * OAuthProvider の apiHandler。`ctx.props` は grant の props(Backlog のトークン入り)。
 * ステートレス: リクエストごとに McpServer を作り、Durable Objects もセッションも使わない。
 *
 * Backlog が 401 を返したら、MCP の応答も HTTP 401 + invalid_token にして、
 * MCP クライアントにリフレッシュ(tokenExchangeCallback 経由で Backlog も更新)させる。
 */
export function createMcpApiHandler(): Required<Pick<ExportedHandler<Env>, "fetch">> {
  return {
    async fetch(request, env, ctx) {
      const props = (ctx as ExecutionContext<GrantProps>).props;
      let backlogUnauthorized = false;

      let toolConfig: ReturnType<typeof parseToolConfig>;
      try {
        toolConfig = parseToolConfig(env);
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        // 運用者向けの設定ミス。詳細はログにだけ出し、応答には出さない。
        console.error(`misconfigured: ${e.message}`);
        return new Response(JSON.stringify({ error: "server_misconfigured" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      const handler = createMcpHandler(
        () =>
          createMcpServer({
            getClient: (options) =>
              createBacklogClient({
                spaceHost: env.BACKLOG_SPACE_HOST,
                accessToken: props.backlogAccessToken,
                maxApiCalls: options.maxApiCalls,
              }),
            spaceHost: env.BACKLOG_SPACE_HOST,
            toolConfig,
            timezone: env.LOGBUTLER_TIMEZONE,
            // 冪等キャッシュは OAUTH_KV の `idem:` 接頭辞のキーに置く（ADR 0005）。
            idempotency: { kv: env.OAUTH_KV, userId: props.backlogUserId },
            onBacklogUnauthorized: () => {
              backlogUnauthorized = true;
            },
          }),
        { route: MCP_PATH },
      );

      const response = await callMcpHandler(handler, request);

      // ステートレスの tools/call は 1 回の応答で終わる。Backlog の 401 を HTTP の 401 に変換するため、
      // POST の応答は(SSE でも)ここで読み切ってから判定する。
      if (request.method !== "POST") return response;
      const body = await response.text();
      if (backlogUnauthorized) {
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": `Bearer realm="OAuth", error="invalid_token", error_description="Backlog access token was rejected; refresh the token", resource_metadata="${protectedResourceMetadataUrl(env)}"`,
          },
        });
      }
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
}
