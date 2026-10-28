# ADR 0009: Cloudflare Access 連携の削除

- 状態: 採用(M06、2026-10-28)。ADR 0001・0002 の「`/authorize` と `/callback` を Access で保護する」を置き換える
- 関連: ADR 0001(OAuth サーバー)、ADR 0002(単一 Worker)

## 背景

M01 では、`/authorize` と `/callback` を Cloudflare Access(self-hosted app)で保護し、Worker 側でも
`Cf-Access-Jwt-Assertion`(署名・iss・aud・期限)を検証していた。`/callback` では `/authorize` を通った Access ユーザーと
同じメールアドレスで戻ってきたことも確認していた。

Cloudflare の Access Managed OAuth は、公式ドキュメントが「自前の OAuth を持つサーバーには使わない」と明記している。
Logbutler は自前の OAuth 認可サーバー(Backlog OAuth を上流にする)なので、この組み合わせは想定された使い方ではない。

## 決定

Logbutler は「Backlog OAuth で認可する MCP サーバー」だけを担う。誰が使えるかの制限は Logbutler の外側
(MCP Server Portal の Access ポリシーなど)で別に管理する。

削除したもの:

- `src/auth/access-jwt.ts` と、`/authorize`・`/callback` での JWT 検証
- 環境変数 `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`(`wrangler.jsonc`・`.dev.vars.example`・テスト用の束縛)
- `/callback` での Access メールアドレスの一致確認(`beginUpstream` に載せていた `accessEmail`)
- grant の `props.accessEmail`、同意画面の「Signed in as ...」の表示

維持したもの:

- OAuth 認可サーバー(DCR・PKCE・state・iss・リフレッシュ)と Backlog OAuth
- 同意画面(クライアント名・リダイレクト先ホスト・Backlog のホストの表示、クライアント由来の文字列のエスケープ)
- 偽造 state の `/callback` の拒否(`finishUpstream`)、未登録 `redirect_uri` の `/authorize` の拒否

## 帰結

- `/authorize` は、同意画面に辿り着けた誰にでも Backlog のログインを始めさせる。ただし Backlog のトークンは、その人が自分の Backlog アカウントで
  認証した結果にしかならず、他人のトークンは得られない。同意画面は confused deputy 対策として残している。
- `/register`(DCR)と `/authorize`(同意画面の表示)は、誰でも匿名で呼べる。Backlog の OAuth ログインを通らない限り有効な grant は作られないが、
  匿名の DCR でも KV にクライアント登録が書き込まれる。レート制限や悪用対策は Logbutler には実装せず、前段の Cloudflare WAF / Rate Limiting で行う。
- Worker を公開する範囲を絞りたい場合は、Logbutler の前段(Access、WAF、Portal のポリシー)で行う。手順は M07 のデプロイ手順書に書く。
- テスト: Access 関連の 403 系テストは仕様変更として削除した(`test/e2e/access-protection.test.ts` の E2E 5 のうち 403 を確かめる 3 テストと JWT 検証の unit テスト全体。詳細はマイルストーンの報告)。
  Access の JWT なしで `/register` → `/authorize` → `/callback` → `/token` → `/mcp` が通ることを `test/e2e/no-access.test.ts` で固定した。
  同意画面の XSS、偽造 state、未登録 `redirect_uri` のテストは `test/e2e/authorize-validation.test.ts` に Access なしの形で残した。
