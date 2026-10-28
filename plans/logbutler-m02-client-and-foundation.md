# M02: Backlog クライアントと基盤

ロードマップ: `plans/logbutler-roadmap.md`（決定済み事項の「出力」「ツールのエラー」行を必ず読む）

## 目的

M03 以降で 71 個のツールを機械的に移植できるよう、Backlog API クライアント・エラーエンベロープ・ツール登録の仕組み・
tools/list のスナップショットテストを用意する。M01 で作った `logbutler_user_me` をこの仕組みに載せ替える。

## 完了条件

- `mise run test`（unit + e2e）と `mise run lint` が通る
- Backlog クライアントの unit テストで次が確認できる（fetch はモック）
  1. OAuth の `Authorization: Bearer` が付く。GET はクエリ、POST/PATCH は `application/x-www-form-urlencoded`（配列は `key[]=v` 形式）
  2. HTTP ステータスからエラー種別への変換: 401 / 403 / 404 / 422 / 429 / その他 4xx・5xx。Backlog の `errors[0].code` と `message` を保持する
  3. 429 は `Retry-After`（秒）に従って待ち、最大 2 回までリトライする。待ち時間の上限を超える `Retry-After` はリトライせずエラーにする。待機は時計を差し替えてテストする（実際に sleep しない）
  4. 1 回のツール呼び出しの中で、Backlog への HTTP リクエストは同時に 1 本だけ（直列化）。並列に呼んでも直列に実行されることをテストで固定する
  5. 1 回のツール呼び出しあたりの API 呼び出し回数の上限（既定値を定数で持つ）を超えると、`api_error` 系のエラーで止まる
  6. タイムアウト（既定 30 秒、AbortSignal）
- エラーエンベロープ: すべてのツールエラーが `isError: true` + §9 エンベロープの JSON になる。`retryable` は rate_limited と 5xx のとき true
- Backlog の 401 は、MCP の HTTP 応答でも 401 にしてクライアントにリフレッシュさせる（M01 の方針の維持。テストで固定）
- ツール登録の仕組み（下記）があり、`logbutler_user_me` がそれに載っている
- tools/list のスナップショットテストがある（`test/snapshots/tools_list.json` などに固定。変更時は意図して更新する）

## 対象範囲

### 1. Backlog クライアント（`src/backlog/`）
- `client.ts`: 低レベルの `request(method, path, { query, form })`。上記 1〜6 を担う
- M02 で入れる高レベルメソッドは M03 で必要になるものの土台だけでよい（`getMyself` を載せ替え、型の置き場所を決める）
- 自動ページングはクライアントに入れない。ページングのヘルパー（offset/count 方式と minId/maxId カーソル方式の 2 種、ページ数の上限つき）を別関数で用意する（logvalet と同じく呼び出し側の層）
- 型: Backlog のレスポンスは camelCase のまま型を付ける（変換しない）

### 2. エラー（`src/errors.ts` など）
- code の列挙: `argument_error` / `authentication_error` / `permission_error` / `not_found` / `api_error` / `rate_limited` / `generic_error`（logvalet の列挙 + `rate_limited`。logvalet で 429 が `api_error` 相当なら差分として ADR に書く）
- message に Backlog のトークンや Authorization ヘッダーを含めない

### 3. ツール登録の仕組み（`src/mcp/registry.ts` など）
- 1 ツール = 名前・説明・入力スキーマ（zod）・annotation・カテゴリ・toolset・ハンドラ
- annotation のヘルパーは logvalet と同じ 4 種: 読み取り（readOnly / idempotent / openWorld）、書き込み冪等、書き込み非冪等、破壊的
- カテゴリは logvalet と同じ 4 区分（ReadOnly / WriteIdempotent / WriteNonIdempotent / Destructive）。annotation の `title` は日本語
- toolset: リソース単位のグループ（issue / project / user / activity / document / team / space / meta / shared_file / star / watching / wiki / analysis / digest / search / notification など）。環境変数 `LOGBUTLER_TOOLSETS`（カンマ区切り、既定 `all`）で有効化するグループを選ぶ。さらに `LOGBUTLER_READ_ONLY=true` で書き込み・破壊的ツールを登録しない
- ハンドラは `(args, ctx) => Promise<unknown>`。`ctx` にリクエストごとの Backlog クライアントを入れる。戻り値を JSON にして text content に入れる（logvalet と同じ。structuredContent は使わない）
- ツール名は `logbutler_<resource>_<action>`

### 4. スナップショット
- tools/list の応答を正規化（ツール名でソート）して JSON ファイルと比較する unit テスト
- M03 以降で logvalet の baseline（`/Users/youyo/src/github.com/youyo/logvalet/internal/mcp/testdata/tools_list_baseline.json`）と比較するための比較ヘルパーの土台（名前の `logvalet_` → `logbutler_` 置換、許容する差分のリスト）を用意する。M02 では user_me 1 件だけで比較が通ること

## やってはいけないこと
- 実 Backlog への通信をテストに入れる
- Backlog のトークンをログ・エラーメッセージに出す
- 同一リクエスト内で Backlog API を並列に呼ぶ（logvalet の errgroup 方式は移植しない）
- テストを弱める・skip・削除する
- コミット・push（司令塔が行う）
- M03 以降のツールの移植

## 一次参照（logvalet、読み取りのみ）
- クライアント: `internal/backlog/http_client.go`（認証 139-157・173-194、エラー変換 239-271、各メソッド）、`internal/backlog/errors.go:17-90`
- ページング: `internal/backlog/fetch_activities.go:14-80`、`internal/backlog/options.go:33-34`
- ツール登録: `internal/mcp/tools.go:19-149`、`internal/mcp/tooldef.go`、`internal/mcp/annotations.go:8-40`、`internal/mcp/tool_categories.go:21-103`
- エンベロープ: `docs/specs/logvalet_full_design_spec_with_architecture.md:425-460`、`internal/app/error_envelope.go:38-131`
- baseline: `internal/mcp/testdata/tools_list_baseline.json`（71 ツール）

## 成果物
- 上記のコードとテスト
- `docs/adr/0003-backlog-client-serialization-and-retry.md`（直列化・リトライ・呼び出し上限の設計と既定値の根拠）
- `docs/adr/0004-tool-output-and-error-format.md`（camelCase / snake_case 混在と §9 エンベロープの決定）
