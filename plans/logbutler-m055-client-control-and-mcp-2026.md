# M05.5: 設定のクライアント制御化と MCP 2026-07-28 準拠の確認

ロードマップ: `plans/logbutler-roadmap.md`。前提: M05A 完了。M05B より先に行う（M05B の新ツールを新しい作法で作るため）。

## 目的

1. 環境変数で持っていた「フラグ」を、クライアント側で制御できる形に移す（2026-10-28 ユーザー決定）
2. MCP 仕様 2026-07-28（ステートレス化・ルーティング用ヘッダー・認可の強化）に準拠していることを E2E で固定する

## 0. M05A からの持ち越し（verifier の minor 指摘）

1. `docs/tool-diff-from-logvalet.md` に、logvalet の `StaleConfig.StatusDays`（ステータス別の stale 閾値。MCP には未公開だった）を移植していないことを 1 行記録する
2. E2E の追加: project_blockers（include_comments あり）と issue_timeline を `/mcp` 経由で 1 件ずつ（cursor ページングと maxApiCalls の配線を E2E で縛る）。既存挙動の固定なので Red にならない場合は、変異で判別力を確かめて報告する

## 1. フラグの移行

| 現在 | 移行先 | 備考 |
|---|---|---|
| `LOGBUTLER_TOOLSETS` | MCP の URL クエリ `toolsets`（例 `/mcp?toolsets=issue,wiki`） | 公開ツールを決める設定はツール引数にできない（tools/list の時点で効く）。Portal に登録する URL で接続ごとに決める。環境変数は廃止 |
| `LOGBUTLER_READ_ONLY` | MCP の URL クエリ `read_only=true` | 同上。環境変数は廃止 |
| `LOGBUTLER_TIMEZONE` | ツール引数 `timezone`（IANA 名、任意。既定 `Asia/Tokyo` をコード内の定数に） | 日付を解釈するツールに付ける: issue_list、my_tasks、digest_daily、digest_weekly、activity_stats、issue_timeline（M05B の digest_unified・user_activity・activity_digest にも付ける）。環境変数は廃止。不正な名前はクライアント由来になるので `generic_error` ではなく `argument_error` |

- 不正なクエリ値（未知の toolset 名、`read_only` が `true`/`false` 以外）は 400 とし、本文で理由を返す（設定ミスにすぐ気づけるように。従来の 500 + ログのみから変更）
- 引数の追加は logvalet baseline との差分になる。許容リストに「`timezone` 引数の追加」を理由付きで載せ、`docs/tool-diff-from-logvalet.md` に記録
- 確認すること: OAuth の resource 識別子（`/mcp`）とクエリ付き URL の関係。クエリ付きの `/mcp?...` でも Bearer 検証が通り、`WWW-Authenticate` の resource_metadata が正しく出ること。Portal がクエリ付き URL をそのまま保持して送るか、という前提は ADR に「未検証の前提」として書く
- README・`.dev.vars.example`・CLAUDE.md・ADR 0003/0004 の環境変数の記述を更新

## 2. MCP 2026-07-28 準拠の確認（E2E で固定）

参照: https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/ と仕様本文（https://modelcontextprotocol.io/specification/2026-07-28 ）

現状、テストは `Mcp-Method` / `Mcp-Name` / プロトコルバージョンを一度も指定しておらず、どのレーン（2026-07-28 か旧版互換か）を通っているかが固定されていない。

E2E で次を固定する:
1. **2026-07-28 レーン**: initialize なし、`Mcp-Method` / `Mcp-Name` ヘッダーと `_meta` のプロトコルバージョン付きで `tools/list` と `tools/call` が成功する
2. **ヘッダーと本文の不一致**（例: `Mcp-Name` が本文のツール名と違う）は拒否される。**M04 で入れた `src/mcp/request-body.ts`（本文を自前で読んで parsedBody を渡す）がこの検証を迂回していないこと**を必ず確認する
3. **旧版レーン**（2025-11-25 / 2025-06-18 の initialize ありの流れ）も引き続き動く
4. 401 の `WWW-Authenticate` とリフレッシュの流れが両レーンで同じ
5. 認可: `/authorize` のリダイレクトに `iss` が付く（RFC 9207。workers-oauth-provider が付けていることは確認済み。テストで固定する）
6. 認可: DCR で `application_type: "native"` と localhost の redirect_uri を送るクライアントが登録できるか確認する（ライブラリのコードに `application_type` の扱いが見当たらない。登録できない場合は ADR に書き、M07 の確認項目にする。ライブラリに手を入れない）

agents（createMcpHandler）が 2. を実装していない場合は、Logbutler 側で検証を足す（テストを先に）。

## 完了条件

- `mise run test`（unit + e2e）と `mise run lint` が通る
- 環境変数 `LOGBUTLER_TOOLSETS` / `LOGBUTLER_READ_ONLY` / `LOGBUTLER_TIMEZONE` がコードとドキュメントから消えている（`grep` で 0 件）
- URL クエリと `timezone` 引数の unit + E2E
- 上記 2. の 1〜5 の E2E（6 は結果を ADR に記録）
- `docs/adr/0008-client-side-control-and-mcp-2026.md`

## TDD
unit・E2E とも実装前に Red を確認する（ユーザーの明示要求。E2E を後から書かない）。2. は既存挙動の固定が中心で Red にならないものがありうる。その場合はテストが実装を縛っていることを変異（例: request-body.ts でヘッダー検証を飛ばす）で確認し、報告する。

## やってはいけないこと
- ライブラリ（node_modules）の改変、実 Backlog への通信、テストを弱める・skip・削除、コミット・push、logvalet の変更、Durable Objects
