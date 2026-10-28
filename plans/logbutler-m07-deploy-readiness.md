# M07: デプロイ準備と運用手順（実デプロイなし）

ロードマップ: `plans/logbutler-roadmap.md`。前提: M06 完了。
ユーザー指示（2026-10-28）: **実デプロイはしない**。「うまくいった仮定で進めてよい」。よって M07 の完了条件は、デプロイできる状態の設定・手順・確認リストが揃い、dry-run が通ることとする
（ロードマップの元の完了条件「Portal 経由で実 Backlog に対して読み取りツールが動く」は、実機確認リストとして手順書に残し、ユーザーが実施する）。

**追記（2026-10-28）**: ユーザーがあとで検証用の環境を用意する。用意できたら、`docs/manual-verification.md` の確認リストをその環境で実施し、結果を記入する（実施はユーザーの指示を受けてから。手順書はその環境でそのまま使える粒度で書く）。

**追記（2026-10-28、責務の範囲の改訂）**: Access 連携は M06 で削除済みの前提。Access のアプリ設定と MCP Server Portal への登録は Logbutler の外側で別に管理するため、**手順書から Access・Portal の設定手順を外す**（「Logbutler の前段に Access や Portal を置く場合は別途設定する。Logbutler は DCR 対応の OAuth 付き MCP サーバーとして振る舞う」と 1 段落書くだけ）。実機確認リストの Portal 関連項目は「Portal を使う場合」の項目として残し、次を含める: (a) Portal に「OAuth（DCR 自動登録）+ Require user auth」で登録でき、ツールが同期されること (b) 各ユーザーが Portal の Connect から自分の Backlog アカウントで認可できること（Portal のコールバック `https://<portal-host>/servers-callback` が DCR の redirect_uri として登録されること）(c) Portal がクエリ付き URL（`?toolsets=...&read_only=true`）を保持するか (d) Portal のクエリ（`optimize_context`、`codemode`）と Logbutler のクエリが衝突しないこと (e) Access の Managed OAuth は**有効にしない**こと（公式に「自前の OAuth を持つサーバーには使わない」とある）を手順書に明記。参照: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/ 、https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/以下の本文で Access・Portal に触れている箇所はこの追記を優先する。

## 目的

ユーザーが手順書どおりに作業すれば、本番環境（Cloudflare Workers + KV + Access + MCP Server Portal）で Logbutler を動かせる状態にする。

## 対象範囲

### 1. 本番用の設定
- `wrangler.jsonc` に本番環境（`env.production` など）を追加: KV namespace の id、カスタムドメインの route、vars（`BACKLOG_SPACE_HOST`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`PUBLIC_BASE_URL`）。実値はプレースホルダ（`<...>`）にし、どこを書き換えるかをコメントで示す。秘密情報（`BACKLOG_CLIENT_ID` / `BACKLOG_CLIENT_SECRET`）は `wrangler secret put` で入れる旨
- `observability`（Workers Logs）を有効にする設定
- `mise.toml` のタスク: `deploy`（`wrangler deploy --env production`。実行はユーザー）、`deploy:check`（`wrangler deploy --env production --dry-run`。M07 の完了条件で実行する）
- 起動時の設定チェック: 必須の vars / secrets / KV binding が欠けていたら、`/healthz` 以外を 500 にして詳細はログへ（テストを先に）。`/healthz` に設定チェックの結果（ok / 欠けている項目名だけ。値は出さない）を含めるかは判断して ADR に

### 2. CI（push はしない。ファイルを用意するだけ）
- `.github/workflows/ci.yml`: mise をセットアップし、`mise run lint` と `mise run test` と `mise run deploy:check` を実行（秘密情報不要の dry-run）
- アクションはバージョンをコミット SHA で固定する

### 3. 手順書 `docs/runbook.md`
1. Backlog 側: OAuth アプリの登録（リダイレクト URI は `https://<domain>/callback`）、client id / secret の取得
2. Cloudflare 側:
   - KV namespace の作成と id の反映
   - カスタムドメインの設定
   - Access の self-hosted アプリ: 保護するのは `/authorize` と `/callback` だけ。`/mcp`・`/token`・`/register`・`/.well-known/*`・`/healthz` は Bypass。Application Audience（AUD）を `ACCESS_AUD` に
   - secrets の投入、`mise run deploy`
