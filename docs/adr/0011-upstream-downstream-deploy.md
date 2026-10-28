# ADR 0011: upstream / 下流モデルとデプロイ設定の生成

- 状態: 採用(2026-10-29、ユーザー決定)
- 関連: ADR 0010(起動時の設定チェック)、`docs/runbook.md`、`scripts/render-wrangler-config/`、`.github/workflows/deploy.yml`

## 背景

このリポジトリは OSS の upstream で、利用者はこれを upstream とする下流のリポジトリを作り、そこでデプロイ CI を動かす。下流は以降も upstream の変更を `git pull` で取り込み続ける。
当初は `wrangler.jsonc` に `env.production`(と検証用の `env.staging`)を置き、運用者が `<...>` を実値に書き換える設計だった。これだと:

- 下流が追跡ファイルを編集するので、upstream が同じ箇所を触るたびに pull が競合する。
- アカウント固有の値(Worker 名、KV id、ドメイン、Backlog スペース)が、公開される upstream に入ってしまう。
- 名前付き環境は `vars` / `kv_namespaces` / `routes` / `observability` を継承しないため、upstream が `observability` や bindings を足しても下流に届かない。

## 決定

要件: (1) 下流は upstream の追跡ファイルを編集しない、(2) アカウント固有の値は upstream に置かない、(3) upstream の実行時設定(`compatibility_date`・`compatibility_flags`・`main`・`observability`・bindings の追加など)は pull だけで下流に届く、(4) 下流の運用者は GitHub Actions の Variables / Secrets を登録するだけ。

方式: **デプロイのたびに、upstream の `wrangler.jsonc` と環境変数から、デプロイ用の設定を gitignore 済みのファイルに生成し、`wrangler deploy -c <生成物>` する。**

| 何を | どこに置くか |
|---|---|
| `main`・`compatibility_*`・`observability`・ほかの bindings・vars の追加 | upstream の `wrangler.jsonc`(トップレベル。ローカル開発・テストが読むダミー値のまま)。生成時にそのまま引き継ぐ |
| Worker 名・KV id・`BACKLOG_SPACE_HOST`・`PUBLIC_BASE_URL`・カスタムドメイン | 環境変数 `LOGBUTLER_WORKER_NAME` / `LOGBUTLER_KV_NAMESPACE_ID` / `LOGBUTLER_BACKLOG_SPACE_HOST` / `LOGBUTLER_PUBLIC_BASE_URL` / `LOGBUTLER_CUSTOM_DOMAIN`(任意)。CI は GitHub の Variables、手元は `mise.local.toml` の `[env]` |
| `BACKLOG_CLIENT_ID` / `BACKLOG_CLIENT_SECRET` | CI は GitHub の Secrets から `wrangler deploy --secrets-file`(ランナーの一時ファイル、0600、ジョブ終了で消える)。手元は `wrangler secret put -c <生成物>` |
| Cloudflare の認証 | Secrets の `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` |
| 生成物 | `wrangler.deploy.jsonc`(`.gitignore` の `wrangler.deploy*.jsonc`)。`main` の相対パスが解決されるようリポジトリ直下に置く |

- 生成は `scripts/render-wrangler-config/`(`core.ts` が純粋な変換と検証、`main.ts` が入出力)。`wrangler.jsonc` の `env` ブロックは持ち越さず、フラットな設定にする。差し替えるのは `name`、`kv_namespaces` の `OAUTH_KV` の id、`vars` の 2 つ、`routes` / `workers_dev` だけ(カスタムドメインがあれば `{pattern, custom_domain: true}` と `workers_dev: false`、なければ `workers_dev: true`)。それ以外のキーは `wrangler.jsonc` のものがそのまま届く。
- 必須値の欠け・形式不正・`<...>` の残存は、**項目名と理由だけ**を出して非 0 で終了する(値は出さない)。
- `mise run deploy:check` は `--example` で固定のダミー値から `wrangler.deploy.example.jsonc` を生成し、`wrangler deploy --dry-run` する。upstream の CI は Variables を持たないのでこれを使う。
- `.github/workflows/deploy.yml` は、Variable `LOGBUTLER_WORKER_NAME` が空のとき(= upstream)ジョブごと飛ばす。

## 却下した案

- **下流が `wrangler.jsonc` を直接編集する**: upstream が同じファイルを変えるたびに pull が競合する。アカウント固有の値が upstream の履歴にも入りうる。
- **CLI フラグだけで渡す(`--name` / `--var` / `--routes` / `--domain` など)**: wrangler 4.151.0 では KV namespace の id をフラグで上書きできない(調査済み)。
- **`env.production` を upstream に残し、下流が書き換える / 上書きファイルを足す**: 名前付き環境は継承されず、upstream の実行時設定の追加が届かない。下流がファイルを足すのも、運用者の作業を増やす。
- **JSONC パーサー依存を足す**: 必要なのはコメントと末尾カンマの除去だけで、`core.ts` の十数行で済むので、新しい依存は足さない(文字列内の `//` `/*` は壊さないテストあり)。

## 結果と注意

- upstream のトップレベル設定を変えれば、下流は pull して次のデプロイで反映される。KV やドメインを変えたいときは Variables を変える。
- `wrangler deploy` は設定にない `vars` を消す(`--keep-vars` なし)。ダッシュボードで手動追加した vars は消えるので、必要な vars は upstream の `wrangler.jsonc` に足す。
- 未確認: Backlog のアプリが複数のリダイレクト URI を持てるか(runbook に記載)。Cloudflare API トークンの最小権限の厳密な組み合わせ(runbook は公式での確認を促している)。
