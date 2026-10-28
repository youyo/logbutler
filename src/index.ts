import type { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createAuthorizationServer } from "./auth/authorization-server";
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
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
