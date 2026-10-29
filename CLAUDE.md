# CLAUDE.md

Logbutler(Backlog 用 Remote MCP サーバー。Cloudflare Workers + KV + Hono)の作業規約。
計画は `plans/`(ロードマップと各マイルストーン)、設計判断は `docs/adr/`。

> **下流リポジトリ**(upstream を fork / ミラーした組織のリポジトリ)のセットアップ・デプロイでは、以下の「デプロイは実行しない」等の規約は適用しない(upstream の開発時の規約)。秘密値の扱い・追跡ファイルを編集しない・コミットや push はユーザーの指示があるときだけ、は下流でも変わらない。`.claude/skills/logbutler-setup/SKILL.md` に従う(Codex も同じパス。`.agents/skills/` からの symlink)。

## 絶対に守ること

- **TDD**: 失敗するテストを先に書き、`mise run test:unit` / `mise run test:e2e` で期待どおりの理由で失敗するのを確認してから実装する。テストを弱める・skip・削除しない。バグ修正は再現テストが先。
- **mise**: ランタイムとコマンドは `mise.toml` で管理する。`npm test` や `vitest` を直接叩かず `mise run <task>` を使う。新しいコマンドが要るなら先にタスクへ追加する。
- 完了条件は `mise run test`(unit + e2e)と `mise run lint` が通ること。
- **Durable Objects / McpAgent は使わない**。MCP はステートレス(`createMcpHandler`)。
- **Backlog のトークンは grant の `props` にだけ置く**。ログ・エラーメッセージ・別の KV キー・MCP の応答に出さない。
- **Backlog API はモックのみ**。unit / e2e テストで実 Backlog に通信しない(`test/helpers/mock-fetch.ts` は未登録の宛先への通信を例外にする)。**例外は `mise run test:live`(`test/live/`)だけ**で、デプロイ済み Worker と実 Backlog に通信し、`LOGBUTLER_LIVE_PROJECT_KEY` のプロジェクトに書き込む。`mise run test` / CI には含めず、ユーザーの許可があるときだけ実行する。トークンは出力・エラーに出さない。
- 依存は公開から 2 週間以上たった正確なバージョンに固定する(`^` `~` を使わない)。`wrangler.jsonc` の `compatibility_date` も、固定した workerd が対応する日付まで。
- コミット・push・PR・リモート作成・デプロイは、ユーザーの指示があるときだけ。

## 出力規約(logvalet 互換)

