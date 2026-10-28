# ADR 0008: 設定のクライアント制御化と MCP 2026-07-28 準拠

- 状態: 採用(M05.5、2026-10-28)
- 関連: ADR 0001(OAuth サーバー)、ADR 0004(出力とエラー)、`docs/tool-diff-from-logvalet.md`

## 背景

M05A までは、ツールの公開範囲(toolset・読み取り専用)と「今日」の基準タイムゾーンを、運用者が Worker の環境変数
(`LOGBUTLER_TOOLSETS` / `LOGBUTLER_READ_ONLY` / `LOGBUTLER_TIMEZONE`)で決めていた。ユーザー決定(2026-10-28):
運用者の環境変数よりクライアント側で制御できる方がよい。環境変数のフラグは廃止する。

あわせて、MCP 仕様 2026-07-28(ステートレス、`Mcp-Method` / `Mcp-Name`、認可の `iss`)に準拠していることを E2E で固定する。

## 決定 1: フラグの置き場所

| 設定 | 置き場所 | 理由 |
|---|---|---|
| `toolsets` | `/mcp` の URL クエリ(`?toolsets=issue,wiki`。カンマ区切り、繰り返しも合算、既定 `all`) | 公開ツールは `tools/list` の時点で決まるので、ツール引数にはできない。接続(Portal に登録する URL)ごとに決める |
| `read_only` | `/mcp` の URL クエリ(`?read_only=true`。`true` / `false` のみ、重複は不可) | 同上 |
| `timezone` | ツール引数(IANA 名、任意。省略時はコード内の定数 `DEFAULT_TIMEZONE` = `Asia/Tokyo`) | 呼び出し単位の設定。日付を解釈する 6 ツール(`issue_list` `my_tasks` `digest_daily` `digest_weekly` `activity_stats` `issue_timeline`)に付ける。M05B の `digest_unified` `user_activity` `activity_digest` にも付ける |

- 不正なクエリ値(未知の toolset 名、`true` / `false` 以外の `read_only`、`read_only` の重複)は **400** で、
  `{"error":"invalid_query","error_description":"<理由>"}` を返す。従来(環境変数)は 500 + ログのみだったが、接続 URL を直すのは
  クライアントなので理由を返す。理由に秘密は入らない(入力の toolset 名と固定の有効名一覧だけ)。
  認証が先: トークンなしの不正クエリは 401(`OAuthProvider` が `apiHandler` の前に弾く)。
- 関係のないクエリパラメータは無視する(Portal などが付ける未知のパラメータで接続できなくなるのを避ける)。
  **ただし**、小文字にして `_` と `-` を除いた綴りが `read_only` / `toolsets` に一致する未知のキー(`readonly` `readOnly`
  `READ_ONLY` `read-only` `tool_sets` など)は 400(`error: "invalid_query"`。`QueryError`)にして、正しいキー名を本文で案内する(M05B で追加)。
  綴り違いを無視すると、読み取り専用のつもりで書き込み可能なまま接続してしまうため。
- 不正な `timezone` 引数は**クライアント由来**なので `argument_error`(Backlog は呼ばない)。検証は `registerTools` が 1 か所で行い、
  ツール側は `ctx.timezone` を読むだけ(`timezone` を宣言したツールだけが対象)。コードが与える既定値(`RegisterDeps.timezone`)が不正な場合だけ従来どおり `generic_error`。
- `timezone` 引数の追加は logvalet の baseline との**意図した差分**。`ALLOWED_CHANGES` に理由つきで載せ、
  `test/unit/tools-list-snapshot.test.ts` が差分を `properties.timezone` の追加だけに固定する。`docs/tool-diff-from-logvalet.md` にも記録。
- 環境変数は読まない(`mcp-api-handler.test.ts` で、廃止した変数を渡しても効かないことを確認)。

### OAuth の resource とクエリ付き URL

