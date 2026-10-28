# logvalet との差分

Logbutler の MCP ツールは、logvalet の MCP ツールと同じ名前(接頭辞だけ `logvalet_` → `logbutler_`)・同じ引数で動くことを目標にする。
ここには、**意図して違えている点**を理由つきで記録する。

## スキーマ(tools/list)の差分

M03 で移植した 38 ツールの `description` / `inputSchema` / `annotations` は、logvalet の baseline
(`test/fixtures/logvalet_tools_list_baseline.json`)と**差分 0**(`test/helpers/baseline.ts` の `ALLOWED_CHANGES` は空)。
比較は次の正規化のうえで行う: ツール名の接頭辞の置換、キー順の無視、zod が付ける `$schema` と
`additionalProperties: false` の除外、`required` と `enum` の**順序の無視**(Go 版は辞書順、zod は定義順のため。集合としては比べる)。

整数の引数(ID・件数)は、JSON Schema 上は logvalet と同じ `number` のまま公開する(`integer` や `minimum` を足すと baseline と食い違うため)。
整数かどうか・範囲は、スキーマではなく実行時に検証して `argument_error` にする。

M04 で移植した書き込み・破壊的ツール 14 個と `project_conventions`(M05 から前倒し)の計 15 ツールも、baseline と**差分は
`issue_attachment_upload` の 3 か所だけ**(`ALLOWED_CHANGES`。`test/unit/tools-list-snapshot.test.ts` が 3 か所に固定している):

- `description`: 「Specify EITHER file_paths (...) OR file_name + file_content_base64」から file_paths の記述を除いた。
- `inputSchema.properties.file_paths`: 削除。Workers にはファイルシステムがなく、サーバー上のパスを受け取る意味がない(決定済み事項)。
- `inputSchema.properties.file_content_base64.description`: 「Mutually exclusive with file_paths.」を除いた。

`idempotency_key` は inputSchema に宣言していない(baseline と一致させるため。受け取り方は ADR 0005)。

## 振る舞いの差分

