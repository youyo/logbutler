# ADR 0003: Backlog クライアントの直列化・リトライ・呼び出し上限

- 状態: 採用(M02)
- 日付: 2026-10-28

## 背景

logvalet(Go)の Backlog クライアントは次の性質を持つ。

- 一部のツールが `errgroup` で Backlog API を並列に呼ぶ。Backlog は「1 ユーザーのリクエストは直列に」と案内している。
- 429 は変換するだけで、リトライも `Retry-After` の解釈もない。
- 1 回のツール呼び出しで呼べる回数に上限がない(`digest_unified` は最悪 2,000 回超、`user_activity` は期間指定時に上限なしでページングする)。
- HTTP のタイムアウトはクライアント生成時の設定に依存する。

Logbutler は Workers 上のステートレスな MCP サーバーで、ユーザーのトークンで Backlog を呼ぶ。上の性質をそのまま移すと、レート制限の巻き添え(同じユーザーの他のクライアントも 429 になる)や、Workers の subrequest 上限・実時間制限への抵触が起きる。

## 決定

実機での確認(429 の実際の `Retry-After`、有料プランの subrequest 上限)は [docs/manual-verification.md](../manual-verification.md) の V12・V13。

`src/backlog/client.ts` の `createBacklogClient` は **1 回のツール呼び出しにつき 1 つ**作る(`registerTools` の `getClient` を tools/call ごとに呼ぶ)。状態(直列化のキュー・呼び出し回数)はクライアントごとに持つ。

| 項目 | 既定値 | 根拠 |
|---|---|---|
| 同時リクエスト数 | 1(直列) | Backlog の案内に従う。前のリクエスト(429 の待機を含む)が終わるまで次を始めない。失敗しても後続は続ける。Go 版の errgroup 方式は移植しない |
| 429 のリトライ | 最大 2 回(計 3 回まで) | 一時的な超過の大半は 1 回で抜ける。2 回で足りなければ呼び出し側(AI)に `rate_limited`(retryable=true)を返して判断させる方が、MCP クライアントを待たせ続けるより良い |
| 待ち時間の上限 | `Retry-After` 10 秒 | 2 回待っても 20 秒で、タイムアウト(30 秒)と MCP クライアント側の待ち時間に収まる。上限を超える `Retry-After` は待たずに `rate_limited` で返す |
| `Retry-After` がない・読めない | 1 秒待つ | 仕様上は秒数が来るはずだが、欠けても無限に叩かない。HTTP-date 形式は解釈しない(Backlog は秒数で返す) |
| 呼び出し回数の上限 | 50 回 / ツール呼び出し(リトライを含む) | Workers 無料プランの subrequest 上限(50)と同じ。Backlog のレート制限(1 分 600 回程度)の 1 割未満に収まる。超えたら `api_error`(retryable=false)で止まり、範囲を絞るよう促すメッセージを返す。重い集計ツール(M05 以降)は `maxApiCalls` を明示して上げる(有料プランの上限の範囲で) |
| タイムアウト | 30 秒 / リクエスト | 要件どおり。`AbortController` + `setTimeout` で打ち切る(テストで時計を差し替えられる)。タイムアウトと通信失敗は status 0 の `api_error`(retryable=true)にする |
| ページ上限 | 10 ページ × 100 件(`paging.ts`) | 自動ページングはクライアントに入れず、呼び出し側が `fetchByOffset` / `fetchByCursor` を使う。上限で止めたら `truncated: true` を返す |

その他:

- アクセストークンは `Authorization: Bearer` ヘッダーにだけ載せる。クエリ・エラーメッセージ・例外の原因には載せない(fetch の例外は原因を捨てて固定文にする。Backlog の本文に紛れていたら `[REDACTED]` に置換する)。
- GET はクエリ、それ以外は `application/x-www-form-urlencoded` の本文。配列は `key[]=v` の繰り返し。`undefined` / `null` は送らない。
- 待機(`sleep`)は差し替え可能にしてあり、テストでは実際に待たない。

## 帰結

- 同一ツール呼び出し内の並列化はできない。`digest` 系の速度は Go 版より遅くなりうるが、正しさとレート制限を優先する。
- 呼び出し回数の上限はクライアント単位なので、ツールが複数の `request` を使う処理は上限内に収まるよう設計する(M05 以降)。
- 429 の待機中はキューが詰まる。1 ユーザーの 1 ツール呼び出し内に閉じているため、他のユーザーには影響しない。

## 依存の確認(M01 持ち越し)

`@modelcontextprotocol/client` / `@modelcontextprotocol/sdk` / `zod` は、`agents`(0.28.1)の **optional ではない peer 依存**として宣言されており(`peerDependenciesMeta` に optional の指定がない)、`agents` を使う以上入れる必要がある。バージョンは `agents` の peer 範囲(`client` 2.3.1 / `sdk` 1.32.1 / `server` 2.3.1 / `zod ^4`)に合わせて固定している。`zod` は M02 からツールの入力スキーマにも使う。
