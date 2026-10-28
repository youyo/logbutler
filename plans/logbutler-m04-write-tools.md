# M04: 書き込みツール

ロードマップ: `plans/logbutler-roadmap.md`。前提: M03 完了（共通ヘルパー `resolveProjectId` / `resolveUserId` / CSV・日付パース、baseline 比較ヘルパー）。

## 目的

logvalet の書き込み・破壊的ツール 14 個を移植する。非冪等ツールの重複実行を防ぐ冪等キャッシュを KV で再設計する。
`engagement` 引数が依存する「プロジェクト規約（conventions）」の解決モジュールと、それを公開する `project_conventions` ツールもここで実装する（M05 から前倒し）。

## M03 からの持ち越し（verifier の minor 指摘。最初に片付ける。テストを先に）

1. `src/mcp/args.ts` の `dateRangeFor`: `split(":", 2)` は余りを捨てるため `"2026-01-01:2026-01-02:x"` を受理してしまう。最初の `:` だけで分け、右側に `:` が残れば `argument_error`（logvalet の `SplitN` と同じ）
2. `src/mcp/tools/download.ts` の `toBase64`: 20 MiB の最大ケースでチャンク列・結合バッファ・バイナリ文字列・base64 文字列が同時に載る。3 バイトの倍数ずつ base64 化して連結するなど、ピークのメモリを減らす（出力は同一であることをテストで確認）

## 対象ツール（14 個 + project_conventions。名前は `logvalet_` → `logbutler_`）

| カテゴリ | ツール |
|---|---|
| WriteNonIdempotent（4） | issue_create, issue_comment_add, issue_attachment_upload, document_create |
| WriteIdempotent（7） | issue_update, issue_comment_update, issue_related_add, star_add, watching_add, watching_update, watching_mark_as_read |
| Destructive（3） | issue_related_delete, issue_attachment_delete, watching_delete |
| ReadOnly（前倒し） | project_conventions |

## 完了条件

- `mise run test`（unit + e2e）と `mise run lint` が通る
- 15 ツールのスキーマが logvalet baseline と一致（意図した差分は許容リストと `docs/tool-diff-from-logvalet.md` に記録）
- ツールごとの unit テスト: 引数 → Backlog API のメソッド・パス・フォーム本文（`application/x-www-form-urlencoded`、配列は `key[]`、multipart の field 名）への写像、返却値
- `LOGBUTLER_READ_ONLY=true` で 14 ツールが tools/list から消え、呼んでも実行されないこと（E2E）
- 冪等キャッシュ（下記）の unit + E2E
- E2E: OAuth 済みトークンで issue_create（冪等キーあり・なし）、issue_attachment_upload（base64）、watching_delete を `/mcp` 経由で実行し、モックの Backlog に期待どおりの書き込みが届くこと

## 冪等キャッシュ（KV で再設計。ADR 0005 を書く）

- 対象: WriteNonIdempotent の 4 ツールのみ（logvalet と同じ）
- キー: `idem:<backlogUserId>:<toolName>:<explicit|hash>:<値>`。**ユーザー ID を含める**（logvalet はユーザー非分離で、別ユーザーの同一引数呼び出しが衝突しうる不具合があった）
- 明示キーの受け取り: MCP の `params._meta.idempotency_key` → 引数の `idempotency_key` の順。logvalet は本番で `params._meta` を読めていなかった（意図した修正）。
  `idempotency_key` は inputSchema に宣言しない（baseline と一致させるため）。zod の検証で未知のキーが落ちる前に registry 側で取り出すこと
- 明示キーがなければ、引数を canonical JSON（キーをソート）にした SHA-256
- 保存するのは**成功した結果だけ**。TTL 5 分（KV の最小 TTL 60 秒以上なので可）。logvalet はエラーもキャッシュしていたが、KV では一時障害のあと 5 分間リトライできなくなるため変更（意図した差分）
- 重複だった場合も初回と同じ結果を返す（応答に重複の印は付けない。logvalet と同じ）
- 限界（ADR に明記）: KV は結果整合で排他制御もないため、ほぼ同時の 2 回の呼び出しは両方実行されうる（best-effort）。Durable Objects は使わない方針のため受け入れる
- 保存する値に Backlog のトークンを含めない

