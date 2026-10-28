# デプロイと運用の手順書

Logbutler(Backlog 用 Remote MCP サーバー)を、自分の Cloudflare アカウントと Backlog スペースで動かす手順。**下流の運用者**(このリポジトリ = upstream を元に、自分のリポジトリを作って運用する人)の視点で書く。
**upstream の作業では実デプロイをしていない**。設計の理由は [ADR 0011](adr/0011-upstream-downstream-deploy.md)。
デプロイ後の確認は [docs/manual-verification.md](manual-verification.md)。

## 全体像

- upstream(このリポジトリ)の追跡ファイルは、下流では**一切編集しない**。だから `git pull` が競合しない。
- アカウント固有の値(Worker 名、KV id、ドメイン、Backlog スペース、client id / secret)は、下流の GitHub Actions の **Variables / Secrets** に置く。
- デプロイのたびに、`wrangler.jsonc`(upstream の共有設定)と Variables から、デプロイ用の設定 `wrangler.deploy.jsonc`(gitignore 済み)を生成し、`wrangler deploy -c wrangler.deploy.jsonc` する。`compatibility_date` や `main`、`observability`、bindings の追加などは、upstream を pull するだけで届く。
- 下流の運用者がやることは、最初に **KV を 1 回作る**・**Backlog の OAuth アプリを登録する**・**Variables / Secrets を登録する**の 3 つだけ(ファイルの追加・編集はない)。

