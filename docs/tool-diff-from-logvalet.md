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
| タイムアウト | 接続・応答ヘッダーまで | 応答**本文の読み取りまで**同じ期限(既定 30 秒) | Workers の実時間制限と MCP クライアントの待ち時間 |

## logvalet で見つけた不具合の疑い(logvalet は変更しない)

- `shared_file_list` の `path` が未エスケープ(上記)。
- `internal/mcp/tools_activity.go` の `activity_list`: `user_id` と `project_key` の排他チェックが「キーが存在するか」で判定されるため、空文字でも排他になる。
- `internal/mcp/tools_user.go` の `user_get` は `me` を扱えないが、同じファイルの `user_activity` や `watching_list` は `me` を解決する(一貫性がない)。
