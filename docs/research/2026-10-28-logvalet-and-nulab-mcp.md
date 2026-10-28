# 調査メモ: logvalet の移植対象と Nulab 公式 MCP との比較（2026-10-28）

計画の前提になった調査結果。パスは logvalet リポジトリ（`~/src/github.com/youyo/logvalet`）からの相対パス。

## 1. logvalet の MCP

### ツール（71 個）
正は `internal/mcp/testdata/tools_list_baseline.json`。カテゴリは `internal/mcp/tool_categories.go`（コメントの「76」などの数字は古く、実数は 71）。

| カテゴリ | ツール |
|---|---|
| space (R3) | info, digest, disk_usage |
| project (R5) | list, get, health, blockers, conventions |
| team (R3) / user (R5) | list, get, workload, me, activity など |
| activity (R3) / search (R1) / digest (R3) / my_tasks (R1) | |
| issue (18) | R: list, get, context, timeline, triage_materials, stale, attachment_list, attachment_download, related_list, comment_list / 書き込み非冪等: create, comment_add, attachment_upload / 冪等: update, comment_update, related_add / 破壊的: attachment_delete, related_delete |
| document (6) | R: list, get, tree, digest, search / 書き込み: create |
| shared_file (R2) / meta (R5) / wiki (R8) | |
| watching (7) | R: list, get, count / 冪等: add, update, mark_as_read / 破壊的: delete |
| star (1) | star_add |

### Backlog API の呼び出し回数（Workers のサブリクエストと Backlog のレート制限に関係）
- `digest_unified`: 最悪 約 2,000 回超（ユーザー × 活動ページ）。課題は最大 100 ページ、活動はユーザー/プロジェクトごとに errgroup で並列（`internal/digest/unified.go:305, :348`、`activity_filter.go:9-10`）
- `user_activity` / `activity_stats`: since/until 指定時は上限なくページング（`internal/backlog/fetch_activities.go:14-30`、`internal/analysis/activity_stats.go:193-225`）
- `search`: 3 + プロジェクト数（Wiki をプロジェクトごとに逐次取得。`internal/digest/search.go:213, :309`）
- `project_health`: 固定 8、`include_comments=true` で最大 28
- 固定回数: triage_materials 5、my_tasks 4、issue_context 3、document_digest 3、issue_timeline 2+最大 5、ほか 2 前後
- Backlog は「1 ユーザーのリクエストは直列に」と案内している（https://developer.nulab.com/docs/backlog/rate-limit/ 。原文は未取得）

### 不具合の疑い
`fetchProjectIssues`（`internal/analysis/analysis.go:97-100`）が ListIssues に Limit を渡さず、`http_client.go:389-391` は Limit>0 のときだけ `count` を付ける。Backlog の既定は 20 件なので、stale / blocker / workload / ambiguity / triage は 20 件で打ち切られている可能性が高い（実挙動は未検証）。

### その他
- MCP は `internal/render` を使わない（出力は `json.Marshal` のみ、`internal/mcp/tools.go:144`）
- ファイルシステム依存は CLI 専用。例外は `issue_attachment_upload` の `file_paths`（`internal/mcp/tools_issue.go:708-741`）で、Workers では不可。`file_content_base64` は上限 4MB。ダウンロードの上限は 20MB
- Backlog クライアント: 約 39 パス、multipart は `POST /api/v2/space/attachment` の 1 箇所のみ。非公開 API の relatedIssues を使用（logvalet `docs/adr/0003`）。リトライなし、429 は `ErrRateLimited` に変換するだけで `Retry-After` は未対応。タイムアウト 30 秒
- OAuth（`internal/credentials/oauth.go`）: 認可 URL `https://{space}.backlog.com/OAuth2AccessRequest.action`（scope なし）、コード交換は client_secret をフォームで送信。**リフレッシュは未実装**。しかも本番コードから呼ばれていない（MCP の HTTP モードは Bearer をそのまま転送する passthrough）
- golden: `internal/mcp/testdata/tools_list_baseline.json`（名前・スキーマ・annotation・順序）、`internal/digest/testdata/document_search_snippet.json`、`internal/conventions/testdata/skeleton.golden.yaml`。discover のレスポンスは `internal/mcp/discover_test.go` に直接書かれている

## 2. Nulab 公式 MCP（nulab/backlog-mcp-server）

- v0.23.3（2026-10-27）、MIT、TypeScript。ツール 64 個
- トランスポート: stdio が既定。Streamable HTTP（ステートレス、2026-07-28 と旧版に対応）
- 認証: API キー、または OAuth 2.0（クライアント登録とトークンを**メモリに保持**するので再起動で消える。単一組織のみ）
- Nulab がホストするリモート MCP は見つからなかった
- 仕組み: toolset（space / project / issue / wiki / git / notifications / document）、一覧系の `fields`（トップレベルのフィールドだけ選べる）、応答の圧縮（null・空を削除）、`MAX_TOKENS`（既定 50,000、正規表現で推定）、ツール名の動詞から annotation を自動で付ける、説明文の上書き、ツール名の接頭辞、マルチ組織
- 情報源: https://github.com/nulab/backlog-mcp-server 、`src/tools/tools.ts`、`src/utils/fieldSelection.ts`、`src/utils/tokenCounter.ts`、`src/utils/toolAnnotations.ts`

### 公式にあって logvalet にないツール
get_project_users、add/update_project、count_issues、delete_issue、get_priorities、get_resolutions、add_category、add/update/delete version_milestone、add/update_wiki、Git/PR 系 10 個、get_document_comments、通知系 4 個、get_user_stars_count

### logvalet にしかないもの
digest / 分析系（health, blockers, stale, workload, triage, context, timeline, my_tasks, activity_stats）、conventions、横断検索、Wiki の補助読み取り（tags, history, stars, attachments）、添付のアップロード/削除、共有ファイル、team、IdempotencyCache、ツールごとの annotation とカテゴリ

### 取り込みの決定（ユーザー判断、2026-10-28）
- 取り込む: 通知（4 ツール）、優先度・完了理由の一覧、プロジェクトメンバー一覧、応答サイズの制御（`fields`・トークン上限）、toolset
- 後回し: Git / PR の読み取り・書き込み、Wiki の書き込み
- 取り込まない: delete_issue、プロジェクト/マイルストーン/カテゴリの編集、説明文の上書き、マルチ組織

## 3. Cloudflare 側の前提（ドキュメントで確認）
- MCP Server Portals は DCR がない上流にも「手動クレデンシャル」で OAuth できる（2026-07-31〜）。ただしユーザーのトークンが切れたら再認証を求める仕様で、ユーザーのトークンを自動リフレッシュするとは書かれていない（管理者のトークンは自動リフレッシュされる）
- `agents/mcp/server` の `createMcpHandler` はステートレスで、DO もセッションも不要。`McpAgent` は v0.20.0 で非推奨
- `@cloudflare/workers-oauth-provider` v1（2026-10-01）: 認可サーバーとリソースサーバーを分けられる。upstream sign-in のヘルパー（`beginUpstream` / `finishUpstream`）と `tokenExchangeCallback` で、上流のトークンをリフレッシュできる
- `createMcpHandler` の戻り値をそのまま `export default` しないこと（Wrangler が WorkerEntrypoint と解釈する）