- MCP ツールの出力は JSON を text content で返す(structuredContent は使わない)。キーは、**Backlog の生データは camelCase のまま、加工した出力は snake_case**(logvalet と同じ混在。ADR 0004)。
- エラーは spec §9 のエンベロープ: `{"schema_version":"1","error":{"code":"...","message":"...","retryable":false}}` を `isError: true` で返す(`src/errors.ts`)。
- Backlog API は 1 回のツール呼び出し内で直列(並列に呼ばない)。ページングは `src/backlog/paging.ts` を使い、ページ数の上限を付ける(ADR 0003)。呼び出しが膨らむツールは `defineTool` の `maxApiCalls` に最悪ケースの式から決めた値を明示し、テストで固定する(ADR 0006)。
- 分析系の時刻は `ToolContext.now`、日付はツール引数 `timezone`(省略時 Asia/Tokyo。`until` は当日を含める)。完了集合は `src/analysis/statuses.ts`。
- **フラグは環境変数にしない**(ADR 0008)。公開ツールを決める `toolsets` / `read_only` は `/mcp` の URL クエリ(`parseToolConfig`。不正値は 400)、呼び出し単位の `timezone` はツール引数(`registerTools` が検証。不正値は `argument_error`)。
- 読み取りツールには引数 `max_response_tokens`(応答サイズの安全網。既定 50000、0 で無効)が `defineTool` で自動的に付く。超過は切り詰めず `response_too_large`。ダウンロード系は `responseLimit: false`、書き込み系は対象外(ADR 0007)。呼び出し回数を調べるテストなど巨大な応答を返すものは `max_response_tokens: 0` を付ける。
- Cloudflare Access 連携は持たない(ADR 0009)。利用者の制限は Logbutler の外側で行う。
- **起動時の設定チェック**(`src/config-check.ts`、ADR 0010): 必須の vars / secrets / KV が欠けている・プレースホルダ(`<...>`)のままなら、`/healthz` 以外は 500、`/healthz` は 503 で項目名だけを返す。ログにも応答にも**値は出さない**。必須の設定を足したら `checkConfig` と unit / E2E を更新する。
- **デプロイは実行しない**: `mise run deploy` と `deploy:render` の実値での実行はユーザーが行う。作業では `mise run deploy:check`(ダミー値の dry-run)までにする。`wrangler secret put` や KV の作成も実行しない(手順は `docs/runbook.md`)。
- **upstream / 下流モデル**(ADR 0011): このリポジトリは upstream で、`wrangler.jsonc` はローカル開発・テスト用のダミー値の共有設定(`env` ブロックなし)。アカウント固有の値(Worker 名・KV id・ドメイン・Backlog スペース・client id/secret)は**追跡ファイルに書かない**。デプロイは `mise run deploy:render` が `LOGBUTLER_*` 環境変数から gitignore 済みの `wrangler.deploy.jsonc` を生成し、`wrangler deploy -c` する(`mise.local.toml` の `[env]` / GitHub の Variables)。`wrangler.jsonc` のトップレベル(`compatibility_date` など)を変えれば下流に pull で届く。生成項目を足したら `scripts/render-wrangler-config/core.ts`・unit・E2E・runbook を更新する。
- GitHub Actions は**コミット SHA で固定**する(`.github/workflows/ci.yml`)。更新時は `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` で実在を確かめる。
- ツール名の接頭辞は `logbutler_`。
- **状態・設定の ID を決め打ちしない**(ADR 0012)。テストも `meta_*` で取得するか、`project_settings` のツールでスイート自身が作る(実環境 E2E は名前に `[live <時刻>]` を付け、`afterAll` で必ず消す)。

## 構成

```
src/index.ts                  default export { fetch }。OAuthProvider を PUBLIC_BASE_URL から作って呼ぶ
src/app.ts                    Hono: /healthz, /authorize(同意), /callback。Access 連携はない(ADR 0009)
src/auth/authorization-server.ts  OAuthProvider の設定(/mcp は apiHandler、それ以外は app.ts)
src/auth/backlog-oauth.ts     Backlog の認可 URL・コード交換・リフレッシュ(ローテーション有無の両対応)
src/auth/token-exchange.ts    tokenExchangeCallback: MCP トークン更新時に Backlog も更新
src/auth/backlog-stale.ts     Backlog の 401 を受けた grant に印を置き、次の MCP トークン更新で(期限に関係なく)Backlog も更新させる
src/auth/consent-page.ts      同意画面(クライアント由来の文字列は必ずエスケープ)
src/mcp/api-handler.ts        /mcp の下流。Backlog 401 を HTTP 401 に変換
src/mcp/server.ts             McpServer のファクトリ(リクエストごとに生成)
src/mcp/response-limit.ts    応答サイズの上限(推定トークン数。ADR 0007)
src/mcp/args.ts              ツール共通の引数処理(zod ビルダー・ID 解決・日付・CSV・パスのエスケープ)
src/mcp/tools/                ツール(toolset ごとに 1 ファイル。`index.ts` の ALL_TOOLS に足す)。分析系 11 個は `analysis.ts`、digest 系 6 個と user_activity は `digest.ts`(定義だけ。ロジックは `src/analysis/`)、公式 MCP 由来の通知系 2 個は `notification.ts`、`project_users` は `project.ts`、プロジェクト設定 12 個(カテゴリー・バージョン・状態・カスタム属性の add / update / delete。toolset `project_settings`。既定で公開、`read_only=true` で隠れる。ADR 0013)は `project-settings.ts`
src/config-check.ts          起動時の設定チェック(ADR 0010)。src/index.ts が OAuthProvider の前に呼ぶ
scripts/verify-oauth/        実環境の OAuth 確認 CLI(`mise run verify:oauth`)。core.ts(Web 標準 API だけ。入出力は VerifyIo で注入)・args.ts・loopback.ts(node:http)・main.ts(Node 24 の型ストリップで直接実行。TS の enum / parameter property は使わない)
.github/workflows/ci.yml     lint / test / deploy:check(アクションは SHA 固定)
.github/workflows/deploy.yml 下流のデプロイ(Variable LOGBUTLER_WORKER_NAME が空の upstream では飛ばす)
scripts/render-wrangler-config/  wrangler.jsonc + LOGBUTLER_* → wrangler.deploy.jsonc(core.ts: JSONC 読み・検証・差し替え。main.ts: 入出力。Node 24 の型ストリップで直接実行)
.claude/skills/logbutler-setup/SKILL.md  下流リポジトリのセットアップ案内スキル(`.agents/skills/` から symlink)
docs/runbook.md  docs/manual-verification.md   デプロイ・運用の手順書と、未検証の前提の実機確認リスト(ADR の「未検証の前提」から V01〜 / P1〜 でリンクしている)
src/analysis/open-statuses.ts   「未完了」の状態 ID をプロジェクトの状態一覧(完了集合以外)から決める(ADR 0012。状態 ID を決め打ちしない)
src/analysis/                 分析系の加工ロジック(M05)。envelope.ts(AnalysisEnvelope・warning)・dates.ts(タイムゾーンの日付境界)・issues.ts(課題の全件取得)・budget.ts(ツールごとの maxApiCalls)・statuses.ts(完了集合)・activity-range.ts(期間つきのアクティビティ取得。maxId を必ず進める)・snippet.ts(コードポイント単位の抜粋)と、ツールごとの関数(digest 系は DigestEnvelope)
src/backlog/client.ts         Backlog API クライアント(request / download。本文の読み取りも同じ期限)
test/unit/  test/e2e/  test/helpers/(tool-call.ts: 実クライアント + モック fetch でツールを呼ぶ)  test/fixtures/(logvalet の tools/list baseline。コピー元は README)  test/snapshots/(tools/list のスナップショット)
```

