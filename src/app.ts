import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
  type BacklogOAuthConfig,
  BacklogOAuthError,
  buildAuthorizeUrl,
  exchangeCode,
} from "./auth/backlog-oauth";
import { renderConsentPage } from "./auth/consent-page";
import type { GrantProps } from "./auth/props";
import { BacklogApiError, createBacklogClient } from "./backlog/client";
import type { Env } from "./env";
import { callbackUrl } from "./urls";

type AppEnv = { Bindings: Env };

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" } as const;

function backlogConfig(env: Env): BacklogOAuthConfig {
  return {
    spaceHost: env.BACKLOG_SPACE_HOST,
    clientId: env.BACKLOG_CLIENT_ID,
    clientSecret: env.BACKLOG_CLIENT_SECRET,
  };
}

function errorPage(status: number, message: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Logbutler</title><p>${message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p>`,
    { status, headers: { ...HTML_HEADERS, "Cache-Control": "no-store" } },
  );
}

/**
 * OAuthProvider の defaultHandler。/mcp・/token・/register・/.well-known/* は OAuthProvider が処理し、
 * ここには /authorize・/callback・/healthz などそれ以外が届く。
 * 利用者の制限(Cloudflare Access など)は Logbutler の外側で行う(ADR 0009)。ここでは Access を扱わない。
 */
export const app = new Hono<AppEnv>();

app.get("/healthz", (c) => c.json({ status: "ok" }));

// --- GET /authorize: 同意画面 ---
app.get("/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    const headers = new Headers(consent.headers);
    headers.set("Content-Type", HTML_HEADERS["Content-Type"]);
    return new Response(
      renderConsentPage({
        details,
        handle: consent.handle,
        backlogHost: c.env.BACKLOG_SPACE_HOST,
      }),
      { headers },
    );
  } catch (e) {
    return renderAuthorizationFailure(e);
  }
});

// --- POST /authorize: 承認 → Backlog へ / 拒否 → クライアントへ access_denied ---
app.post("/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  try {
    const form = await c.req.raw.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      const headers = new Headers(denied.headers);
      headers.set("Location", denied.redirectTo);
      return new Response(null, { status: 302, headers });
    }
    const approved = await oauth.approveConsent(c.req.raw, handle);
    // 同意後にだけ上流(Backlog)へ送る。state は beginUpstream が発行しブラウザに束縛する。
    const { state, headers } = await oauth.beginUpstream(approved.request, {
      headers: approved.headers,
    });
    headers.set(
      "Location",
      buildAuthorizeUrl(backlogConfig(c.env), { redirectUri: callbackUrl(c.env), state }),
    );
    return new Response(null, { status: 302, headers });
  } catch (e) {
    return renderAuthorizationFailure(e);
  }
});

// --- GET /callback: Backlog のコードをトークンに交換して認可を完了する ---
app.get("/callback", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  let resumed: Awaited<ReturnType<typeof oauth.finishUpstream>>;
  try {
    resumed = await oauth.finishUpstream(c.req.raw);
  } catch (e) {
    return renderAuthorizationFailure(e);
  }
  const { request, headers } = resumed;
  const redirectWith = (location: string) => {
    headers.set("Location", location);
    return new Response(null, { status: 302, headers });
  };

  const params = new URL(c.req.url).searchParams;
  if (params.get("error")) {
    return redirectWith(authorizationErrorRedirect(request, "access_denied"));
  }
  const code = params.get("code");
  if (!code) {
    return redirectWith(authorizationErrorRedirect(request, "invalid_request"));
  }

  let props: GrantProps;
  let backlogUserId: number;
  try {
    const tokens = await exchangeCode(backlogConfig(c.env), {
      code,
      redirectUri: callbackUrl(c.env),
    });
    const me = await createBacklogClient({
      spaceHost: c.env.BACKLOG_SPACE_HOST,
      accessToken: tokens.accessToken,
    }).getMyself();
    backlogUserId = me.id;
    props = {
      backlogAccessToken: tokens.accessToken,
      backlogRefreshToken: tokens.refreshToken,
      backlogExpiresAt: tokens.expiresAt,
      backlogUserId: me.id,
    };
  } catch (e) {
    const transient =
      (e instanceof BacklogOAuthError && e.kind === "temporarily_unavailable") ||
      (e instanceof BacklogApiError && (e.status === 0 || e.status >= 500));
    return redirectWith(
      authorizationErrorRedirect(
        request,
        transient ? "temporarily_unavailable" : "server_error",
        "Backlog sign-in failed",
      ),
    );
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request,
    userId: String(backlogUserId),
    metadata: {},
    scope: request.scope,
    props,
  });
  return redirectWith(redirectTo);
});

/** 検証に失敗したリクエストは、クライアントと redirect_uri の検証が済んでいる場合だけクライアントへ戻す。 */
function renderAuthorizationFailure(e: unknown): Response {
  if (e instanceof AuthorizationError) {
    if (e.redirectTo) {
      return new Response(null, { status: 302, headers: { Location: e.redirectTo } });
    }
    return errorPage(400, e.description);
  }
  if (e instanceof CimdFetchError) {
    return errorPage(400, "This app could not be verified.");
  }
  throw e;
}
