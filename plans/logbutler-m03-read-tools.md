# M03: 読み取りツール（単純系）

ロードマップ: `plans/logbutler-roadmap.md`。前提: M02（Backlog クライアント・エラーエンベロープ・ツール登録・スナップショット）が完了していること。

## 目的

logvalet の読み取りツールのうち「Backlog API を呼んで結果をほぼそのまま返す」単純系 38 個（実装済みの `user_me` を含む）を、
M02 の仕組みに載せて移植する。加工・集計を伴う 19 個は M05 で扱う。

## M02 からの持ち越し（verifier の minor 指摘。最初に片付ける。テストを先に）

1. `test/helpers/baseline.ts` の `compareWithBaseline`: 差分が property 単位で分かるよう、期待値と実際の値（または diff）を返す。`required` と `enum` の配列順の扱い（順序を無視して比べるか）を決めて ADR 0004 に追記する
2. `src/backlog/client.ts`: タイムアウトが応答ヘッダーまでしか効かない。本文の読み取り（`res.json()` / `res.text()` / ダウンロードのストリーム）も同じ期限で守る
3. `src/mcp/registry.ts`: 想定外の例外を `generic_error` にするとき、`console.error` で例外名とトークンを伏せた message を記録する（トークンが出ないことをテストで確認）
4. `src/auth/access-jwt.ts`: キャッシュ取得から 60 秒未満なら未知 kid の強制再取得を省く
5. `test/unit/tools-list-snapshot.test.ts:27` の biome info（useTemplate）を解消
6. ページングを使うツールで `truncated` を出力に載せるかを決め、ADR 0004 に追記する（M03 では単純系のため 1 ページのみ。M05 で使う）

## 対象ツール（38 個。名前は `logvalet_` → `logbutler_`）

| toolset | ツール |
|---|---|
| activity | activity_list |
| document | document_get, document_list, document_tree |
| issue | issue_get, issue_list, issue_comment_list, issue_attachment_list, issue_attachment_download, issue_related_list |
| meta | meta_statuses, meta_issue_types, meta_categories, meta_version, meta_custom_field |
| project | project_get, project_list |
| shared_file | shared_file_list, shared_file_download |
| space | space_info, space_disk_usage |
| team | team_list, team_get, team_project |
| user | user_me（済）, user_get, user_list |
| watching | watching_list, watching_get, watching_count |
| wiki | wiki_list, wiki_get, wiki_count, wiki_tags, wiki_history, wiki_stars, wiki_attachment_list, wiki_sharedfile_list |

M05 に回すもの（M03 では実装しない）: activity_digest, activity_stats, digest_daily, digest_weekly, digest_unified, document_digest,
document_search, issue_context, issue_stale, issue_timeline, issue_triage_materials, my_tasks, project_blockers, project_conventions,
project_health, search, space_digest, user_activity, user_workload

## 完了条件

- `mise run test`（unit + e2e）と `mise run lint` が通る
- **スキーマ一致**: 38 ツールの `description` / `inputSchema` / `annotations` が logvalet の baseline
  （`/Users/youyo/src/github.com/youyo/logvalet/internal/mcp/testdata/tools_list_baseline.json`）と一致することを M02 の比較ヘルパーで検証する。
  baseline のファイルは logbutler の `test/fixtures/` にコピーして使う（logvalet を実行時に参照しない）。意図した差分は許容リストに理由付きで載せ、
  `docs/tool-diff-from-logvalet.md` にも記録する
- **ツールごとの unit テスト**（logvalet より強くする）: 各ツールについて
  1. 引数 → Backlog API のメソッド・パス・クエリ（配列は `key[]`）への写像
  2. 返却 JSON の中身（Backlog の生データが camelCase のまま返ること）
  3. Backlog のエラー（404 など）が §9 エンベロープになること（代表 1 ツールで十分。共通経路なので）
- **E2E**: OAuth 済みトークンで `/mcp` に `tools/call` を送り、代表ツール（issue_list・wiki_get・issue_attachment_download）が
  モックの Backlog に対して動くこと。`LOGBUTLER_TOOLSETS` で toolset を絞ると tools/list から消えること
- tools/list のスナップショットを更新（39 ツール前後。user_me を含む）

## 共通ヘルパー（`src/mcp/args.ts` など。logvalet では各ツールに散らばっていたものを 1 か所にまとめる）

- `resolveProjectId(client, projectKey)`: project_key → projectId（GET /projects/{key}）。1 回のツール呼び出しの中ではキャッシュする
- `resolveUserId(client, value)`: `"me"` → GET /users/myself、数値文字列 → number
- 日付 `YYYY-MM-DD` のパース、CSV の分解（数値・文字列）
- issue_list 専用: `status_id` の `not-closed` → [1,2,3]、`due_date` / `start_date` の `today` / `overdue` / `this-week` / `this-month` / 日付 / `A:B` 範囲。
  週の始まりは月曜。「今日」の基準タイムゾーンは環境変数 `LOGBUTLER_TIMEZONE`（既定 `Asia/Tokyo`）にする（logvalet はローカル時刻依存だったが Workers は UTC のため）。
  時刻は差し替え可能にしてテストする

## logvalet からの意図した変更（許容リストと `docs/tool-diff-from-logvalet.md` に記録）

- `shared_file_list` の `path`: logvalet は未エスケープでパスに埋め込んでいた。セグメントごとに `encodeURIComponent` する
- `user_get` の `user_id`: `"me"` を受け付けるようにする（スキーマの型は変えない。説明文を変えるなら差分として記録）
- ダウンロード系（issue_attachment_download / shared_file_download）: 返却形式は logvalet と同じ
  `{"content_base64","filename","content_type","size_bytes"}`。上限は 20 MiB（超過は `argument_error` ではなく専用の message で
  エンベロープを返す。code は M02 の列挙から選ぶ）。ストリームを上限 + 1 バイトまで読んで判定し、全体をメモリに読んでから判定しない
- `count` の上限: 説明文に「最大 100」とあるものは 1〜100 に収める（範囲外は `argument_error`）。説明文に上限が無いものは Backlog に任せる

## やってはいけないこと

- 加工系 19 ツールの実装（M05）、書き込みツールの実装（M04）
- 同一ツール呼び出し内での Backlog API の並列呼び出し
- 実 Backlog への通信、テストを弱める・skip・削除、コミット・push、logvalet の変更

## 一次参照（logvalet、読み取りのみ。パスは `/Users/youyo/src/github.com/youyo/logvalet/` 基点）

- ツール実装: `internal/mcp/tools_{activity,document,issue,meta,project,shared_file,space,team,user,watching,wiki}.go`
- 共通引数処理: `internal/mcp/tools.go:153-240`、`internal/mcp/tools_issue.go:778-930`（me・status・due_date・start_date）、`internal/mcp/tools_watching.go:148`
- ダウンロード: `internal/mcp/tools_issue.go:655-680`、`internal/mcp/tools_shared_file.go:40-66`、`internal/backlog/http_client.go:1137-1184`
- 未公開 API: `internal/backlog/issue_related.go:21-36`（issue_related_list）
- API パス一覧: `internal/backlog/http_client.go`（各メソッド）
- baseline: `internal/mcp/testdata/tools_list_baseline.json`

## 成果物

- 38 ツールとテスト、共通ヘルパー
- `test/fixtures/logvalet_tools_list_baseline.json`（コピー元のコミット ID を README かファイル冒頭のコメント相当の場所に記録）
- `docs/tool-diff-from-logvalet.md`
