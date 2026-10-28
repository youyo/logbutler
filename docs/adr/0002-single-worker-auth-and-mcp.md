# ADR 0002: 認可サーバーと MCP サーバーを 1 つの Worker に同居させる

- 状態: 採用(M01)
- 日付: 2026-10-28

## 背景

`@cloudflare/workers-oauth-provider` v1(採用: 1.2.3)は 2 つの構成を提供する。

- **分離**: `OAuthAuthorizationServer`(認可サーバー)と `OAuthResourceServer`(MCP エンドポイント)を別の Worker に置き、Service Binding の `validateToken` でつなぐ。ライブラリの README が推奨する形。
- **同居**: `OAuthProvider` 1 つで、認可サーバーと唯一のリソースサーバーを兼ねる。`apiRoute` 配下が `apiHandler`(MCP)に、それ以外が `defaultHandler`(`/authorize` など)に届く。README は「完全にサポートされる」としている。

(`OAuthAuthorizationServer` + `OAuthResourceServer` を 1 つの Worker に置く第三の構成も可能。)

## 決定

`OAuthProvider` による同居構成にする(`src/auth/authorization-server.ts`)。

- `apiRoute: "/mcp"` → `apiHandler`(ステートレスな `createMcpHandler`。リクエストごとに `McpServer` を生成)
- `defaultHandler` → Hono アプリ(`/authorize`・`/callback`・`/healthz`)
- `/token`・`/register`・`/.well-known/oauth-authorization-server`・`/.well-known/oauth-protected-resource/mcp` は `OAuthProvider` が処理

理由:

1. Logbutler の MCP リソースは 1 つ(`/mcp`)で、認可サーバーも 1 つ。リソースを複数に増やす予定がなく、分離のメリット(リソースごとの独立デプロイ・独立スケール)がない。
2. 分離すると Worker が 2 つ、Service Binding が 1 つ、デプロイ単位と Cloudflare Access のアプリ定義が増える。個人・小規模チーム用途の運用コストに見合わない。
3. トークンの検証は KV 参照とその場の復号で完結し、RPC のホップが要らない(分離だと `/mcp` のたびに Service Binding 越しの RPC が 1 回増える)。
4. Backlog のトークンを含む `props` を復号できるのが認可サーバーだけであるという制約が、同居なら自然に満たされる(`apiHandler` は `ctx.props` を直接受け取る)。
5. ルーティングは「`/mcp` か、それ以外か」だけで、Hono は `defaultHandler` 内に閉じる。`createMcpHandler` の戻り値を直接 default export せず、`{ fetch }` で `OAuthProvider` を呼ぶ(issuer・resource を `PUBLIC_BASE_URL` から作るため、`OAuthProvider` は最初のリクエストで生成して isolate 内で使い回す)。

## 帰結

- issuer とリソース識別子(`<PUBLIC_BASE_URL>/mcp`)は固定の正規 URL が必要なので、環境変数 `PUBLIC_BASE_URL`(オリジンのみ、`https`。ローカルのみ `http://localhost:8787` 可)を追加した。
- `OAuthProvider` は保護対象を `apiRoute` に限る。`/authorize` と `/callback` の保護は Cloudflare Access + Worker 側の JWT 検証(ADR 0001)で行っていた(**ADR 0009 で置き換え**: Access 連携は削除した)。
- リソースが増える、または認可サーバーを他サービスと共有する必要が出たら、`OAuthAuthorizationServer` + `OAuthResourceServer` の分離構成へ移行する。`ctx.props` と `ctx.auth` は両ホストで同じなので、`apiHandler` はそのまま移せる。
- MCP の保護リソースメタデータの URL は、ライブラリの仕様で `/.well-known/oauth-protected-resource/mcp`(resource のパス付き)になる。`WWW-Authenticate` の `resource_metadata` もこの URL を指す。

## 未検証の前提

確認手順と結果の記入欄は [docs/manual-verification.md](../manual-verification.md)(V01・V02、Portal 関連は P1 〜 P5、CIMD は V07)。

ADR 0001 と共通(Backlog のリフレッシュトークンのローテーション有無、KV の結果整合性)。加えて、実際の Cloudflare MCP Server Portals が DCR/CIMD のどちらで接続してくるかは未確認(M01 は DCR のみ有効。CIMD は `global_fetch_strictly_public` フラグが必要で、M07 で Portal の挙動を見て判断する)。
