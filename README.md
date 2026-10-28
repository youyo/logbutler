# Logbutler

**Your AI Butler for Backlog** — Backlog を AI エージェントから使うための Remote MCP サーバー。
Cloudflare Workers 上で動き、Cloudflare MCP Server Portals 経由で使うことを前提にしている。

Go 製の Backlog CLI [logvalet](https://github.com/youyo/logvalet) が持つ Remote MCP 機能を TypeScript に移植するプロジェクトで、現在は **M02(Backlog クライアントと基盤)** まで。
ツールは `logbutler_user_me`(認証ユーザー情報)だけで、残りは `plans/logbutler-roadmap.md` の M03 以降で移植する。

> **商標について**: Backlog は株式会社ヌーラボの登録商標です。Logbutler は個人プロジェクトであり、株式会社ヌーラボとは無関係です。

## 構成

- Cloudflare Workers + KV + Hono。Durable Objects は使わない
- Worker 自身が OAuth 2.1 認可サーバー(`@cloudflare/workers-oauth-provider`)になり、上流の IdP は Backlog OAuth 2.0
- MCP は `agents` の `createMcpHandler` によるステートレス実装(`@modelcontextprotocol/server` v2)
- 1 デプロイ = 1 Backlog スペース(`BACKLOG_SPACE_HOST`)

```
MCP クライアント (Portal) ──/mcp, /token, /register, /.well-known/*──▶ Worker(Worker 発行トークンで保護)
利用者のブラウザ ──/authorize, /callback──▶ Cloudflare Access ──▶ Worker ──▶ Backlog OAuth
```

設計の理由は `docs/adr/` を参照。

- [ADR 0001: Worker 自身を OAuth 認可サーバーにする](docs/adr/0001-oauth-server-in-worker.md)
- [ADR 0002: 認可サーバーと MCP サーバーを 1 つの Worker に同居させる](docs/adr/0002-single-worker-auth-and-mcp.md)
- [ADR 0003: Backlog クライアントの直列化・リトライ・呼び出し上限](docs/adr/0003-backlog-client-serialization-and-retry.md)
- [ADR 0004: ツールの出力形式とエラー形式](docs/adr/0004-tool-output-and-error-format.md)

## 開発

ランタイムとコマンドは [mise](https://mise.jdx.dev/) で管理する(`mise.toml`)。

```sh
mise install            # node / pnpm
mise run install        # 依存パッケージ
mise run test           # unit + e2e
mise run lint           # Biome + tsc
mise run fmt            # Biome で整形
mise run build          # デプロイせずバンドルできるか確認 (wrangler deploy --dry-run)
mise run dev            # wrangler dev
```

- テストは `@cloudflare/vitest-plugin`(旧 `@cloudflare/vitest-pool-workers`)で workerd 上で動く。
  E2E は Worker 全体(`src/index.ts` の default export)へ HTTP を送り、Backlog と Cloudflare Access の JWKS への outbound fetch だけをモックする。実 Backlog・実 Access へは通信しない。
- lint / 整形は Biome(単一ツールで設定が小さく、型検査は `tsc` で別に行うため)。
- 依存パッケージは公開から 2 週間以上たった正確なバージョンに固定している(`^` / `~` は使わない)。

### 環境変数・バインディング

| 名前 | 種別 | 説明 |
|---|---|---|
| `OAUTH_KV` | KV | OAuth の grant・トークン・クライアント登録 |
| `BACKLOG_SPACE_HOST` | var | 例 `example.backlog.com` |
| `ACCESS_TEAM_DOMAIN` | var | 例 `your-team.cloudflareaccess.com` |
| `ACCESS_AUD` | var | Cloudflare Access アプリの AUD タグ |
| `PUBLIC_BASE_URL` | var | この Worker の公開オリジン(例 `https://logbutler.example.com`)。issuer とリソース識別子になる |
| `BACKLOG_CLIENT_ID` | secret | Backlog OAuth クライアント ID |
| `BACKLOG_CLIENT_SECRET` | secret | Backlog OAuth クライアントシークレット |

### 接続 URL のクエリとツール引数(クライアントが決める設定)

運用者の環境変数ではなく、クライアント(Portal に登録する URL、呼び出しごとの引数)が決める。

| 設定 | 置き場所 | 説明 |
|---|---|---|
| `toolsets` | `/mcp` の URL クエリ | 公開するツールのグループ(カンマ区切り、既定 `all`)。例 `/mcp?toolsets=issue,wiki`。`issue` `project` `user` `activity` `document` `team` `space` `meta` `shared_file` `star` `watching` `wiki` `analysis` `digest` `search` `notification` |
| `read_only` | `/mcp` の URL クエリ | `true` で書き込み・破壊的ツールを公開しない(既定 `false`)。例 `/mcp?toolsets=issue&read_only=true` |
| `timezone` | ツール引数 | 「今日」「今週」の基準になる IANA 名(省略時 `Asia/Tokyo`)。`issue_list` `my_tasks` `digest_daily` `digest_weekly` `activity_stats` `issue_timeline` にある |

不正なクエリ値(未知の toolset 名、`read_only` が `true`/`false` 以外)は 400 で、理由を本文に返す。不正な `timezone` は `argument_error`。
詳細と未検証の前提は ADR 0008。

ローカルでは `.dev.vars.example` をコピーして `.dev.vars` を作る(コミットしない)。

### Cloudflare Access の設定(デプロイ時)

self-hosted アプリで **`/authorize` と `/callback` だけ** を保護する。`/mcp`・`/token`・`/register`・`/.well-known/*`・`/healthz` は Portal などがサーバー間で呼ぶので Access を通さない(Bypass)。
Worker は `/authorize` と `/callback` で `Cf-Access-Jwt-Assertion` の署名・iss・aud・期限を検証するので、Access の設定漏れは 403 になる。

## 状態

M01 は実デプロイしていない。Backlog のリフレッシュトークンのローテーション有無と、KV の結果整合性がリフレッシュに与える影響は未検証で、ADR 0001 に記載している。
