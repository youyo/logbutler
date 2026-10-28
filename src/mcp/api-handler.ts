import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { grantRefFromAccessToken, markBacklogStale } from "../auth/backlog-stale";
import type { GrantProps } from "../auth/props";
import { createBacklogClient } from "../backlog/client";
import type { Env } from "../env";
import { QueryError } from "../errors";
import { MCP_PATH, protectedResourceMetadataUrl } from "../urls";
import { parseToolConfig } from "./registry";
import { callMcpHandler } from "./request-body";
import { createMcpServer } from "./server";
import { ALL_TOOLS } from "./tools";

/**
 * OAuthProvider の apiHandler。`ctx.props` は grant の props(Backlog のトークン入り)。
 * ステートレス: リクエストごとに McpServer を作り、Durable Objects もセッションも使わない。
 *
 * Backlog が 401 を返したら、MCP の応答も HTTP 401 + invalid_token にして、
 * MCP クライアントにリフレッシュ(tokenExchangeCallback 経由で Backlog も更新)させる。
 * そのとき grant に「Backlog の更新が必要」という印を置く(保存した期限より先に Backlog 側で失効した場合でも、
 * 次のリフレッシュで期限に関係なく Backlog を更新させるため。backlog-stale.ts)。
 */
export function createMcpApiHandler(): Required<Pick<ExportedHandler<Env>, "fetch">> {
  return {
    async fetch(request, env, ctx) {
      const oauthCtx = ctx as Partial<OAuthResourceContext<GrantProps>> &
        ExecutionContext<GrantProps>;
      const props = oauthCtx.props;
      let backlogUnauthorized = false;

      // toolsets / read_only は接続 URL のクエリで決まる(ADR 0008)。不正な値は 400 で理由を返す。
      let toolConfig: ReturnType<typeof parseToolConfig>;
      try {
        toolConfig = parseToolConfig(new URL(request.url).searchParams, ALL_TOOLS);
      } catch (e) {
        if (!(e instanceof QueryError)) throw e;
        return new Response(
          JSON.stringify({ error: "invalid_query", error_description: e.message }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
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
        // 印はクライアントが直後に叩く /token より先に書き終える(waitUntil にしない)。失敗しても 401 は返す。
        let staleMarked = false;
        const ref = grantRefFromAccessToken(oauthCtx.auth?.token);
        if (ref) {
          try {
            await markBacklogStale(env.OAUTH_KV, ref.userId, ref.grantId);
            staleMarked = true;
          } catch {
            staleMarked = false;
          }
        }
        // 診断ログ(値は出さない): props 上の Backlog トークンの残り秒数。負なら保存期限どおりの失効。
        console.warn(
          JSON.stringify({
            event: "backlog_unauthorized",
            backlog_remaining_seconds: Math.floor((props.backlogExpiresAt - Date.now()) / 1000),
            stale_marked: staleMarked,
          }),
        );
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
