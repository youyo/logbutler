# ADR 0010: 起動時の設定チェック

- 状態: 採用(M07、2026-10-28)
- 関連: ADR 0001(OAuth サーバー)、ADR 0009(Access 連携の削除)、`docs/runbook.md`

## 背景

デプロイでは、書き換え忘れや投入忘れが起こりやすい: KV の id、`BACKLOG_SPACE_HOST` / `PUBLIC_BASE_URL` のプレースホルダ(`<domain>`)、
`wrangler secret put` の漏れ。何もしないと、`PUBLIC_BASE_URL` が不正なら `OAuthProvider` の生成で例外になり(`resourceMetadata.resource is required ...`)、
secret が欠けていれば `/callback` の Backlog 呼び出しで初めて失敗する。原因が応答から読み取れず、利用者の操作の途中で壊れる。

## 決定

`src/config-check.ts` の `checkConfig(env)` が、リクエストごとに(KV 読み取りなしの純粋な検査)次を調べる。`src/index.ts` の `fetch` が
`OAuthProvider` を作る**前**に呼ぶ(`/mcp` `/token` `/register` `/.well-known/*` は `OAuthProvider` が直接さばくので、Hono 側には置けない)。

| 項目 | 欠け(`missing`) | 使えない(`invalid`) |
|---|---|---|
| `OAUTH_KV` | KV namespace でない(未定義・`get` / `put` を持たない) | - |
| `BACKLOG_SPACE_HOST` | 未定義・空・空白だけ | プレースホルダ(`<...>`)が残っている。ホスト名の形式でない(スキーム・パス・空白を含む) |
| `PUBLIC_BASE_URL` | 同上 | プレースホルダが残っている。https のオリジンでない(パス・クエリ・フラグメント付き、http は loopback だけ可) |
| `BACKLOG_CLIENT_ID` / `BACKLOG_CLIENT_SECRET` | 同上 | プレースホルダが残っている |

欠け・不正があるとき:

- `/healthz` 以外は **500** `{"error":"server_misconfigured"}`(`Cache-Control: no-store`)。応答には項目名も値も出さない。
- 詳細は `console.error` に JSON 1 行: `{"event":"config_invalid","missing":[...],"invalid":[...]}`(Workers Logs で見る)。**項目名だけで、値は出さない**(秘密を含みうる)。
- `/healthz` は **503** `{"status":"misconfigured","missing":[...],"invalid":[...]}`。正常時は従来どおり 200 `{"status":"ok"}`。

### `/healthz` に項目名を出す理由

`/healthz` は匿名で叩ける。項目名(`BACKLOG_CLIENT_SECRET` など)は README に載せている公開情報で、値は出さない。
出すと、デプロイ直後に `curl https://<domain>/healthz` だけで「何が足りないか」が分かり、ログを開く手間が要らない(運用者の実利が大きい)。
一方で、攻撃者に分かるのは「この Worker は設定が壊れている」ことだけで、壊れた Worker は 500 しか返さないので悪用の余地が小さい。
ステータスを 503 にするのは、外形監視が「正常でない」ことをステータスだけで検知できるようにするため。

## 却下した案

- **`/healthz` は常に 200 `{"status":"ok"}`**: 設定が壊れていても正常に見え、監視が役に立たない。
- **項目名を `/healthz` に出さず、ログだけにする**: 安全側だが、デプロイ直後の切り分けが遅い。項目名は秘密ではないので出す。
- **起動時(モジュール読み込み時)に例外を投げる**: Workers にはグローバルスコープで env が無く、`/healthz` だけ生かすこともできない。
- **値の「それらしさ」まで検査する**(`BACKLOG_CLIENT_ID` の桁数など): Backlog 側の仕様に依存して誤検知しうる。形式の検査は、プレースホルダの残りやすい `BACKLOG_SPACE_HOST` と `PUBLIC_BASE_URL` に限る。

## 検査しないもの(限界)

- 値が**実在するか**(KV の id が本物か、Backlog のクライアント ID / シークレットが正しいか)。KV の id が実在しなくても `OAUTH_KV` の binding は存在するため、デプロイ後は `docs/manual-verification.md` の確認を行う。
- `PUBLIC_BASE_URL` が実際の公開ドメインと一致するか(`mise run verify:oauth` の `metadata` 段階が、保護リソースメタデータの `resource` と接続先の一致で検出する)。
- 実行コスト: 文字列の検査と `new URL()` だけで、リクエストごとに行っても無視できる。

## テスト

- unit: `test/unit/config-check.test.ts`(欠け・空白・プレースホルダ・形式・値を結果に載せないこと)。
- E2E: `test/e2e/config-check.test.ts`(Worker 全体を、設定を欠かした env で呼ぶ。`/mcp` `/token` `/register` `/authorize` `/callback` `/.well-known/*` が 500、`/healthz` が 503 と項目名、ログに項目名だけ)。