前提: [mise](https://mise.jdx.dev/) 導入済み(手元で操作する場合)、Cloudflare アカウント(分析系ツールを使うなら有料プラン。manual-verification の V13)、Backlog スペースの管理者権限(OAuth アプリの登録に必要)、カスタムドメインを使うなら、その DNS ゾーンが同じ Cloudflare アカウントにあること。

以降 `<domain>` は公開するホスト名(例 `logbutler.example.com`。カスタムドメインを使わないなら workers.dev のホスト名)、`<space>` は Backlog のスペース名(例 `example`、ホストは `example.backlog.com`)。

## 設定値の対応表

| 設定 | 置き場所 | 値の例 | 備考 |
|---|---|---|---|
| Worker 名 | Variable `LOGBUTLER_WORKER_NAME` | `logbutler` | 小文字英数字とハイフン(63 文字以内)。**未設定なら deploy.yml はジョブごと飛ばされる** |
| KV namespace `OAUTH_KV` の id | Variable `LOGBUTLER_KV_NAMESPACE_ID` | 32 桁の 16 進 | 手順 2-1 で 1 回だけ作る |
| `BACKLOG_SPACE_HOST` | Variable `LOGBUTLER_BACKLOG_SPACE_HOST` | `<space>.backlog.com` | スキーム・スラッシュなし |
| `PUBLIC_BASE_URL` | Variable `LOGBUTLER_PUBLIC_BASE_URL` | `https://<domain>` | https のオリジン。末尾スラッシュ・パスなし。issuer とトークンの audience の元 |
| カスタムドメイン(任意) | Variable `LOGBUTLER_CUSTOM_DOMAIN` | `<domain>` | あれば `custom_domain` の route になり workers.dev は無効。なければ workers.dev で公開。デプロイ時に DNS と証明書が作られる(そのホスト名に既存の DNS レコードがあると失敗するので先に消す) |
| `BACKLOG_CLIENT_ID` | Secret `BACKLOG_CLIENT_ID` | Backlog が発行 | コミットしない。Worker の secret としてデプロイ時に投入される |
| `BACKLOG_CLIENT_SECRET` | Secret `BACKLOG_CLIENT_SECRET` | Backlog が発行 | 同上 |
| Cloudflare API トークン | Secret `CLOUDFLARE_API_TOKEN` | 手順 2-2 | |
| Cloudflare アカウント ID | Secret `CLOUDFLARE_ACCOUNT_ID` | 32 桁の 16 進 | ダッシュボードの右側などで確認 |
| Backlog のリダイレクト URI | Backlog のアプリ設定 | `https://<domain>/callback` | `PUBLIC_BASE_URL` + `/callback` と完全一致 |
| MCP の接続 URL | MCP クライアント / Portal | `https://<domain>/mcp` | 必要なら `?toolsets=...&read_only=true` |

`LOGBUTLER_*` の値に `<...>` のプレースホルダが残っている、形式が違う、必須値が空、のいずれかだと、生成(`mise run deploy:render`)が項目名を挙げて失敗する(値は表示されない)。
起動した Worker 側の検査は ADR 0010。

## 0. 下流リポジトリを作る

どちらでもよい。いずれも、upstream の追跡ファイルは編集しない。

- **fork**: GitHub の Fork で作る。**fork 先では GitHub Actions が既定で無効**なので、Actions タブで有効化する(有効化しないと `deploy.yml` が動かない)。
- **ミラー**: 空のリポジトリを作り、upstream を remote に足して push する。

  ```sh
  git clone <upstream の URL> logbutler && cd logbutler
  git remote rename origin upstream
  git remote add origin <自分のリポジトリの URL>
  git push -u origin main
  ```

**upstream の取り込み**: 下流の `main` で `git pull upstream main`(fork なら `git remote add upstream <upstream の URL>` を先に)して push する。追跡ファイルを編集していないので競合しない。
push すると `deploy.yml` が走り、新しい設定でデプロイされる。

## 1. Backlog 側: OAuth アプリの登録

Backlog の OAuth 2.0 アプリは、**スペースの設定画面ではなく、Backlog 開発者サイト**で登録する: <https://backlog.com/developer/applications/>(nulab.com の開発者サイトにリダイレクトされる)。登録には Nulab アカウントでのログインが要る。

1. 開発者サイトにログインし、アプリケーションの新規登録を開く。
2. 次を入力して登録する。
   - アプリケーション名: 任意(同意画面に出る。例 `Logbutler`)
   - リダイレクト URI: `https://<domain>/callback`(= `LOGBUTLER_PUBLIC_BASE_URL` + `/callback`。1 文字でも違うと Backlog が拒否する)
3. 登録後に表示される **クライアント ID** と **クライアントシークレット** を控える(シークレットはあとで再表示できない場合がある)。手順 3 で Secrets に入れる。

**検証環境と本番を分ける場合**は、それぞれの公開 URL に対するアプリを別々に登録する(リダイレクト URI がアプリごとに決まるため)。1 つのアプリに複数のリダイレクト URI を登録できるかは**未確認**。
1 デプロイ = 1 Backlog スペース。複数のスペースを使うなら、スペースごとに別の下流リポジトリ(または別の Variables)・別の Worker 名・KV・ドメインを用意する。

## 2. Cloudflare 側

### 2-1. KV namespace の作成(1 回だけ手動)

```sh
mise install && mise run install
pnpm exec wrangler login        # ブラウザで Cloudflare にログイン
pnpm exec wrangler kv namespace create logbutler-oauth
```

出力された `id`(32 桁の 16 進)を、Variable `LOGBUTLER_KV_NAMESPACE_ID` に登録する。`--update-config` は使わない(リポジトリのファイルを書き換えないため)。

### 2-2. API トークン

Cloudflare ダッシュボード → My Profile → API Tokens で、**最小権限**のカスタムトークンを作る(Account Owned Token でもよい)。

| 権限 | レベル | 用途 |
|---|---|---|
| Workers Scripts : Edit | Account | Worker のアップロードと secrets の投入 |
| Workers KV Storage : Edit | Account | KV を wrangler が参照・操作する(デプロイ時の binding 検証)。対象は作成した namespace だけに絞れる場合は絞る |
| Zone : Read | Zone(対象ゾーンのみ) | カスタムドメインを使う場合だけ |
| DNS : Edit | Zone(対象ゾーンのみ) | カスタムドメインを使う場合だけ(DNS レコードと証明書の作成) |

Account Resources は自分のアカウントだけ、Zone Resources は対象ゾーンだけに限定する。権限が不足してデプロイが失敗したら、wrangler のエラーに出る権限名を足す(**権限名と必要な組み合わせは公式ドキュメントで確認すること。ここでは未検証**)。
トークンの値は Secret `CLOUDFLARE_API_TOKEN` に、アカウント ID は `CLOUDFLARE_ACCOUNT_ID` に登録する。

### 2-3. 前段の保護(任意)

Logbutler の前段に Access や MCP Server Portal を置く場合は別途設定する(次節)。Logbutler 自体は DCR 対応の OAuth 付き MCP サーバーとして振る舞い、Access の設定を持たない。

## 3. GitHub に Variables / Secrets を登録する

下流リポジトリの Settings → Secrets and variables → Actions。

| 種別 | 名前 | 必須 |
|---|---|---|
| Variable | `LOGBUTLER_WORKER_NAME` | 必須(未設定だと deploy.yml が動かない) |
| Variable | `LOGBUTLER_KV_NAMESPACE_ID` | 必須 |
| Variable | `LOGBUTLER_BACKLOG_SPACE_HOST` | 必須 |
| Variable | `LOGBUTLER_PUBLIC_BASE_URL` | 必須 |
| Variable | `LOGBUTLER_CUSTOM_DOMAIN` | 任意 |
| Secret | `CLOUDFLARE_API_TOKEN` | 必須 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | 必須 |
| Secret | `BACKLOG_CLIENT_ID` | 必須 |
| Secret | `BACKLOG_CLIENT_SECRET` | 必須 |

登録後、`main` への push か、Actions の `Deploy` を手動実行(workflow_dispatch)でデプロイされる。流れは lint → test → 設定の生成 → `wrangler deploy -c wrangler.deploy.jsonc --secrets-file <一時ファイル>`。
`BACKLOG_CLIENT_ID` / `BACKLOG_CLIENT_SECRET` は、ランナーの一時領域に 0600 の JSON として書かれ、ジョブ終了時に消える(ログには出さない)。`--secrets-file` は追加・更新のみで、ほかの secrets を消さない。
secrets を入れる前にデプロイされると、設定チェックにより `/healthz` が 503(`missing` に 2 つの secret)になる。これは想定どおり。

### デプロイ後の最小確認

```sh
curl -s https://<domain>/healthz                       # {"status":"ok"} と 200
curl -s https://<domain>/.well-known/oauth-protected-resource/mcp   # resource が https://<domain>/mcp
mise run verify:oauth -- https://<domain>/mcp           # OAuth の通し確認(ブラウザで Backlog のログインと同意)
```

`/healthz` が 503 なら、本文の `missing` / `invalid` が直すべき項目(ADR 0010)。`verify:oauth` の使い方は [README](../README.md#実環境の-oauth-確認mise-run-verifyoauth)、続きの確認は [docs/manual-verification.md](manual-verification.md)。

### 2-5. secrets の投入

```sh
pnpm exec wrangler secret put BACKLOG_CLIENT_ID --env production
pnpm exec wrangler secret put BACKLOG_CLIENT_SECRET --env production
```

プロンプトに値を貼る(コマンドラインに値を書かない)。投入後に `/healthz` が 200 になることを 2-6 で確認する。

### 予備の経路: 手元からの手動デプロイ

Actions が使えないときや、検証環境を手元から更新したいとき。値は `mise.local.toml`(gitignore 済み。コミットしない)の `[env]` に書く。

```toml
[env]
LOGBUTLER_WORKER_NAME = "logbutler"
LOGBUTLER_KV_NAMESPACE_ID = "<32 桁の 16 進>"
LOGBUTLER_BACKLOG_SPACE_HOST = "<space>.backlog.com"
LOGBUTLER_PUBLIC_BASE_URL = "https://<domain>"
# LOGBUTLER_CUSTOM_DOMAIN = "<domain>"   # カスタムドメインを使う場合だけ
```

```sh
mise run deploy:render      # wrangler.deploy.jsonc を生成(Cloudflare には何もしない。値の検証もここ)
mise run deploy             # 生成 → wrangler deploy -c wrangler.deploy.jsonc
# secrets(初回と更新時だけ。プロンプトに値を貼る。コマンドラインに値を書かない)
pnpm exec wrangler secret put BACKLOG_CLIENT_ID -c wrangler.deploy.jsonc
pnpm exec wrangler secret put BACKLOG_CLIENT_SECRET -c wrangler.deploy.jsonc
```

`mise run deploy:check` は、環境変数なしでダミー値の設定を生成して `wrangler deploy --dry-run` するだけ(Cloudflare へは何も変更しない)。upstream の CI がこれを使う。

## 4. 前段に Access や Portal を置く場合

Logbutler の前段に Cloudflare Access や MCP Server Portal を置く場合は、Logbutler の外側で別途設定する(この手順書では扱わない。Logbutler は Access 連携を持たない。ADR 0009)。
Logbutler は DCR 対応の OAuth 付き MCP サーバーとして振る舞う。

Portal に登録するときの注意:

- 認証方式は **OAuth(DCR による自動登録)+ Require user auth** にする。各ユーザーが Portal の Connect から自分の Backlog アカウントで認可する(Portal のコールバック `https://<portal-host>/servers-callback` が DCR の `redirect_uri` として登録される)。
- **Access の Managed OAuth は有効にしない**。公式ドキュメントが「自前の OAuth を持つサーバーには使わない」と明記しており、Logbutler は自前の OAuth 認可サーバーである。
- サーバー URL は `https://<domain>/mcp`。ツールを絞るなら `?toolsets=...&read_only=true`(Portal がクエリを保持するかは未検証。manual-verification の P3)。

確認項目は manual-verification の「Portal を使う場合」(P1〜P5)。

## 5. 運用

### 5-1. ログの見方

`wrangler.jsonc` の `observability` で Workers Logs を有効にしている。ダッシュボード(Workers & Pages → logbutler → Logs)か、`mise run deploy:render` のあと `pnpm exec wrangler tail <Worker 名>` で見る。

**トークンやシークレットはログに出ない設計**。アクセストークン・リフレッシュトークン・`client_secret` は grant の `props`(暗号化して KV)にだけあり、エラーメッセージでも伏せる。ログで見る手がかり:

| ログ | 意味 |
|---|---|
| `{"event":"config_invalid","missing":[...],"invalid":[...]}` | 設定チェックの失敗。項目名だけ(値は出ない)。`/healthz` にも同じ内容が出る |
| `tool <名前> failed unexpectedly: ...` | ツールで想定外の例外(トークンは伏せ字) |
| `idempotency cache read/write failed: ...` | 冪等キャッシュ(KV)の失敗。ツールは止まらない |

### 5-2. Backlog の client secret のローテーション

1. Backlog のアプリケーション設定で、クライアントシークレットを再発行できる場合は再発行する(再発行できない場合は、新しいアプリケーションを登録して client id / secret の両方を差し替える。その場合、既存の grant は旧 client id で発行されたリフレッシュトークンを持つため、**全員が再認可**になる)。
2. GitHub の Secrets (`BACKLOG_CLIENT_SECRET`、`BACKLOG_CLIENT_ID` も変えたなら同様)を更新し、`Deploy` を手動実行する(手元なら `pnpm exec wrangler secret put BACKLOG_CLIENT_SECRET -c wrangler.deploy.jsonc`)。secret の更新は新しいバージョンとして即座に反映される。
3. 切り替えの間(Backlog 側で旧シークレットが無効になってから Worker に新しい値が入るまで)は、Backlog のトークン更新が失敗し、MCP のトークン更新が 503(`temporarily_unavailable`)になる。grant は残るので、新しい値を入れれば自然に回復する。間を短くするため、2 を先に準備しておく。
4. `mise run verify:oauth -- https://<domain>/mcp` と、`--refresh-only` で更新できることを確認する。

### 5-3. KV に保存されるもの

`OAUTH_KV` の中身(キーの接頭辞):

| 接頭辞 | 内容 |
|---|---|
| `client:<clientId>` | DCR で登録された MCP クライアント |
| `grant:<backlogUserId>:<grantId>` | ユーザーごとの認可(**Backlog のトークンを含む `props`**。ライブラリが暗号化して保存) |
| `token:<backlogUserId>:<grantId>:<id>` | Worker が発行した MCP のアクセストークン / リフレッシュトークンの記録(ハッシュ) |
| `idem:<backlogUserId>:<ツール名>:...` | 書き込みツールの冪等キャッシュ(TTL 5 分。ツールの結果の JSON。ADR 0005) |

### 5-4. ユーザーの接続を無効化する(grant の削除)

Backlog のユーザー ID を調べ(`logbutler_user_me` の `id`、または Backlog のユーザー管理画面)、そのユーザーの grant とトークンを KV から削除する。

```sh
# 一覧(実際に消す前に確認)
pnpm exec wrangler kv key list --binding OAUTH_KV -c wrangler.deploy.jsonc --remote --prefix "grant:<backlogUserId>:"
pnpm exec wrangler kv key list --binding OAUTH_KV -c wrangler.deploy.jsonc --remote --prefix "token:<backlogUserId>:"
# 削除(1 キーずつ。キー名は一覧の出力から)
pnpm exec wrangler kv key delete "<キー>" --binding OAUTH_KV -c wrangler.deploy.jsonc --remote
```

grant を消すと、そのユーザーの MCP トークンは使えなくなり、リフレッシュもできない(再認可が必要)。Backlog 側の権限も取り消すなら、Backlog の個人設定で、そのアプリケーションの連携を解除してもらう。
全員を無効にしたい場合は、Backlog のアプリケーションを削除する(以降の Backlog トークン更新はすべて失敗する)か、`BACKLOG_CLIENT_SECRET` を変更する。

### 5-5. 障害時の切り分け

まず `curl -s https://<domain>/healthz` で設定の状態を見る。次に、症状から:

| 症状 | 原因の見方 |
|---|---|
| `/healthz` が 503 | 設定の欠け。本文の `missing` / `invalid` の項目を直す(secret の投入、Variables の修正) |
| `/healthz` 以外が 500 `server_misconfigured` | 同上(ログに項目名) |
| MCP クライアントが `/mcp` で 401 を受け、再認可になる | Backlog が 401(トークン失効)のとき、Logbutler は HTTP 401 + `WWW-Authenticate: Bearer error="invalid_token"` を返し、クライアントにリフレッシュさせる。リフレッシュが `invalid_grant` なら Backlog 側で連携が解除された(再認可が必要) |
| ツールが `isError` で `rate_limited`(`retryable: true`) | Backlog が 429(約 1 分 600 回)。`Retry-After` が 10 秒以内なら最大 2 回自動で待つ。それでも 429 なら、そのまま返す。しばらく待つ |
| ツールが `api_error`(`retryable: true`) | Backlog の 5xx、または通信失敗・タイムアウト(30 秒)。Backlog 側の障害を疑う |
| ツールが `permission_error`(403) / `not_found`(404) | そのユーザーの Backlog 権限・存在しない ID |
| ツールが `api_error`(`retryable: false`)で「範囲を絞る」 | 1 回の呼び出しの Backlog API 上限を超えた。対象のプロジェクトや期間を絞る。無料プランの subrequest 上限(50)に当たっている可能性もある(manual-verification V13) |
| `response_too_large` | 応答がサイズ上限を超えた。絞り込むか `max_response_tokens` を指定する(ADR 0007) |
| 認可画面でエラー | `redirect_uri` の不一致(Backlog のアプリ設定の `https://<domain>/callback`)、`PUBLIC_BASE_URL` の誤りが多い。`mise run verify:oauth` の `metadata` 段階が `PUBLIC_BASE_URL` と接続先の食い違いを検出する |

### 5-6. 匿名で呼べるエンドポイント

`/register`(DCR)と `/authorize` の同意画面は、誰でも匿名で呼べる(ADR 0009)。Backlog のログインを通らない限り有効な grant は作られないが、匿名の DCR でも KV にクライアント登録が書き込まれる。
レート制限は Logbutler に実装していない。必要なら前段の Cloudflare WAF / Rate Limiting で `/register` を制限する(manual-verification V16)。

## 6. Terraform などで管理する場合

このリポジトリには Terraform を入れない。Access アプリや Portal を別のリポジトリ(IaC)で管理する場合は、上の「設定値の対応表」の値(ドメイン、`/mcp` の URL、OAuth 方式、Managed OAuth を有効にしないこと)を渡せばよい。
Worker 自体(KV・ドメイン・vars)は `wrangler.jsonc` と Variables から生成する設定(ADR 0011)が定義しており、`Deploy` ワークフロー(または `mise run deploy`)で反映する。Terraform で Worker や KV も管理する場合は、二重管理にならないよう、どちらか一方に寄せる。
