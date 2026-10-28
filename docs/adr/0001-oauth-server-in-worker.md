# ADR 0001: Worker 自身を OAuth 認可サーバーにする

- 状態: 採用(M01)
- 日付: 2026-10-28

## 背景

Logbutler は Cloudflare MCP Server Portals 経由で使う Remote MCP サーバーで、利用者ごとの Backlog 権限で Backlog API を呼ぶ。
Backlog の認証は OAuth 2.0(認可コード)で、アクセストークンの寿命は約 1 時間、リフレッシュトークンで更新する。
Portal は DCR を持たない上流にも「手動クレデンシャル」で OAuth できるが、ユーザーのトークンが切れたときは再認証を求めるだけで、ユーザーのトークンを自動ではリフレッシュしない(調査メモ: `docs/research/2026-10-28-logvalet-and-nulab-mcp.md`)。

## 決定

Worker が MCP クライアント(Portal を含む)に対する OAuth 認可サーバーになる(`@cloudflare/workers-oauth-provider` の `OAuthProvider`)。
上流の IdP は Backlog OAuth 2.0 で、Worker は Backlog に対しては OAuth クライアントとして振る舞う。

- MCP クライアントには Worker が発行した不透明トークン(寿命 30 分)を渡す。Backlog のトークンはクライアントに渡さない。
- Backlog のアクセストークン・リフレッシュトークン・期限は、grant の `props` にだけ保存する(ライブラリが暗号化して KV に置く。平文の KV キーやログには出さない)。
- `tokenExchangeCallback` で、MCP トークンの更新時に Backlog のトークンも更新して `props` を差し替える。Backlog 側で失効していれば `invalid_grant` を返して grant を失効させ、クライアントに再認可させる。一時障害なら `temporarily_unavailable`(503)で grant を残す。
- MCP トークンの寿命(30 分)を Backlog のアクセストークン(約 1 時間)より短くし、MCP の更新 1 回につき Backlog の更新が高々 1 回になるようにして、並列リフレッシュの競合を避ける。
- 利用者の保護(**ADR 0009 で置き換え**: Access 連携は削除した。利用者の制限は Logbutler の外側で行う。以下は M01 当時の決定): `/authorize` と `/callback` だけを Cloudflare Access(self-hosted app)で保護し、Worker 側でも `Cf-Access-Jwt-Assertion` を検証する(署名・iss・aud・期限)。`/mcp`・`/token`・`/register`・`/.well-known/*` は Portal がサーバー間で呼ぶので Access を通さず(Bypass)、Worker 発行トークンで守る。
- 同意画面(`/authorize`)で、クライアント名・リダイレクト先ホスト・Backlog のホストを表示し、承認後にだけ Backlog へリダイレクトする(confused deputy 対策。`beginConsent` / `approveConsent` / `beginUpstream` を使う)。

## 却下した案

### Portal の手動 OAuth で Backlog のトークンを Bearer としてそのまま流す(passthrough)

logvalet v0.40 の `remote-mcp-request-contract.md` の方式。Worker は OAuth サーバーを持たず、Portal が Backlog と直接 OAuth し、得たトークンを `Authorization: Bearer` で Worker に渡す。

却下の理由:

1. Portal はユーザーのトークンが切れると再認証を求めるだけで、自動でリフレッシュしない。Backlog のアクセストークンは約 1 時間で切れるため、約 1 時間ごとに利用者が再認証することになり、実用に耐えない。
2. Worker 側にリフレッシュトークンがないので、Worker から更新を肩代わりできない。
3. Backlog のトークンがクライアント(Portal)側に常駐する。Worker が発行する不透明トークンにすれば、Backlog のトークンの置き場を Worker の暗号化 KV に限定できる。

### Durable Objects / McpAgent で状態を持つ

認証状態は KV(grant・トークン)で足り、MCP 自体もステートレス(`createMcpHandler`)で済む。DO は使わない。

## 未検証の前提(実デプロイしていないため、実 API で確認が必要)

確認手順と結果の記入欄は [docs/manual-verification.md](../manual-verification.md)(項目 V01 〜 V04)。

1. **Backlog のリフレッシュトークンがローテーション(更新のたびに変わる)するか**。実装は両対応: トークン応答に `refresh_token` があれば `props` を差し替え、なければ元のものを維持する(`src/auth/backlog-oauth.ts`)。ローテーションする場合、同じ grant で更新が並列に走ると古いリフレッシュトークンが失効して `invalid_grant` になりうる。MCP の更新が Worker 側でトークン単位に直列化される保証は、ライブラリが旧トークンを次の使用まで有効に保つ挙動に頼っており、実機では未確認。
2. **KV の結果整合性がリフレッシュ直後のトークン利用に影響しないか**。KV の書き込みは別ロケーションに最大 60 秒ほどで反映される。更新直後に別ロケーションの isolate が古い `props` を読むと、失効済みの Backlog リフレッシュトークンで更新を試みる可能性がある(ローテーション有りの場合)。テストは Miniflare のローカル KV で行っており、この挙動は再現できない。M07 の実デプロイで確認する。
3. Backlog のアクセストークンの実際の `expires_in`(約 1 時間と想定)。実装は応答の `expires_in` をそのまま使う。
4. Backlog の `redirect_uri` 検証と、client_secret のフォーム送信が仕様どおりに通ること(logvalet のコード交換実装を参考にしたが、リフレッシュは logvalet に実装がなく、本リポジトリで新規)。