- resource 識別子(RFC 9728 / トークンの audience)は `https://<host>/mcp`(クエリなし)のまま。
- `OAuthProvider` は `/mcp?toolsets=...` をパス `/mcp` として扱い、Bearer の検証が通る(E2E `client-control.test.ts`)。
- 401 の `WWW-Authenticate` の `resource_metadata` はクエリを含まない正規 URL を指す。Backlog が 401 のときの `invalid_token` チャレンジも同じ。
- **未検証の前提**: Cloudflare MCP Server Portal が、登録された URL のクエリ(`?toolsets=...&read_only=true`)をそのまま保持して
  上流の Worker へ送ること。クエリ付き URL でのクライアント登録・トークン取得(`resource` パラメータの照合)が Portal 経由で通ること。
  M07 の手動確認項目にする。Portal がクエリを落とす場合の代替案は、toolset 別のパス(`/mcp/issue` など)だが、resource 識別子が増えるため採用していない。

## 決定 2: MCP 2026-07-28 準拠(E2E で固定)

`test/e2e/mcp-2026.test.ts`(Worker 全体への HTTP)。

| 項目 | 結果 |
|---|---|
| 2026-07-28 レーン(initialize なし、`MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` と `_meta` の `io.modelcontextprotocol/protocolVersion` `clientInfo` `clientCapabilities`) | `tools/list` `tools/call` `server/discover` が成功。応答に `io.modelcontextprotocol/serverInfo` が付く(旧版レーンには付かない) |
| ヘッダーと本文の不一致 | `Mcp-Name` / `Mcp-Method` の不一致・欠落、`MCP-Protocol-Version` と `_meta` の不一致は **400 / -32020 (HeaderMismatch)**。ツールも Backlog も実行されない |
| 旧版レーン(2025-11-25 / 2025-06-18、initialize あり) | `initialize` → `notifications/initialized`(202)→ `tools/list` → `tools/call` が動く |
| 401 の `WWW-Authenticate` とリフレッシュ | トークンなし・Backlog 401 のどちらも両レーンで同一のチャレンジ。リフレッシュで得たトークンが 2026 レーンで使える |
| `iss`(RFC 9207) | `/authorize` から戻るリダイレクトに `iss=<issuer>` が付き、メタデータも `authorization_response_iss_parameter_supported: true` |

### `src/mcp/request-body.ts` は検証を迂回していない

`request-body.ts` は本文を自前で読み、パース済みの本文を `parsedBody` として SDK に渡す。ヘッダーと本文の突き合わせは SDK
(`@modelcontextprotocol/server` の HTTP 入口)が `parsedBody` を使って行うので、迂回していない。agents の `createMcpHandler` は
モダンな要求を SDK にそのまま渡し、旧版の要求だけを互換用ハンドラに回す。ライブラリへの追加検証は不要だった。
確認方法: `request-body.ts` に「ヘッダーを本文の値で上書きする」変異を入れると、不一致の E2E 4 件が落ちる(元に戻すと通る)。

### DCR の `application_type`

`application_type: "native"` と localhost / 127.0.0.1 の `redirect_uris`(`http://`)を送るクライアントは**登録できる**(201)。
`workers-oauth-provider` は `application_type` を読まず(拒否も保存も応答への反映もしない)、loopback の `http` redirect_uri は RFC 8252 §7.3 どおり許可する。
`application_type` が使われる場面(例: クライアント種別による redirect_uri の検査)は Logbutler にはなく、実害はない。
M07 では、実際に Portal / 各 MCP クライアントが送る DCR リクエストで登録に失敗しないことを確認項目に入れる。

## 結果・残課題

- 本番の Portal がクエリ付き URL を保持するか(上記の未検証の前提)は M07 で確認する。
- 綴り違いのクエリ: 小文字化・`_` `-` と空白の除去後に `read` または `tool` で始まる未知のキー(`toolset` `tools` `readonlly` `readOnlyMode` `read-only` など)は 400 にした。
  `optimize_context` `codemode` など無関係なキーは無視する。限界: `ro` `mode` のような短い別名や、`read` / `tool` で始まらない綴り(`rdonly` など)は検出できず、無視される。
