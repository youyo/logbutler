import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Worker の束縛・環境変数。wrangler.jsonc と .dev.vars.example に対応する。 */
export interface Env {
  /** OAuth プロバイダ(grant・トークン・クライアント登録)の保存先。 */
  OAUTH_KV: KVNamespace;
  /** 接続先 Backlog スペースのホスト名(例 example.backlog.com)。1 デプロイ = 1 スペース。 */
  BACKLOG_SPACE_HOST: string;
  /** この Worker の公開 URL(オリジンのみ。例 https://logbutler.example.com)。issuer とリソース識別子の元になる。 */
  PUBLIC_BASE_URL: string;
  /** Backlog OAuth クライアント ID(secret)。 */
  BACKLOG_CLIENT_ID: string;
  /** Backlog OAuth クライアントシークレット(secret)。 */
  BACKLOG_CLIENT_SECRET: string;
  /** OAuthProvider が defaultHandler に渡すヘルパー。 */
  OAUTH_PROVIDER: OAuthHelpers;
}

type LogbutlerEnv = Env;

// cloudflare:workers の `env` と `Cloudflare.Env` にも同じ型を反映する。
declare global {
  namespace Cloudflare {
    interface Env extends LogbutlerEnv {}
  }
}