## テストの書き方

- 実行環境は workerd(`@cloudflare/vitest-plugin`)。`vitest.config.ts` の `unit` / `e2e` の 2 プロジェクトと、Node 環境の `node` プロジェクト(`test/node/`。`node:http` が要る verify:oauth のループバック受信だけ。`test:unit` に含まれる)と `node-e2e` プロジェクト(`test/node-e2e/`。生成スクリプトを実プロセスで起動し、生成物を `wrangler deploy --dry-run -c` に通す。`test:e2e` に含まれる)。
- workerd のテストで `cloudflare:test` を import しない(import すると並列実行時に他ファイルの初回リクエストがタイムアウトする)。Worker 全体を任意の env で呼ぶときは `import worker from "../../src/index"` に env とダミーの ctx を渡す(`test/e2e/config-check.test.ts`)。
- verify:oauth の E2E(`test/e2e/verify-oauth.test.ts`)は、core を Worker とモック Backlog に対して動かし、ブラウザの段は `io.openBrowser` で `/authorize` → `/callback` を直接たどる。`main.ts` と `loopback.ts` の実機側は `test/node/` と手動確認。
- README のツール一覧は `test/unit/readme-tools.test.ts` が `ALL_TOOLS` と突き合わせる。ツールを足したら README の表(toolset ごとの件数)も更新する。
- E2E は `test/helpers/oauth-flow.ts` の `worker.fetch`(Worker 全体への HTTP)で、`/register` → `/authorize` → `/callback` → `/token` → `/mcp` を通しで行う。Backlog は `vi.spyOn(globalThis, "fetch")` で差し替える(同じ isolate で動くため Worker にも効く)。
- 時刻に依存する挙動(Backlog トークンの期限切れ)は `vi.useFakeTimers({ toFake: ["Date"] })` で進める。コード側は `Date.now` の参照を保持せず、呼び出し時に `Date.now()` を読むこと。
- ツールを足す・変えたら `test/snapshots/tools_list.json` を意図して更新する: `mise run test:update-snapshots`。logvalet の baseline との比較は `test/helpers/baseline.ts`(許容する差分は理由つきで `ALLOWED_*` に足す)。

## API の確認

このリポジトリの OAuth / MCP の API 名は記憶でなく `node_modules` の `.d.ts` と docs で確認する:
`node_modules/@cloudflare/workers-oauth-provider/docs/`、`node_modules/agents/docs/mcp-servers.md`。
