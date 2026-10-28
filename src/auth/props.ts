/**
 * grant の props。Backlog のトークンは「ここにだけ」保存する(OAuthProvider が暗号化して KV に置く)。
 * ログ・別の KV キー・エラーメッセージに出してはいけない。
 */
export interface GrantProps {
  backlogAccessToken: string;
  backlogRefreshToken: string;
  /** Backlog アクセストークンの期限(エポックミリ秒)。 */
  backlogExpiresAt: number;
  backlogUserId: number;
  /** /authorize・/callback を通った Cloudflare Access ユーザーのメールアドレス。 */
  accessEmail: string;
}
