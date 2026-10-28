# ADR 0004: ツールの出力形式とエラー形式

- 状態: 採用(M02)
- 日付: 2026-10-28(出力とエラーの方針はユーザー決定、ロードマップ「決定済み事項」)

## 背景

logvalet の MCP ツールは JSON を text content で返し、エラーはプレーンテキストだった。CLI 側は spec §9 のエラーエンベロープを使う。出力のキーは、Backlog の生データを返すツールが Backlog の camelCase のまま、加工した出力(分析・digest・context など)が snake_case で、混在している。

## 決定

### 出力

- ツールの戻り値は JSON 文字列にして **text content 1 件**で返す。`structuredContent` と `outputSchema` は使わない(logvalet と同じ。クライアント互換のため)。
- キー: **Backlog の生データはそのまま camelCase、加工した出力は snake_case**(logvalet と同じ混在)。全部 snake_case に統一する案は、logvalet とスキーマが非互換になるため却下した。`logbutler_user_me` は加工出力なので snake_case(`user_id` など)。
- 入力引数のキーは snake_case(`issue_key` など。logvalet の baseline に合わせる)。
- ツール名は `logbutler_<resource>_<action>`。annotation の `title` は日本語。annotation は logvalet と同じ 4 種(ReadOnly / WriteIdempotent / WriteNonIdempotent / Destructive)。

### エラー

ツールのエラーはすべて `isError: true` の text content 1 件に、spec §9 のエンベロープの JSON を入れる。

```json
{"schema_version":"1","error":{"code":"not_found","message":"Backlog API error (HTTP 404, code=6): No such issue.","retryable":false}}
```

`code` は logvalet の列挙 + `rate_limited`:

| HTTP | code | retryable |
|---|---|---|
| 401 | `authentication_error` | false |
| 403 | `permission_error` | false |
| 404 | `not_found` | false |
| 422 | `argument_error` | false |
| 429(リトライ後) | `rate_limited` | **true** |
| その他の 4xx | `api_error` | false |
| 5xx | `api_error` | **true** |
| 通信失敗・タイムアウト(HTTP 応答なし) | `api_error` | true |
| 呼び出し回数の上限超過 | `api_error` | false |
| ツール入力の検証エラー | `argument_error` | false |
| 想定外の例外 | `generic_error`(メッセージは固定文) | false |

- logvalet との差分: logvalet は 429 を `api_error` 相当(`ErrRateLimited` → `ExitAPIError`)にまとめ、`error.code` には Backlog の数値コードを入れていた。Logbutler は 429 を `rate_limited` に分け、Backlog の `errors[0].code` / `message` は message 文字列に含めて保持する(`BacklogApiError.backlogCode` / `backlogMessage` にも持つ)。
- retryable は「rate_limited と 5xx のとき true」。通信失敗・タイムアウト(status 0)も再試行で直りうるので true にしている(計画書の文言への追加。`isRetryableStatus` 1 か所で決まる)。
- Backlog の **401 だけは**エンベロープだけでなく、MCP の HTTP 応答も 401 + `WWW-Authenticate: Bearer error="invalid_token"` にして、クライアントにトークンをリフレッシュさせる(M01 の方針を維持。`src/mcp/api-handler.ts`)。
- 入力検証は SDK に任せず自前で行う(`registerTools`)。SDK の検証エラーはプレーンテキストの isError になりエンベロープにならないため、SDK には公開用の JSON Schema だけを渡し、`zod` の `safeParse` の失敗を `argument_error` にする。`arguments` が JSON-RPC として不正(オブジェクトでない)な場合は、ツールの手前のプロトコルエラーになる。
- message にアクセストークン・Authorization ヘッダーを含めない。

### 設定

- `LOGBUTLER_TOOLSETS`(カンマ区切り、既定 `all`)で有効にする toolset を選ぶ。`LOGBUTLER_READ_ONLY=true` で書き込み・破壊的ツールを登録しない。未知の toolset 名・読めない真偽値は設定ミスとして、`/mcp` が 500 を返す(詳細はログのみ)。typo で黙って全ツールが消える、読み取り専用のつもりで書き込めてしまう、を避けるため。