## ツールごとの注意（logvalet の挙動。一次参照に path:line）

- issue_create: `project_key` → projectId（事前に GET /projects/{key}）。`priority_id` 未指定時に logvalet は `priorityId=0` を送っていたが、未指定なら送らない（意図した差分。実機挙動は未検証の前提として記録）
- issue_update: 更新項目が 1 つもなければ `argument_error`。`parent_issue_id=0` で親の解除（`parentIssueId` を空文字で送る）
- issue_comment_add / update: `content` が空なら別名の `body` を使う
- star_add: `issue_id` / `comment_id` / `wiki_id` / `pull_request_id` / `pull_request_comment_id` のうちちょうど 1 つ。0 個・2 個以上は `argument_error`。204 → `{"result":"ok"}`
- watching_mark_as_read: 204 → `{"result":"ok"}`
- issue_related_add / delete: Backlog の未公開 API。delete は空本文・204 を許容
- issue_attachment_upload:
  - `file_paths` は Workers で使えないため**スキーマから削除**（意図した差分）。`file_content_base64` と `file_name` を必須の組として扱う
  - 上限 4 MiB はデコード後の実サイズで判定する（logvalet の `(len/4)*3` による推定はちょうど 4 MiB を誤って弾きうる）。デコード前にも base64 長で明らかな超過を弾いてよいが、境界は実サイズで決める
  - 2 段階: `POST /api/v2/space/attachment`（multipart、field `file`）→ `PATCH /api/v2/issues/{key}`（`attachmentId[]`）。`file_name` は basename 化（`/` と `\` の両方）
- `engagement`（issue_create / issue_update）: conventions を解決して `categoryId` と `parentIssueId` を補完する。明示指定があれば上書きしない
- カスタムフィールドは logvalet でも未実装。M04 でも実装しない

## conventions（前倒し）

- logvalet `internal/conventions/` の移植: 規約課題（種別 Rule）を探して説明欄をパースし、用語集を付ける
- logvalet は ListIssues を count 無指定で 1 回だけ呼び、規約課題が 1 ページ目に無いと見つからない不具合の疑いがある。issueTypeId で絞り込んだうえでページングする（上限は M02 のページング上限）（意図した修正）
- パーサーはテストデータ（logvalet のテストの入力文字列）を流用して期待値を固定する

## やってはいけないこと

- 破壊的操作の確認ダイアログ相当の仕組みを独自に足す（annotation の destructiveHint のみ。logvalet と同じ）
- 同一ツール呼び出し内での Backlog API の並列呼び出し
- 実 Backlog への通信、テストを弱める・skip・削除、コミット・push、logvalet の変更、Durable Objects

## 一次参照（`/Users/youyo/src/github.com/youyo/logvalet/` 基点）

- 書き込みツール: `internal/mcp/tools_issue.go:168-282`（create）、`:285-411`（update）、`:437-492`（comment）、`:510-544`（related）、`:561-728`（attachment）、`internal/mcp/tools_star.go:13-53`、`internal/mcp/tools_watching.go:78-139`、`internal/mcp/tools_document.go:53-83`
- Backlog 送信: `internal/backlog/http_client.go:409-523`（issue create/update のフォーム）、`:547-566`（comment）、`:1237-1280`（multipart）、`internal/backlog/issue_related.go:21-100`
- 冪等: `internal/mcp/idempotency.go`、`internal/mcp/tools.go:35-61`、テスト `internal/mcp/idempotency_test.go`・`idempotency_e2e_test.go`
- conventions: `internal/conventions/show.go`、`internal/conventions/engagement.go:23-93`、`internal/mcp/tools_conventions.go:14`
- 添付テスト: `internal/mcp/tools_issue_upload_test.go`

## 成果物

- 15 ツールとテスト、冪等キャッシュ、conventions モジュール
- `docs/adr/0005-idempotency-cache-on-kv.md`
- `docs/tool-diff-from-logvalet.md` の追記
