# CLAUDE.md

Logbutler(Backlog 用 Remote MCP サーバー。Cloudflare Workers + KV + Hono)の作業規約。
計画は `plans/`(ロードマップと各マイルストーン)、設計判断は `docs/adr/`。

## 絶対に守ること

- **TDD**: 失敗するテストを先に書き、`mise run test:unit` / `mise run test:e2e` で期待どおりの理由で失敗するのを確認してから実装する。テストを弱める・skip・削除しない。バグ修正は再現テストが先。
- **mise**: ランタイムとコマンドは `mise.toml` で管理する。`npm test` や `vitest` を直接叩かず `mise run <task>` を使う。新しいコマンドが要るなら先にタスクへ追加する。
- 完了条件は `mise run test`(unit + e2e)と `mise run lint` が通ること。
- **Durable Objects / McpAgent は使わない**。MCP はステートレス(`createMcpHandler`)。
- **Backlog のトークンは grant の `props` にだけ置く**。ログ・エラーメッセージ・別の KV キー・MCP の応答に出さない。
- **Backlog API はモックのみ**。unit / e2e テストで実 Backlog・実 Cloudflare Access に通信しない(`test/helpers/mock-fetch.ts` は未登録の宛先への通信を例外にする)。
- 依存は公開から 2 週間以上たった正確なバージョンに固定する(`^` `~` を使わない)。`wrangler.jsonc` の `compatibility_date` も、固定した workerd が対応する日付まで。
- コミット・push・PR・リモート作成・デプロイは、ユーザーの指示があるときだけ。

## 出力規約(logvalet 互換)

- MCP ツールの出力は JSON を text content で返す(structuredContent は使わない)。キーは、**Backlog の生データは camelCase のまま、加工した出力は snake_case**(logvalet と同じ混在。ADR 0004)。
- エラーは spec §9 のエンベロープ: `{"schema_version":"1","error":{"code":"...","message":"...","retryable":false}}` を `isError: true` で返す(`src/errors.ts`)。
- Backlog API は 1 回のツール呼び出し内で直列(並列に呼ばない)。ページングは `src/backlog/paging.ts` を使い、ページ数の上限を付ける(ADR 0003)。呼び出しが膨らむツールは `defineTool` の `maxApiCalls` に最悪ケースの式から決めた値を明示し、テストで固定する(ADR 0006)。
- 分析系の時刻は `ToolContext.now`、日付はツール引数 `timezone`(省略時 Asia/Tokyo。`until` は当日を含める)。完了集合は `src/analysis/statuses.ts`。
- **フラグは環境変数にしない**(ADR 0008)。公開ツールを決める `toolsets` / `read_only` は `/mcp` の URL クエリ(`parseToolConfig`。不正値は 400)、呼び出し単位の `timezone` はツール引数(`registerTools` が検証。不正値は `argument_error`)。
- ツール名の接頭辞は `logbutler_`。

## 構成

```
src/index.ts                  default export { fetch }。OAuthProvider を PUBLIC_BASE_URL から作って呼ぶ
src/app.ts                    Hono: /healthz, /authorize(同意), /callback。/authorize と /callback は Access JWT 必須
src/auth/authorization-server.ts  OAuthProvider の設定(/mcp は apiHandler、それ以外は app.ts)
src/auth/access-jwt.ts        Cf-Access-Jwt-Assertion の検証(JWKS キャッシュ)
src/auth/backlog-oauth.ts     Backlog の認可 URL・コード交換・リフレッシュ(ローテーション有無の両対応)
src/auth/token-exchange.ts    tokenExchangeCallback: MCP トークン更新時に Backlog も更新
src/auth/consent-page.ts      同意画面(クライアント由来の文字列は必ずエスケープ)
src/mcp/api-handler.ts        /mcp の下流。Backlog 401 を HTTP 401 に変換
src/mcp/server.ts             McpServer のファクトリ(リクエストごとに生成)
src/mcp/args.ts              ツール共通の引数処理(zod ビルダー・ID 解決・日付・CSV・パスのエスケープ)
src/mcp/tools/                ツール(toolset ごとに 1 ファイル。`index.ts` の ALL_TOOLS に足す)。分析系 11 個は `analysis.ts`(定義だけ。ロジックは `src/analysis/`)
src/analysis/                 分析系の加工ロジック(M05)。envelope.ts(AnalysisEnvelope・warning)・dates.ts(タイムゾーンの日付境界)・issues.ts(課題の全件取得)・budget.ts(ツールごとの maxApiCalls)・statuses.ts(完了集合)と、ツールごとの純粋関数
src/backlog/client.ts         Backlog API クライアント(request / download。本文の読み取りも同じ期限)
test/unit/  test/e2e/  test/helpers/(tool-call.ts: 実クライアント + モック fetch でツールを呼ぶ)  test/fixtures/(logvalet の tools/list baseline。コピー元は README)  test/snapshots/(tools/list のスナップショット)
```

## テストの書き方

- 実行環境は workerd(`@cloudflare/vitest-plugin`)。`vitest.config.ts` の `unit` / `e2e` の 2 プロジェクト。
- E2E は `test/helpers/oauth-flow.ts` の `worker.fetch`(Worker 全体への HTTP)で、`/register` → `/authorize` → `/callback` → `/token` → `/mcp` を通しで行う。Backlog と Access JWKS は `vi.spyOn(globalThis, "fetch")` で差し替える(同じ isolate で動くため Worker にも効く)。
- 時刻に依存する挙動(Backlog トークンの期限切れ)は `vi.useFakeTimers({ toFake: ["Date"] })` で進める。コード側は `Date.now` の参照を保持せず、呼び出し時に `Date.now()` を読むこと。
- Access の JWT はテスト用の鍵ペアで署名する(`test/helpers/access.ts`)。
- ツールを足す・変えたら `test/snapshots/tools_list.json` を意図して更新する: `mise run test:update-snapshots`。logvalet の baseline との比較は `test/helpers/baseline.ts`(許容する差分は理由つきで `ALLOWED_*` に足す)。

## API の確認

このリポジトリの OAuth / MCP の API 名は記憶でなく `node_modules` の `.d.ts` と docs で確認する:
`node_modules/@cloudflare/workers-oauth-provider/docs/`、`node_modules/agents/docs/mcp-servers.md`。
