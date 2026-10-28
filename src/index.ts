import type { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createAuthorizationServer } from "./auth/authorization-server";
import { checkConfig } from "./config-check";
import type { Env } from "./env";

// issuer / resource は PUBLIC_BASE_URL 由来で固定のため、同じ値の間は isolate 内で使い回す。
let cached: { baseUrl: string; provider: OAuthProvider<Env> } | undefined;

function getProvider(env: Env): OAuthProvider<Env> {
  if (!cached || cached.baseUrl !== env.PUBLIC_BASE_URL) {
    cached = { baseUrl: env.PUBLIC_BASE_URL, provider: createAuthorizationServer(env) };
  }
  return cached.provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 必須の設定が欠けた Worker は、プロバイダを作る前に /healthz 以外を 500 にする(ADR 0010)。
    const config = checkConfig(env as unknown as Record<string, unknown>);
    if (!config.ok) {
      if (new URL(request.url).pathname === "/healthz") {
        return Response.json(
          { status: "misconfigured", missing: config.missing, invalid: config.invalid },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
      // 詳細(項目名だけ。値は出さない)はログへ。応答には出さない。
      console.error(
        JSON.stringify({
          event: "config_invalid",
          missing: config.missing,
          invalid: config.invalid,
        }),
      );
      return Response.json(
        { error: "server_misconfigured" },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
    return getProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