| ツール | logvalet | Logbutler | 理由 |
|---|---|---|---|
| すべて | エラーはプレーンテキスト | spec §9 のエンベロープ(`isError: true`)。429 は `rate_limited` | ADR 0004 |
| 全般(Backlog の生データを返すツール) | logvalet のドメイン型に詰め直して JSON 化 | Backlog の応答を**そのまま**返す(camelCase) | ADR 0004。変換しない |
| `issue_list` の `due_date` / `start_date` | `today` などをサーバーのローカル時刻で解決 | 環境変数 `LOGBUTLER_TIMEZONE`(既定 `Asia/Tokyo`)の暦日で解決 | Workers は UTC で動く。週の始まりは月曜のまま |
| `issue_list` の `project_key` + `project_keys` | 重なったキーも ID も重複して送る | 同じキーは 1 回だけ解決し、ID も重複させない | 無駄な API 呼び出しの削減 |
| `shared_file_list` の `path` | 未エスケープでパスに埋め込む | `/` で分けたセグメントごとに `encodeURIComponent`。`.` と `..` のセグメントは `argument_error` | `?` `#` や `..` で別の API を叩けてしまうため |
| すべての ID・キーのパス部分 | `url.PathEscape` | `encodeURIComponent`。`.` と `..` のみの値は `argument_error` | 同上(URL の正規化でパスを辿れる) |
| `user_get` の `user_id` | `me` は未対応(ユーザー ID として問い合わせる) | `me` を受け付け、`GET /users/myself` 1 回で返す | スキーマ(型・説明文)は変えない |
| ダウンロード系(`issue_attachment_download` / `shared_file_download`) | 上限 20 MiB(超過は ErrDownloadTooLarge → プレーンテキスト) | 返却形式は同じ `{content_base64, filename, content_type, size_bytes}`。上限 20 MiB を**上限 + 1 バイトまで読んで**判定し、超過は `api_error`(retryable でない)・message は `File is too large to download (limit 20 MiB). ...`。`Content-Length` が上限超なら本文を読まない | 全体をメモリに読んでから判定しない。`argument_error` ではない(入力の誤りではないため) |
| `count` の上限(`activity_list` `issue_list` `team_list` `watching_list` `wiki_history`) | 範囲外は黙って Backlog に渡す、または既定値に丸める | 説明文に最大 100 とあるものは 1〜100 に限り、範囲外は `argument_error`。`activity_list` の既定は 20 | 計画書の方針。説明文に上限がないもの(`document_list` `issue_comment_list` `shared_file_list`)は Backlog に任せる |
| `count` / `offset` が 0 以下(上限のないもの) | 送らない | 送らない(同じ)。ただし `document_list` の `offset` は 0 でも送る | Backlog のドキュメント API の要件 |
| `activity_list` の `user_id` と `project_key` | 同時指定は error | 同じ(`argument_error`)。空文字は未指定として扱う | — |
| 引数の型違い・必須の欠落 | 各ツールで「x is required」 | zod の検証で `argument_error`(どの引数が悪いかを message に入れる) | `registerTools` が一括で検証する |
| 冪等キャッシュ(`issue_create` `issue_comment_add` `issue_attachment_upload` `document_create`) | プロセス内メモリ。キーにユーザーなし。`params._meta` は本番で読めていなかった。エラーもキャッシュ | KV(`idem:<ユーザーID>:<ツール>:<explicit\|hash>:<値>`)。ユーザーごとに分離。`params._meta.idempotency_key` → 引数 `idempotency_key` の順。**成功した結果だけ** TTL 5 分で保存。ほぼ同時の 2 回は両方実行されうる | ADR 0005 |
| `issue_create` の `priority_id` | 未指定でも `priorityId=0` を送る | 未指定(0 を含む)なら `priorityId` を送らない | 0 は有効な優先度 ID ではない。実機での挙動は未検証の前提(Backlog が 0 を既定の「中」に読み替えるのか、エラーにするのかは確認していない) |
| `issue_attachment_upload` | `file_paths` でサーバー上のパスも受け取る | `file_paths` なし。base64 のみ。上限 4 MiB は**デコード後の実サイズ**で判定（ちょうど 4 MiB は通り、4 MiB + 1 は `argument_error`）。`file_name` が空・`.`・`..` なら `argument_error` | 推定 `(len/4)*3` は、ちょうど 4 MiB を誤って弾きうる。base64 長が上限の約 1.25 倍を超える入力はデコードせずに弾く |
| MCP の POST 本文の上限 | 4 MiB 相当 | 8 MiB（`src/mcp/request-body.ts`）。超えたら 413 | 4 MiB のファイルを base64 にして JSON に入れると約 5.6 MB。agents の stateless ハンドラは `maxRequestBodySize` を 2025 年版プロトコルの判定に渡さず、4 MiB を超えると 400 になるため、本文を自前で読んで `parsedBody` を渡す |
| `issue_related_delete` | 空本文のとき、ゼロ値の関連課題を返す | 空本文・204 のとき `{"result":"ok"}` | 意味のないゼロ値の JSON を返さない |
| `star_add` `watching_mark_as_read` | 204 → `{"result":"ok"}` | 同じ | — |
| `issue_update` の更新項目の判定 | `hasUpdateField` | 同じ。`category_ids` などの空文字は更新項目に数えない。`engagement` は補完したカテゴリ・親課題を数える | — |
| `project_conventions`・`engagement` | ListIssues を count 無指定で 1 回だけ呼ぶ。規約課題が 1 ページ目になければ見落とす疑い | 規約の課題種別(`issueTypeId`)で絞ったうえでページングする(ADR 0003 の上限: 100 件 × 10 ページ)。案件親課題も案件種別で絞って探す。GetProject は 1 回(ツール呼び出し内でキャッシュ) | 見落としの防止と API 呼び出し回数の削減 |
| `project_conventions` の YAML | `KnownFields(true)` で未知のフィールドはエラー | 同じ（`src/conventions/load.ts`）。未指定のリストは JSON で `null`（Go の nil スライスと同じ） | — |
| `engagement` の失敗 | プレーンテキスト | 規約にない案件は `argument_error`（使える案件名つき）、規約が未導入・カテゴリなし・YAML 不正は `generic_error`（message はそのまま見える） | ADR 0004 |
| タイムアウト | 接続・応答ヘッダーまで | 応答**本文の読み取りまで**同じ期限(既定 30 秒) | Workers の実時間制限と MCP クライアントの待ち時間 |

## logvalet で見つけた不具合の疑い(logvalet は変更しない)

- `shared_file_list` の `path` が未エスケープ(上記)。
- `internal/mcp/tools_activity.go` の `activity_list`: `user_id` と `project_key` の排他チェックが「キーが存在するか」で判定されるため、空文字でも排他になる。
- `issue_create` が `priority_id` 未指定のとき `priorityId=0` を送る（`internal/backlog/http_client.go` の `CreateIssue`）。Backlog が 0 を拒否する・黙って既定にするのどちらかは未確認。
- `internal/conventions/show.go` の `Show` と `engagement.go` の `ResolveEngagement` は `ListIssues` を件数指定なしで 1 回だけ呼ぶので、プロジェクトの課題が多いと規約課題・案件親課題が 1 ページ目に載らず見落とす疑い。
- `internal/mcp/tools.go` の冪等キャッシュはキーにユーザーがなく、別ユーザーの同一引数の呼び出しが衝突しうる。`params._meta` の `idempotency_key` は本番のハンドラから渡されておらず効いていない（テストは `args["_meta"]` を直接入れている）。
- `internal/mcp/tools_issue.go` の添付アップロードは、デコード前の推定サイズ `(len/4)*3` で弾く（パディングを数えるので、ちょうど上限のファイルを誤って弾きうる）。
- `internal/mcp/tools_user.go` の `user_get` は `me` を扱えないが、同じファイルの `user_activity` や `watching_list` は `me` を解決する(一貫性がない)。
