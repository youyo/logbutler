# M01: 雛形と認証の骨格

ロードマップ: `plans/logbutler-roadmap.md`

## 目的

Logbutler の土台を作る。MCP クライアント（Cloudflare MCP Portal を想定）が OAuth で接続し、
Backlog OAuth で認可されたユーザーとして、ダミーツール `logbutler_user_me` を呼べるところまでを通しで動かす。

## 完了条件

- `mise run test`（unit + e2e）と `mise run lint` が通る
- `@cloudflare/vitest-pool-workers` 上で Worker 全体（`SELF.fetch`）に HTTP リクエストを送り、次の流れが E2E テスト（`mise run test:e2e`）で確認できる。Backlog の OAuth / API と Access の JWKS は outbound fetch のモック（`fetchMock` 等）で差し替える（`wrangler dev` の外からは outbound fetch を差し替えられないため、この形にする）
  1. トークンなしで `/mcp` を呼ぶと `401` と `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"` が返り、その URL が 200 で `authorization_servers` を含む JSON を返す
  2. `/register`（DCR）→ `/authorize` → Backlog の認可画面（モック）→ `/callback` → `/token` でアクセストークンを取得できる
  3. 取得したトークンで `/mcp` の `tools/list` と `tools/call logbutler_user_me` が成功する
  4. Backlog のアクセストークンが期限切れの状態で MCP クライアントがリフレッシュすると、`tokenExchangeCallback` で Backlog のトークンも更新される
  5. `/authorize` と `/callback` は、正しい `Cf-Access-Jwt-Assertion` がないと `403` になる
- `/healthz` は認証なしで `{"status":"ok"}` を返す

## 対象範囲

### 1. リポジトリの雛形
- `mise.toml`: `[tools]` に node（24 系 LTS）と pnpm をバージョン固定。タスク `test` / `test:unit` / `test:e2e` / `lint` / `fmt` / `build` / `dev` / `deploy`
- `package.json`、`tsconfig.json`（strict）、`wrangler.jsonc`（`compatibility_date` は作業日、`nodejs_compat` は必要になったときだけ）
- lint / fmt は Biome を第一候補にする（ESLint + Prettier でもよい。決めたら理由を README に 1 行）
- `CLAUDE.md`（このリポジトリの作業規約。TDD・mise・JSON の snake_case・エラーエンベロープ・Backlog API はモックのみ）
- `README.md`（製品名・説明・Backlog は株式会社ヌーラボの商標で本プロジェクトは無関係である旨）
- `.gitignore`、`.dev.vars.example`（秘密情報の雛形。実値はコミットしない）
- 依存パッケージはすべて**公開から 2 週間以上たった正確なバージョン**に固定する

### 2. 構成
```
src/
  index.ts          — default export は { fetch } または Hono の app（createMcpHandler の戻り値をそのまま default export しない）
  auth/
    authorization-server.ts — OAuthAuthorizationServer の設定
    backlog-oauth.ts        — Backlog の認可 URL 生成・コード交換・リフレッシュ
    access-jwt.ts           — Cf-Access-Jwt-Assertion の検証（JWKS は Access のチーム URL から取得してキャッシュ）
  mcp/
    server.ts       — McpServer のファクトリ（リクエストごとに生成）
    tools/user-me.ts
  backlog/
    client.ts       — M01 では GET /api/v2/users/myself だけ
test/
  unit/
  e2e/
```

### 3. 認証の流れ
- 認可サーバーと MCP サーバーは**同じ Worker に同居**させる（workers-oauth-provider v1 の `OAuthProvider` で両方を兼ねる構成、または `OAuthAuthorizationServer` + `OAuthResourceServer` を 1 Worker に置く構成。v1 のドキュメントを読んで選び、理由を ADR に書く）
- `/authorize`: Access の JWT を検証 → 同意画面（クライアント名・スコープ・送信先ホストを表示。v1 の consent page ヘルパーを使う）→ `beginUpstream()` で state を発行し Backlog の認可画面へリダイレクト
- `/callback`: `finishUpstream()` で state を検証 → Backlog のコードをトークンに交換 → `completeAuthorization()` の `props` に Backlog の access/refresh token・有効期限・Backlog のユーザー ID・Access のメールアドレスを入れる
- `tokenExchangeCallback`: MCP のトークン更新時に、Backlog のトークンの期限が近ければ `grant_type=refresh_token` で更新して `props` を差し替える。Backlog 側で失効していたら `OAuthError("invalid_grant")` を投げる
- MCP のアクセストークンの有効期限は Backlog のアクセストークン（約 1 時間）より短くする。Backlog のトークン更新が MCP のトークン更新と同時に 1 回ずつ起きるようにして、並列リフレッシュの競合を避けるため
- Backlog API の呼び出しで 401 が返ったら、MCP のレスポンスも 401 にしてクライアントにリフレッシュさせる

Backlog OAuth（スペースのドメインは環境変数 `BACKLOG_SPACE_HOST`、例 `example.backlog.com`）:
- 認可: `https://{host}/OAuth2AccessRequest.action?response_type=code&client_id=...&redirect_uri=...&state=...`
- トークン: `POST https://{host}/api/v2/oauth2/token`（`grant_type=authorization_code` / `refresh_token`、client_secret はフォームで送る）

### 4. 環境変数・バインディング
- KV: `OAUTH_KV`
- vars: `BACKLOG_SPACE_HOST`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`
- secrets: `BACKLOG_CLIENT_ID`、`BACKLOG_CLIENT_SECRET`

## TDD の進め方（小さい順）
1. `/healthz`
2. Backlog OAuth: 認可 URL の生成、コード交換、リフレッシュ（fetch をモック）
3. Access JWT 検証（テスト用の鍵ペアで署名した JWT。期限切れ・aud 違い・署名不正を拒否）
4. MCP: `tools/list` と `logbutler_user_me`（Backlog クライアントをモック）
5. 認可フロー全体の E2E（vitest-pool-workers。Backlog の認可・トークンエンドポイントと Access はモック）
6. リフレッシュの E2E

## やってはいけないこと
- Durable Objects を使う
- Backlog のトークンをログに出す、`props` 以外（平文の KV キーなど）に保存する
- テストを弱める・skip する・消す
- 実 Backlog への API 呼び出しを unit / e2e テストに入れる
- コミット・push・リモートリポジトリの作成（ユーザーの指示があるときだけ）
- logvalet のツールの移植（M02 以降）

## 未検証の前提（実デプロイしないため、ブロッカーにせず ADR に明記して進む）
- Backlog のリフレッシュトークンがローテーションするか。実装はローテーションする場合としない場合の両方に対応する（応答に refresh_token があれば差し替え、なければ維持）
- KV の結果整合性がリフレッシュ直後のトークン利用に影響しないか

## 成果物
- 上記のコードとテスト
- `docs/adr/0001-oauth-server-in-worker.md`（Worker を OAuth サーバーにした理由。Portal の手動 OAuth を却下した理由を含む）
- `docs/adr/0002-single-worker-auth-and-mcp.md`（認可サーバーと MCP を同居させた理由）
