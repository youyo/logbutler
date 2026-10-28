# Logbutler ロードマップ

**Logbutler — Your AI Butler for Backlog**

Go 製の Backlog CLI「logvalet」が持つ Remote MCP 機能を、TypeScript + Cloudflare Workers に移植した Remote MCP サーバー。
Cloudflare MCP Server Portals 経由で使うことを前提にする。logvalet（CLI）は別リポジトリとしてそのまま残す。

## 決定済み事項

| 項目 | 決定 | 理由・却下した案 |
|---|---|---|
| スコープ | Remote MCP のみ。CLI は移植しない | CLI は logvalet が担う |
| ランタイム | Cloudflare Workers + KV。Durable Objects は使わない | `agents/mcp/server` の `createMcpHandler` はステートレスで、DO もセッションも不要。`McpAgent` は v0.20.0 で非推奨 |
| HTTP ルーティング | Hono | OAuth の画面（/authorize, /callback）と /mcp の振り分け |
| MCP SDK | `agents`（`createMcpHandler`）+ `@modelcontextprotocol/server` v2 + zod | MCP 2026-07-28（ステートレス）と旧クライアントの両方に対応 |
| 認証 | Worker が OAuth 認可サーバーになる（`@cloudflare/workers-oauth-provider` v1）。上流の IdP は Backlog OAuth 2.0 | **却下: Portal の手動 OAuth で Backlog のトークンをそのまま流す案（logvalet v0.40 の passthrough 契約）**。Portal はユーザーのトークンが切れたとき再認証を求めるだけで、自動でリフレッシュしない |
| 利用者の保護 | /authorize と /callback を Cloudflare Access（self-hosted app）で保護する。Worker 側でも `Cf-Access-Jwt-Assertion` を検証する | /mcp・/token・/register・/.well-known/* は Portal がサーバー間で呼ぶので Access を通さず（Bypass）、Worker が発行したトークンで守る |
| Backlog スペース | デプロイ 1 つにつき 1 スペース（環境変数で指定） | logvalet v0.40 で multi-space を撤去したのと同じ方針 |
| ランタイムとタスク | mise（node と pnpm を固定）。`mise run test / test:unit / test:e2e / lint / fmt / build / dev` | グローバル規約 |
| テスト | vitest + `@cloudflare/vitest-pool-workers`。Backlog API はモックのみ | logvalet の方針を引き継ぐ |
| 出力 | JSON。Backlog の生データを返すツールは Backlog の camelCase のまま、加工した出力（分析・digest・context 等）は snake_case（logvalet と同じ混在） | logvalet と互換にする。全 snake_case 統一は logvalet と非互換になるため却下（2026-10-28 ユーザー決定） |
| 分析系の取得件数 | ページングで全件取得（上限つき、超過は warning と `truncated`） | logvalet は Backlog 既定の 20 件だけで分析していた。互換維持は却下（2026-10-28 ユーザー決定） |
| 日付の until | 全ツールで当日を含める（`timezone` 引数の暦日の 23:59:59 まで） | logvalet は user_activity だけ当日を含め、他は 00:00 で切っていた（2026-10-28 ユーザー決定） |
| 完了とみなす状態 | 全分析で {完了, 対応済み, Closed, Done, Resolved}。`exclude_status` 指定時はそれを優先 | logvalet はツールにより「完了」のみと 5 種の 2 通りがあった（2026-10-28 ユーザー決定） |
| 責務の範囲（2026-10-28 改訂） | Logbutler は「Backlog OAuth で認可する MCP サーバー」だけを担う。**Cloudflare Access 連携（`Cf-Access-Jwt-Assertion` の検証、`ACCESS_*`、`/callback` でのメール一致確認）は削除**。Access による利用者の制限と MCP Server Portal は Logbutler の外側で別に管理する。Portal に Logbutler を「OAuth（DCR 自動登録）+ Require user auth」で登録すれば、Portal の Access ポリシーで利用者を絞り、各ユーザーは Portal 経由で自分の Backlog アカウントで認可する | ユーザー決定。裏付け（2026-10-28 確認）: Access の Managed OAuth は「自前の OAuth を持つサーバーには使わない」と公式に明記されており、Logbutler には使えない。利用者の制限は Portal 側の Access ポリシーで担う。既知の穴: Logbutler の URL へ直接接続すれば Portal のポリシーを回避できるが、Backlog のログインが門番なので許容する。利用者は「その Backlog スペースにログインできる人」で決まる。上の「利用者の保護」行はこの決定で置き換える。M06 の冒頭で削除する |
| user_activity の出力形式 | DigestEnvelope で包む（`activities` の中身は Backlog の camelCase のまま、`truncated` を載せる） | logvalet は配列をそのまま返していたが、上限で打ち切ったことを伝えられないため構造の互換を破る（2026-10-28 ユーザー決定） |
| フラグの置き場所 | クライアント側で制御する。呼び出し単位の設定（`timezone`、`max_response_tokens`）はツール引数、公開ツールを決める設定（`toolsets`、`read_only`）は MCP の URL クエリ。環境変数のフラグは廃止 | 運用者の環境変数よりクライアント側で制御できる方がよい（2026-10-28 ユーザー決定）。M05.5 で移行 |
| MCP 仕様 | 2026-07-28（ステートレス、`Mcp-Method` / `Mcp-Name`、認可の `iss`）を主、旧版を互換として両方を E2E で固定 | M05.5 で確認 |
| ツールのエラー | `isError: true` の text content に spec §9 のエンベロープ `{"schema_version":"1","error":{"code","message","retryable"}}` を JSON で入れる | logvalet MCP はプレーンテキストだったが、AI がリトライ可否を判断できるよう変更（2026-10-28 ユーザー決定）。code は logvalet の列挙値（`argument_error` / `authentication_error` / `permission_error` / `not_found` / `api_error` / `rate_limited` 等）に合わせる |

## 移植元（logvalet）の調査で分かった注意点

- MCP ツールは 71 個（R57 / 書き込み冪等 7 / 書き込み非冪等 4 / 破壊的 3）。正は `internal/mcp/testdata/tools_list_baseline.json`
- MCP は `internal/render` を使っていない（出力は JSON のみ）。render・gantt・conventions のファイル読み込みは CLI 専用なので移植しない
- 添付アップロードの `file_paths` はサーバー上のファイルを読むため Workers では不可。`file_content_base64`（上限 4MB）だけ残す
- **Go 版の不具合の疑い**: `fetchProjectIssues` が `count` を指定しておらず、分析系（stale / blocker / workload / ambiguity / triage）が Backlog 既定の 20 件で打ち切られている可能性がある。**Go 版の出力をそのまま正解にしない**。分析ロジックの期待値はテストで決め直す（logvalet は凍結するため issue は立てない。2026-10-28 ユーザー決定。見つけた不具合は `docs/tool-diff-from-logvalet.md` に記録するのみ）
- API 呼び出し数が膨らむツールがある: `digest_unified`（最悪 2,000 回超）、`user_activity` / `activity_stats`（期間指定時に上限なくページング）、`search`（プロジェクト数に比例）
- Backlog は「1 ユーザーのリクエストは直列に」と案内している。Go 版の errgroup による並列呼び出しはこれに反する
- リトライなし、429 は変換のみ、`Retry-After` 未対応
- Backlog OAuth のリフレッシュは Go 版に存在しない（新規実装）

## Nulab 公式 MCP から取り込む機能

`nulab/backlog-mcp-server` v0.23.3 と比較して決定（2026-10-28）。

| 機能 | 種別 |
|---|---|
| 通知の取得・件数 | ツール 2 個 |
| プロジェクトメンバー一覧 | ツール 1 個 |
| 応答サイズの上限（超過時は切り詰めず `response_too_large` のエラーエンベロープで絞り込みを促す） | 仕組み |
| toolset（機能グループ単位での有効化） | 仕組み（M02 で実装済み） |

2026-10-28 に価値を見直して縮小（ユーザー決定）。取り込まないもの:
- 通知の既読化・未読数リセット: AI が本人の代わりに既読にすると本人が見落とす
- 優先度一覧・完了理由一覧: Backlog の固定値で、ツールを足すほどの価値がない（ツール数が増えると AI のツール選択が鈍る）
- `fields`: baseline 一致のため既定で無効にせざるを得ず、使われない機能になる
- 公式互換のトークン上限での文字数切り詰め: JSON が壊れる。M05 の「上限つき取得 + `truncated`」と方式が食い違う

後回し: Git / PR の読み取り・書き込み、Wiki の書き込み。

## マイルストーン

| # | 名前 | 内容 | 完了条件 |
|---|---|---|---|
| M01 | 雛形と認証の骨格 | mise / wrangler / Hono / vitest の雛形。OAuth 認可サーバー + Backlog OAuth + Access JWT 検証 + トークンのリフレッシュ。ダミーツール 1 個（`logbutler_user_me`）で通しで動く | 下記 M01 計画書 |
| M02 | Backlog クライアントと基盤 | Backlog API クライアント（直列化・ページ上限・429 と `Retry-After`）、エラーエンベロープ、ツール登録の仕組み（annotation・カテゴリ・toolset）、tools/list を固定するスナップショットテスト | クライアントの unit テスト、tools/list スナップショット |
| M03 | 読み取りツール（単純系） | space / project / user / team / meta / issue 読み取り / comment / document / wiki / shared_file / watching 読み取り / activity | logvalet の baseline とスキーマが一致（意図した差分は記録） |
| M04 | 書き込みツール | issue create/update/comment、related、attachment（base64 のみ）、watching、star、document create。冪等キャッシュは KV で再設計 | 書き込みの unit + E2E |
| M05 | 分析・digest | analysis / digest / search / conventions。API 呼び出し数の上限を設計に入れる | ツールごとの最大呼び出し数をテストで固定 |
| M06 | 公式 MCP 由来の追加機能 | 通知一覧・通知件数・プロジェクトメンバー一覧、応答サイズ上限（`response_too_large`） | 各機能の unit + E2E |
| M07 | 本番デプロイと Portal 登録 | カスタムドメイン、Access アプリ、Portal への DCR 登録、運用手順書 | Portal 経由で実 Backlog に対して読み取りツールが動く（手動確認の記録） |

## 未決事項

- Backlog OAuth のリフレッシュトークンがローテーションするか（更新のたびに変わるか）。M01 で実 API の挙動を確認する
- Backlog のレート制限の具体的な数値（公式ページは未取得）
- KV の結果整合性（書き込みの反映に最大 60 秒ほど）がリフレッシュ直後の再利用に影響しないか。M01 で検証
- ツール名の接頭辞を `logvalet_` のままにするか `logbutler_` にするか（M02 で決める。暫定は `logbutler_`）