3. MCP Server Portal への登録: サーバー URL（`https://<domain>/mcp`。必要なら `?toolsets=...&read_only=true`）、DCR による自動登録、Portal 経由での接続確認
4. 運用: ログの見方（トークンは出ない設計であること）、Backlog の client secret のローテーション手順、KV に保存されるもの（grant / token / 冪等キャッシュ `idem:`）、ユーザーの接続を無効化する方法（grant の削除）、障害時の切り分け（Backlog 側の 401 / 429 / 5xx の見え方）
5. Terraform で管理する場合の注意（このリポジトリには入れない。Access アプリ・Portal を別リポジトリで管理するなら、上記の設定値の対応表を示すだけ）

### 4. 実機確認リスト `docs/manual-verification.md`
これまでの ADR に「未検証の前提」として書いたものを集約し、確認手順と期待結果、結果の記入欄を付ける。最低限:
- Backlog のリフレッシュトークンがローテーションするか（ADR 0001）、実際の `expires_in`
- KV の結果整合性がリフレッシュ直後のトークン利用に影響しないか（ADR 0001）
- `priorityId` を送らない issue_create が通るか（ADR 0005 / tool-diff）
- 未公開 API（relatedIssues）の実際の応答
- Portal がクエリ付き URL を保持するか、DCR の `application_type`、スコープ、CIMD（ADR 0002 / 0008）
- 20 MiB ダウンロードと 4 MiB アップロードの workerd 上のメモリ・時間
- Backlog の 429 の実際の `Retry-After`
- 有料プランの subrequest 上限と分析系の maxApiCalls（ADR 0006）
- 読み取りツールが Portal 経由で実 Backlog に対して動くこと（ロードマップの元の M07 完了条件）
各 ADR の該当箇所から、このリストへのリンクを張る

### 4.5 OAuth の実環境確認用 CLI（`mise run verify:oauth`）
- 実環境（ユーザーが用意する検証環境）で OAuth を確かめるための、テスト用の小さな MCP クライアント。人が操作するのはブラウザでの Access と Backlog のログイン・同意の 1 回だけにする
- 流れ: DCR（`application_type: "native"`、redirect_uri は `http://127.0.0.1:<空きポート>/callback`）→ PKCE（S256）で認可 URL を作って表示・ブラウザで開く → localhost でコールバックを受ける（`state` と `iss` を検証）→ `/token` → MCP 2026-07-28 レーンで `tools/list`・`logbutler_user_me` → refresh_token で更新し、新しいアクセストークンで再度 `logbutler_user_me` → 結果（各段階の成否、トークンの有効期限、リフレッシュでトークンが変わったか）を表示
- 引数: 対象の URL（例 `https://<domain>/mcp`）、`--refresh-only`（保存済みのリフレッシュトークンで更新だけを試す。Backlog のトークン期限切れ後の確認用）
- トークンは標準出力に出さない（先頭数文字のみ）。保存する場合は gitignore 済みのローカルファイルにし、README で注意する
- テスト: CLI 自体を、テスト内の Worker（既存の E2E 基盤とモックの Backlog / Access）に対して E2E で動かす（ブラウザ操作の段はテストから `/authorize` → `/callback` を直接たどる差し込み口を用意）。TDD で Red を先に確認する
- 手順書と `docs/manual-verification.md` から、この CLI の使い方へリンクする
- 制約: Access のサービストークンは使えない（`/callback` で Access のメールアドレスの一致を確認しているため）。人が 1 回ログインする前提で手順書に書く

### 5. ドキュメントの仕上げ
- README: 製品説明、構成図（テキスト）、ツール一覧（toolset ごと、件数）、接続 URL のクエリ、ツール引数（timezone、max_response_tokens）、開発コマンド、商標の注記（Backlog は株式会社ヌーラボの商標で、本プロジェクトは無関係）
- CLAUDE.md: 構成と規約を最新に
- `docs/tool-diff-from-logvalet.md`: 全マイルストーン分が揃っているか見直す

## 完了条件
- `mise run test`（unit + e2e）と `mise run lint` と `mise run deploy:check` が通る
- 設定チェックの unit + E2E（テストを先に）
- 上記ドキュメントが揃い、手順書の各手順に対応する設定値がリポジトリ内の設定と一致している（verifier が突き合わせる）

## TDD
コードの変更（設定チェック）は unit・E2E とも実装前に Red を確認する（ユーザーの明示要求）。

## やってはいけないこと
- 実デプロイ（`wrangler deploy` の非 dry-run、`wrangler secret put`、KV の作成など Cloudflare への変更）
- 別リポジトリ（cloudflare-infra など）の変更、push、リモートリポジトリの作成
- 実 Backlog への通信、テストを弱める・skip・削除、logvalet の変更、Durable Objects
