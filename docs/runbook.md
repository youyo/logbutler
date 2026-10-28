# デプロイと運用の手順書

Logbutler(Backlog 用 Remote MCP サーバー)を Cloudflare Workers にデプロイして運用する手順。
**このリポジトリの作業では実デプロイをしていない**。この手順は、ユーザーが自分の Cloudflare アカウントと Backlog スペースで実施する。
デプロイ後の確認は [docs/manual-verification.md](manual-verification.md)。

前提: [mise](https://mise.jdx.dev/) 導入済み、Cloudflare アカウント(分析系ツールを使うなら有料プラン。manual-verification の V13)、公開に使うドメインの DNS ゾーンが同じアカウントにあること、Backlog スペースの管理者権限(OAuth アプリの登録に必要)。

```sh
mise install            # node / pnpm
mise run install        # 依存パッケージ
pnpm exec wrangler login   # Cloudflare にログイン(ブラウザ)
```

以降 `<domain>` は公開するホスト名(例 `logbutler.example.com`)、`<space>` は Backlog のスペース名(例 `example`、ホストは `example.backlog.com`)。

## 設定値の対応表

| 設定 | 置き場所 | 値の例 | 備考 |
|---|---|---|---|
| Worker 名 | `wrangler.jsonc` の `env.production.name` | `logbutler` | |
| KV namespace `OAUTH_KV` の id | `wrangler.jsonc` の `env.production.kv_namespaces[0].id` | 32 桁の 16 進 | 手順 2-1 で作る |
| カスタムドメイン | `wrangler.jsonc` の `env.production.routes[0].pattern` | `<domain>` | `custom_domain: true`。デプロイ時に DNS と証明書が作られる |
| `BACKLOG_SPACE_HOST` | `wrangler.jsonc` の `env.production.vars` | `<space>.backlog.com` | スキーム・スラッシュなし |
| `PUBLIC_BASE_URL` | `wrangler.jsonc` の `env.production.vars` | `https://<domain>` | 末尾スラッシュ・パスなし。issuer とトークンの audience の元 |
| `BACKLOG_CLIENT_ID` | secret(`wrangler secret put`) | Backlog が発行 | コミットしない |
| `BACKLOG_CLIENT_SECRET` | secret(`wrangler secret put`) | Backlog が発行 | コミットしない |
| Backlog のリダイレクト URI | Backlog のアプリ設定 | `https://<domain>/callback` | `PUBLIC_BASE_URL` + `/callback` と完全一致 |
| MCP の接続 URL | MCP クライアント / Portal | `https://<domain>/mcp` | 必要なら `?toolsets=...&read_only=true` |

`wrangler.jsonc` の `<...>` はプレースホルダ。残したままだと設定チェックが `/healthz` 以外を 500 にする(ADR 0010)。

## 1. Backlog 側: OAuth アプリの登録

1. Backlog にスペースの管理者でログインし、スペース設定のアプリケーション(OAuth 2.0 のクライアント登録)の画面を開く。
2. 新しいアプリケーションを登録する。
   - アプリケーション名: 任意(同意画面に出る。例 `Logbutler`)
   - リダイレクト URI: `https://<domain>/callback`(1 文字でも違うと Backlog が拒否する)
3. 登録後に表示される **クライアント ID** と **クライアントシークレット** を控える(シークレットはあとで再表示できない場合がある)。手順 2-4 で Cloudflare に入れる。

1 デプロイ = 1 Backlog スペース。複数のスペースを使うなら、スペースごとに別の Worker(別の `name`・KV・ドメイン)を作る。

## 2. Cloudflare 側

### 2-1. KV namespace の作成

```sh
pnpm exec wrangler kv namespace create logbutler-oauth
```

出力された `id`(32 桁の 16 進)を、`wrangler.jsonc` の `env.production.kv_namespaces[0].id` に書く(ダミーの `0000...` を置き換える)。
`--update-config` は使わない(コメント付きの設定が崩れるため)。

### 2-2. カスタムドメイン

`wrangler.jsonc` の `env.production.routes[0].pattern` の `<domain>` を実ホスト名に書き換える。`custom_domain: true` なので、
デプロイ時に Cloudflare が DNS レコードと証明書を作る(そのホスト名に既存の DNS レコードがあると失敗するので、先に消す)。
`vars` の `PUBLIC_BASE_URL`(`https://<domain>`)と `BACKLOG_SPACE_HOST`(`<space>.backlog.com`)も実値にする。

### 2-3. 前段の保護(任意)

Logbutler の前段に Access や MCP Server Portal を置く場合は別途設定する(次節)。Logbutler 自体は DCR 対応の OAuth 付き MCP サーバーとして振る舞い、Access の設定を持たない。

### 2-4. 検証とデプロイ

```sh
mise run lint
mise run test
mise run deploy:check   # wrangler deploy --env production --dry-run。Cloudflare には何も変更しない
# デプロイ前に grep -n '<' wrangler.jsonc でプレースホルダ（<domain>、<space> など）が残っていないことを確認する。deploy:check はプレースホルダが残っていても通るため
mise run deploy         # 本番へデプロイ(wrangler deploy --env production)
```

`deploy:check` は設定の形式とバンドルを確かめるだけで、プレースホルダが残っていても通る(`<domain>` のままでも dry-run は成功する)。
実値に書き換えたかどうかは、デプロイ後の `/healthz` が確かめる。secrets を入れる前にデプロイすると、設定チェックにより `/healthz` が 503(`missing` に 2 つの secret)になる。これは想定どおり。

### 2-5. secrets の投入

```sh
pnpm exec wrangler secret put BACKLOG_CLIENT_ID --env production
pnpm exec wrangler secret put BACKLOG_CLIENT_SECRET --env production
```

プロンプトに値を貼る(コマンドラインに値を書かない)。投入後に `/healthz` が 200 になることを 2-6 で確認する。

### 2-6. デプロイ後の最小確認

```sh
curl -s https://<domain>/healthz                       # {"status":"ok"} と 200
curl -s https://<domain>/.well-known/oauth-protected-resource/mcp   # resource が https://<domain>/mcp
mise run verify:oauth -- https://<domain>/mcp           # OAuth の通し確認(ブラウザで Backlog のログインと同意)
```

`/healthz` が 503 なら、本文の `missing` / `invalid` が直すべき項目(ADR 0010)。`verify:oauth` の使い方は [README](../README.md#実環境の-oauth-確認mise-run-verifyoauth)、続きの確認は [docs/manual-verification.md](manual-verification.md)。

## 3. 前段に Access や Portal を置く場合

Logbutler の前段に Cloudflare Access や MCP Server Portal を置く場合は、Logbutler の外側で別途設定する(この手順書では扱わない。Logbutler は Access 連携を持たない。ADR 0009)。
Logbutler は DCR 対応の OAuth 付き MCP サーバーとして振る舞う。

Portal に登録するときの注意:

- 認証方式は **OAuth(DCR による自動登録)+ Require user auth** にする。各ユーザーが Portal の Connect から自分の Backlog アカウントで認可する(Portal のコールバック `https://<portal-host>/servers-callback` が DCR の `redirect_uri` として登録される)。
- **Access の Managed OAuth は有効にしない**。公式ドキュメントが「自前の OAuth を持つサーバーには使わない」と明記しており、Logbutler は自前の OAuth 認可サーバーである。
- サーバー URL は `https://<domain>/mcp`。ツールを絞るなら `?toolsets=...&read_only=true`(Portal がクエリを保持するかは未検証。manual-verification の P3)。

確認項目は manual-verification の「Portal を使う場合」(P1〜P5)。

## 4. 運用

### 4-1. ログの見方

`wrangler.jsonc` の `observability` で Workers Logs を有効にしている。ダッシュボード(Workers & Pages → logbutler → Logs)か、`pnpm exec wrangler tail --env production` で見る。

**トークンやシークレットはログに出ない設計**。アクセストークン・リフレッシュトークン・`client_secret` は grant の `props`(暗号化して KV)にだけあり、エラーメッセージでも伏せる。ログで見る手がかり:

| ログ | 意味 |
|---|---|
| `{"event":"config_invalid","missing":[...],"invalid":[...]}` | 設定チェックの失敗。項目名だけ(値は出ない)。`/healthz` にも同じ内容が出る |
| `tool <名前> failed unexpectedly: ...` | ツールで想定外の例外(トークンは伏せ字) |
| `idempotency cache read/write failed: ...` | 冪等キャッシュ(KV)の失敗。ツールは止まらない |

### 4-2. Backlog の client secret のローテーション

1. Backlog のアプリケーション設定で、クライアントシークレットを再発行できる場合は再発行する(再発行できない場合は、新しいアプリケーションを登録して client id / secret の両方を差し替える。その場合、既存の grant は旧 client id で発行されたリフレッシュトークンを持つため、**全員が再認可**になる)。
2. `pnpm exec wrangler secret put BACKLOG_CLIENT_SECRET --env production` で新しい値を入れる(`BACKLOG_CLIENT_ID` も変えたなら同様)。secret の更新は新しいバージョンとして即座に反映される。
3. 切り替えの間(Backlog 側で旧シークレットが無効になってから Worker に新しい値が入るまで)は、Backlog のトークン更新が失敗し、MCP のトークン更新が 503(`temporarily_unavailable`)になる。grant は残るので、新しい値を入れれば自然に回復する。間を短くするため、2 を先に準備しておく。
4. `mise run verify:oauth -- https://<domain>/mcp` と、`--refresh-only` で更新できることを確認する。

### 4-3. KV に保存されるもの

`OAUTH_KV` の中身(キーの接頭辞):

| 接頭辞 | 内容 |
|---|---|
| `client:<clientId>` | DCR で登録された MCP クライアント |
| `grant:<backlogUserId>:<grantId>` | ユーザーごとの認可(**Backlog のトークンを含む `props`**。ライブラリが暗号化して保存) |
| `token:<backlogUserId>:<grantId>:<id>` | Worker が発行した MCP のアクセストークン / リフレッシュトークンの記録(ハッシュ) |
| `idem:<backlogUserId>:<ツール名>:...` | 書き込みツールの冪等キャッシュ(TTL 5 分。ツールの結果の JSON。ADR 0005) |

### 4-4. ユーザーの接続を無効化する(grant の削除)

Backlog のユーザー ID を調べ(`logbutler_user_me` の `id`、または Backlog のユーザー管理画面)、そのユーザーの grant とトークンを KV から削除する。

```sh
# 一覧(実際に消す前に確認)
pnpm exec wrangler kv key list --binding OAUTH_KV --env production --remote --prefix "grant:<backlogUserId>:"
pnpm exec wrangler kv key list --binding OAUTH_KV --env production --remote --prefix "token:<backlogUserId>:"
# 削除(1 キーずつ。キー名は一覧の出力から)
pnpm exec wrangler kv key delete "<キー>" --binding OAUTH_KV --env production --remote
```

grant を消すと、そのユーザーの MCP トークンは使えなくなり、リフレッシュもできない(再認可が必要)。Backlog 側の権限も取り消すなら、Backlog の個人設定で、そのアプリケーションの連携を解除してもらう。
全員を無効にしたい場合は、Backlog のアプリケーションを削除する(以降の Backlog トークン更新はすべて失敗する)か、`BACKLOG_CLIENT_SECRET` を変更する。

### 4-5. 障害時の切り分け

まず `curl -s https://<domain>/healthz` で設定の状態を見る。次に、症状から:

| 症状 | 原因の見方 |
|---|---|
| `/healthz` が 503 | 設定の欠け。本文の `missing` / `invalid` の項目を直す(secret の投入、プレースホルダの置換) |
| `/healthz` 以外が 500 `server_misconfigured` | 同上(ログに項目名) |
| MCP クライアントが `/mcp` で 401 を受け、再認可になる | Backlog が 401(トークン失効)のとき、Logbutler は HTTP 401 + `WWW-Authenticate: Bearer error="invalid_token"` を返し、クライアントにリフレッシュさせる。リフレッシュが `invalid_grant` なら Backlog 側で連携が解除された(再認可が必要) |
| ツールが `isError` で `rate_limited`(`retryable: true`) | Backlog が 429(約 1 分 600 回)。`Retry-After` が 10 秒以内なら最大 2 回自動で待つ。それでも 429 なら、そのまま返す。しばらく待つ |
| ツールが `api_error`(`retryable: true`) | Backlog の 5xx、または通信失敗・タイムアウト(30 秒)。Backlog 側の障害を疑う |
| ツールが `permission_error`(403) / `not_found`(404) | そのユーザーの Backlog 権限・存在しない ID |
| ツールが `api_error`(`retryable: false`)で「範囲を絞る」 | 1 回の呼び出しの Backlog API 上限を超えた。対象のプロジェクトや期間を絞る。無料プランの subrequest 上限(50)に当たっている可能性もある(manual-verification V13) |
| `response_too_large` | 応答がサイズ上限を超えた。絞り込むか `max_response_tokens` を指定する(ADR 0007) |
| 認可画面でエラー | `redirect_uri` の不一致(Backlog のアプリ設定の `https://<domain>/callback`)、`PUBLIC_BASE_URL` の誤りが多い。`mise run verify:oauth` の `metadata` 段階が `PUBLIC_BASE_URL` と接続先の食い違いを検出する |

### 4-6. 匿名で呼べるエンドポイント

`/register`(DCR)と `/authorize` の同意画面は、誰でも匿名で呼べる(ADR 0009)。Backlog のログインを通らない限り有効な grant は作られないが、匿名の DCR でも KV にクライアント登録が書き込まれる。
レート制限は Logbutler に実装していない。必要なら前段の Cloudflare WAF / Rate Limiting で `/register` を制限する(manual-verification V16)。

## 5. Terraform などで管理する場合

このリポジトリには Terraform を入れない。Access アプリや Portal を別のリポジトリ(IaC)で管理する場合は、上の「設定値の対応表」の値(ドメイン、`/mcp` の URL、OAuth 方式、Managed OAuth を有効にしないこと)を渡せばよい。
Worker 自体(KV・ドメイン・vars)は `wrangler.jsonc` の `env.production` が定義しており、`mise run deploy` で反映する。Terraform で Worker や KV も管理する場合は、`wrangler.jsonc` との二重管理にならないよう、どちらか一方に寄せる。
