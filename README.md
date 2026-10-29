# Logbutler

**Your AI Butler for Backlog** — Backlog を AI エージェントから使うための Remote MCP サーバー。
Cloudflare Workers 上で動き、利用者ごとに自分の Backlog アカウントで OAuth 認可する。
前段に Cloudflare MCP Server Portals を置いても、MCP クライアントから直接つないでもよい(Logbutler は DCR 対応の OAuth 付き MCP サーバーとして振る舞う)。

Go 製の Backlog CLI [logvalet](https://github.com/youyo/logvalet) が持つ Remote MCP 機能を TypeScript に移植したもので、
**86 個のツール**(課題・プロジェクト・Wiki・ドキュメント・分析・digest など)を持つ。logvalet との差分は [docs/tool-diff-from-logvalet.md](docs/tool-diff-from-logvalet.md)。

> **商標について**: Backlog は株式会社ヌーラボの登録商標です。Logbutler は個人プロジェクトであり、株式会社ヌーラボとは無関係です。

## 構成

- Cloudflare Workers + KV + Hono。Durable Objects は使わない
- Worker 自身が OAuth 2.1 認可サーバー(`@cloudflare/workers-oauth-provider`)になり、上流の IdP は Backlog OAuth 2.0
- MCP は `agents` の `createMcpHandler` によるステートレス実装(`@modelcontextprotocol/server` v2)。MCP 2026-07-28 と旧版の両方に対応
- 1 デプロイ = 1 Backlog スペース(`BACKLOG_SPACE_HOST`)

```
MCP クライアント(Portal など)
   │  /register(DCR) /token /mcp /.well-known/*
   ▼
┌───────────────────────── Logbutler(Cloudflare Worker) ─────────────────────────┐
│ OAuthProvider ──▶ /mcp: Worker 発行トークンを検証 ──▶ MCP サーバー(86 ツール)       │
│       │                                              │                           │
│       │ /authorize /callback /healthz (Hono)          └─▶ Backlog API(利用者のトークン) │
│       ▼                                                                          │
│   KV(OAUTH_KV): クライアント登録・grant(Backlog トークンを含む)・冪等キャッシュ      │
└──────────────────────────────────────────────────────────────────────────────────┘
利用者のブラウザ ──/authorize(同意画面) → Backlog でログイン・同意 → /callback──▶ Worker
```

設計の理由は `docs/adr/` を参照。

- [ADR 0001: Worker 自身を OAuth 認可サーバーにする](docs/adr/0001-oauth-server-in-worker.md)
- [ADR 0002: 認可サーバーと MCP サーバーを 1 つの Worker に同居させる](docs/adr/0002-single-worker-auth-and-mcp.md)
- [ADR 0003: Backlog クライアントの直列化・リトライ・呼び出し上限](docs/adr/0003-backlog-client-serialization-and-retry.md)
- [ADR 0004: ツールの出力形式とエラー形式](docs/adr/0004-tool-output-and-error-format.md)
- [ADR 0005: 書き込みツールの冪等キャッシュ(KV)](docs/adr/0005-idempotency-cache-on-kv.md)
- [ADR 0006: 分析系のページングと呼び出し予算](docs/adr/0006-analysis-paging-and-call-budget.md)
- [ADR 0007: 応答サイズの上限](docs/adr/0007-response-size-limit.md)
- [ADR 0008: 設定のクライアント制御化と MCP 2026-07-28 準拠](docs/adr/0008-client-side-control-and-mcp-2026.md)
- [ADR 0009: Cloudflare Access 連携の削除](docs/adr/0009-remove-cloudflare-access.md)
- [ADR 0010: 起動時の設定チェック](docs/adr/0010-startup-config-check.md)

## ドキュメント

- 下流リポジトリのセットアップは、エージェント(Claude Code / Codex)に「下流のセットアップを手伝って」と頼むと、同梱のスキル(`.claude/skills/logbutler-setup/`)が手順を案内する
- [デプロイと運用の手順書](docs/runbook.md)(Backlog の OAuth アプリ登録、KV・ドメイン・secrets・デプロイ、運用)
- [実機確認リスト](docs/manual-verification.md)(実デプロイしていないため未検証の前提と、その確認手順・記入欄)

## ツール(86 個)

`toolsets` で絞り込める(下の「接続 URL のクエリ」)。書き込み・破壊的ツールは `read_only=true` で非公開にできる。`project_settings`(カテゴリー・バージョン・状態・カスタム属性の追加・更新・削除。Backlog の管理者権限が必要)も既定で公開され、`read_only=true` で隠れる(ADR 0013)。

| toolset | 件数 | ツール(接頭辞 `logbutler_` を省略) |
|---|---|---|
| `issue` | 14 | `issue_get` `issue_list` `issue_comment_list` `issue_attachment_list` `issue_attachment_download` `issue_related_list` `issue_create` `issue_update` `issue_comment_add` `issue_comment_update` `issue_related_add` `issue_related_delete` `issue_attachment_delete` `issue_attachment_upload` |
| `project` | 4 | `project_get` `project_list` `project_conventions` `project_users` |
| `user` | 3 | `user_me` `user_list` `user_get` |
| `activity` | 2 | `activity_list` `user_activity` |
| `document` | 4 | `document_get` `document_list` `document_tree` `document_create` |
| `team` | 3 | `team_list` `team_get` `team_project` |
| `space` | 2 | `space_info` `space_disk_usage` |
| `meta` | 5 | `meta_statuses` `meta_issue_types` `meta_categories` `meta_version` `meta_custom_field` |
| `shared_file` | 2 | `shared_file_list` `shared_file_download` |
| `star` | 1 | `star_add` |
| `watching` | 7 | `watching_list` `watching_get` `watching_count` `watching_add` `watching_update` `watching_delete` `watching_mark_as_read` |
| `wiki` | 8 | `wiki_list` `wiki_get` `wiki_count` `wiki_tags` `wiki_history` `wiki_stars` `wiki_attachment_list` `wiki_sharedfile_list` |
| `analysis` | 11 | `issue_context` `project_blockers` `issue_stale` `project_health` `issue_triage_materials` `digest_weekly` `digest_daily` `activity_stats` `issue_timeline` `user_workload` `my_tasks` |
| `digest` | 4 | `space_digest` `document_digest` `activity_digest` `digest_unified` |
| `search` | 2 | `document_search` `search` |
| `notification` | 2 | `notification_list` `notification_count` |
| `project_settings` | 12 | `category_add` `category_update` `category_delete` `version_add` `version_update` `version_delete` `status_add` `status_update` `status_delete` `custom_field_add` `custom_field_update` `custom_field_delete` |

## 開発


ランタイムとコマンドは [mise](https://mise.jdx.dev/) で管理する(`mise.toml`)。

```sh
mise install            # node / pnpm
mise run install        # 依存パッケージ
mise run test           # unit + e2e
mise run lint           # Biome + tsc
mise run fmt            # Biome で整形
mise run build          # デプロイせずバンドルできるか確認 (wrangler deploy --dry-run)
mise run deploy:check   # ダミー値でデプロイ設定を生成して dry-run。Cloudflare には何も変更しない
mise run deploy:render  # LOGBUTLER_* からデプロイ用設定(wrangler.deploy.jsonc)を生成
mise run deploy         # 生成してデプロイ(実行はユーザー。下流のデプロイは GitHub Actions。手順は docs/runbook.md)
mise run verify:oauth -- https://<domain>/mcp   # 実環境の OAuth 確認(下記)
LOGBUTLER_LIVE_PROJECT_KEY=<KEY> mise run test:live   # 実環境 E2E(デプロイ済み Worker + 実 Backlog。test には含めない。下記)
mise run dev            # wrangler dev
```

- テストは `@cloudflare/vitest-plugin`(旧 `@cloudflare/vitest-pool-workers`)で workerd 上で動く。
  E2E は Worker 全体(`src/index.ts` の default export)へ HTTP を送り、Backlog への outbound fetch だけをモックする。実 Backlog へは通信しない。
- lint / 整形は Biome(単一ツールで設定が小さく、型検査は `tsc` で別に行うため)。
- 依存パッケージは公開から 2 週間以上たった正確なバージョンに固定している(`^` / `~` は使わない)。

### 環境変数・バインディング

| 名前 | 種別 | 説明 |
|---|---|---|
| `OAUTH_KV` | KV | OAuth の grant・トークン・クライアント登録・冪等キャッシュ |
| `BACKLOG_SPACE_HOST` | var | 例 `example.backlog.com` |
| `PUBLIC_BASE_URL` | var | この Worker の公開オリジン(例 `https://logbutler.example.com`)。issuer とリソース識別子になる |
| `BACKLOG_CLIENT_ID` | secret | Backlog OAuth クライアント ID |
| `BACKLOG_CLIENT_SECRET` | secret | Backlog OAuth クライアントシークレット |

### 接続 URL のクエリとツール引数(クライアントが決める設定)

運用者の環境変数ではなく、クライアント(Portal に登録する URL、呼び出しごとの引数)が決める。

| 設定 | 置き場所 | 説明 |
|---|---|---|
| `toolsets` | `/mcp` の URL クエリ | 公開するツールのグループ(カンマ区切り、既定 `all`)。例 `/mcp?toolsets=issue,wiki`。`issue` `project` `user` `activity` `document` `team` `space` `meta` `shared_file` `star` `watching` `wiki` `analysis` `digest` `search` `notification` `project_settings` |
| `read_only` | `/mcp` の URL クエリ | `true` で書き込み・破壊的ツールを公開しない(既定 `false`)。例 `/mcp?toolsets=issue&read_only=true` |
| `timezone` | ツール引数 | 「今日」「今週」の基準になる IANA 名(省略時 `Asia/Tokyo`)。`issue_list` `my_tasks` `digest_daily` `digest_weekly` `activity_stats` `issue_timeline` `activity_digest` `user_activity` `digest_unified` にある |
| `max_response_tokens` | ツール引数 | 応答サイズの安全網(推定トークン数。省略時 50000、`0` で無効)。超えると切り詰めずに `response_too_large`(`retryable: false`)のエラーを返す。読み取りツールにある(ダウンロード系 2 個を除く)。書き込み系は対象外。`issue_list` の count が大きいときや分析ツールで複数プロジェクトを指定したときは上限を超えうる。その場合は絞り込むか `max_response_tokens` を指定する。ADR 0007 |

不正なクエリ値(未知の toolset 名、`read_only` が `true`/`false` 以外)は 400 で、理由を本文に返す。公開されるツールが 0 個になる組み合わせ(`toolsets=project_settings&read_only=true`、`toolsets=star&read_only=true` など。書き込みだけの toolset を読み取り専用にした場合)も 400(ツールが 0 個だと MCP サーバーが tools capability を宣言せず、tools/list が 404 になるため)。不正な `timezone` は `argument_error`。

**`read_only` の綴りを間違えると効かない**(未知のクエリは無視されるため)。そこで、まぎらわしい綴り(`readonly` `readOnly` `READ_ONLY` `read-only`、`tool_sets` `Toolsets` など。小文字にして `_` と `-` を除くと `read_only` / `toolsets` に一致するもの)は 400 にして、正しいキー名を案内する。それ以外の未知のクエリは従来どおり無視する。
詳細と未検証の前提は ADR 0008。

ローカルでは `.dev.vars.example` をコピーして `.dev.vars` を作る(コミットしない)。
必須の設定が欠けている(またはプレースホルダ `<...>` のまま)と、`/healthz` 以外は 500 になる。`/healthz` は 503 で欠けた項目名を返す(値は出さない。ADR 0010)。

### 利用者の制限

Logbutler は Backlog OAuth で認可する MCP サーバーだけを担い、Cloudflare Access 連携は持たない(ADR 0009)。
利用できる人の制限は Logbutler の外側(MCP Server Portal の Access ポリシーなど)で行う。

注意: `/register`(DCR)と `/authorize`(同意画面の表示)は誰でも匿名で呼べる。Backlog の OAuth ログインが要るため不正な grant は作られないが、
匿名の DCR で KV にクライアント登録が書き込まれる。レート制限は Logbutler では実装しないので、必要なら前段の Cloudflare WAF / Rate Limiting で行う(ADR 0009)。

## 実環境の OAuth 確認(`mise run verify:oauth`)

デプロイした環境(または `wrangler dev`)に対して、MCP クライアントと同じ手順で OAuth を通す小さな CLI。
DCR(`application_type: "native"`、redirect_uri は `http://127.0.0.1:<空きポート>/callback`)→ PKCE(S256)→ ブラウザで Backlog のログインと同意(人が操作するのはここだけ)→
ループバックのコールバック(`state` と `iss` を検証)→ `/token` → MCP 2026-07-28 レーンで `tools/list` と `logbutler_user_me` → refresh_token で更新 → 新しいトークンで再度 `logbutler_user_me`。

```sh
mise run verify:oauth -- https://<domain>/mcp
mise run verify:oauth -- "https://<domain>/mcp?toolsets=issue&read_only=true"   # クエリつき(クエリが /mcp まで届くかの確認にもなる)
mise run verify:oauth -- https://<domain>/mcp --refresh-only                     # 保存済みの状態で更新だけを試す(Backlog のトークン期限切れ後の確認用)
```

- 結果は各段階の成否、トークンの有効期限(`expires_in`)、リフレッシュでトークンが変わったかを表示する。終了コードは成功で 0、失敗で 1。
- **トークンは標準出力に出さない**(先頭 4 文字と長さだけ)。
- `--refresh-only` のために、クライアント ID とリフレッシュトークンを `.verify-oauth.local.json`(`--state-file` で変更可)に保存する。
  **このファイルはリフレッシュトークンを含む**。`.gitignore` 済み(`*.local.json`)で、権限は 0600。コミット・共有しない。使い終わったら削除し、不要になった grant は Logbutler 側で失効させる(runbook 参照)。
  `--state-file` で保存先を変える場合は `*.local.json` の名前にする（gitignore 対象。リフレッシュトークンを含むため）。
- 実 Backlog への通信が発生する(検証環境に対して実行する)。テストでは Worker とモック Backlog に対して動かしている(`test/e2e/verify-oauth.test.ts`)。

## 状態

M01〜M07 まで実装済み。**実デプロイはまだしていない**。デプロイできる状態の設定・手順・確認リストを用意してあり、
Backlog のリフレッシュトークンのローテーション有無、KV の結果整合性の影響、Portal 経由の挙動などは未検証で、[docs/manual-verification.md](docs/manual-verification.md) に集約している。

## 実環境 E2E(`mise run test:live`)

デプロイ済みの Worker(`verify:oauth` が保存した状態ファイルの `mcpUrl`)と**実 Backlog**に対して、全ツールを呼ぶスイート(`test/live/`)。unit / e2e が Backlog をモックしているため見つからない、実 Backlog の仕様との食い違いを探す。`mise run test` と CI には含めない。

```bash
mise run verify:oauth -- https://<domain>/mcp   # 先に認証して状態ファイルを保存する
LOGBUTLER_LIVE_PROJECT_KEY=<書き込んでよいテスト用プロジェクトのキー> mise run test:live
```

- `LOGBUTLER_LIVE_PROJECT_KEY`(必須。未設定ならスイート全体が失敗する)。書き込みはこのプロジェクト内の、スイートが作った課題・ドキュメントにだけ行う(summary に `[live <実行時刻>]`)。
- `LOGBUTLER_LIVE_STATE_FILE`(既定 `.verify-oauth.local.json`)。リフレッシュトークンは接続時に更新し、ローテーション後の値を同じファイルへ 0600 で書き戻す。実際の MCP クライアントと同じく、`/mcp` が 401 を返したら 1 回だけ更新して再試行する(2 回目も 401 ならエラー)。
- 状態・プロジェクト設定(状態名・課題種別・優先度など)は実行時に `logbutler_meta_*` などで取得し、ID を決め打ちしない。
- 課題・ドキュメントは削除しない(削除するツールがないため)。プロジェクト設定(カテゴリー・バージョン・状態・カスタム属性)は、スイートが `[live <実行時刻>]` つきで作ったものだけを追加 → 更新 → 削除し、失敗時も `afterAll` で消す。**Backlog の管理者権限が必要**。1 回の実行でおよそ 400 リクエスト。
- 対象外: 共有ファイル系(2FA 設定時に別パスワードが必要)と Wiki 系(このスペースで有効化できない)。
