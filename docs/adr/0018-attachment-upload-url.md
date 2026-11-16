# ADR 0018: 添付アップロードの URL 経路(prepare → PUT → upload_id)

- 状態: 採用(2026-11-16。cto の決裁 2 件: 初回と、独立レビューを受けた再決裁。同日、利用者の要望「15 分は長すぎる」を受けた cto の決裁で、期限を PUT の受付 60 秒と完了 15 分に分けた)
- 関連: ADR 0004(上限 20 MiB・エラーのエンベロープ)、ADR 0005(冪等キャッシュ)、ADR 0007(応答サイズの上限)、ADR 0008(フラグを環境変数にしない)、ADR 0010(起動時の設定チェック)、ADR 0011(デプロイ設定の生成。**本 ADR が例外を 1 つ足す**)

## 背景

`logbutler_issue_attachment_upload` は、ファイルの中身を `file_content_base64`(4 MiB まで)で受け取る。MCP クライアントの LLM に base64 を書き出させるため、大きいファイルでは出力トークンを大量に使い、途中で壊れやすい。
Claude Code のように shell から Worker に届くクライアントなら、ファイルは `curl` で直接送れる。LLM が扱うのは短い ID と URL だけで済む。

## 決定

### 手順

1. `logbutler_issue_attachment_upload_prepare`(引数なし)が `{upload_id, upload_url, expires_at, max_bytes, curl, instructions}` を返す。`upload_url` は `{PUBLIC_BASE_URL}/uploads/<upload_id>`、`curl` は `curl -sS --fail -T <path> '<upload_url>'`。`expires_at` は **PUT を始める期限**(prepare から 60 秒)。description と `instructions` に「秘密のアップロード URL で、60 秒有効。PUT が 404 なら prepare からやり直す。完了(`logbutler_issue_attachment_upload` に `issue_key`・`file_name`・`upload_id` を渡す)は PUT の成功から 15 分以内」と書く。
2. クライアントの shell が、prepare から 60 秒以内に `curl -T` で `PUT /uploads/<upload_id>` する(OAuth の外側。URL が capability)。
3. PUT の成功(data の保存)から 15 分以内に、既存の `logbutler_issue_attachment_upload` に `upload_id` を渡して完了する。`upload_id` と `file_content_base64` は排他(両方・どちらも無しは `argument_error`)。`file_name` は必須で、base64 の経路と同じくベース名にする。base64 の経路の挙動は変えない。

対象は shell から Worker に届くクライアント。claude.ai のサンドボックスからの PUT は範囲外。

### R2 binding `UPLOAD_BUCKET`(任意)

- 一時置き場は R2(binding `UPLOAD_BUCKET`)。`checkConfig` の必須には**足さない**(ADR 0010 は変えない)。binding が無くても Worker は従来どおり動く。
- binding が無いとき: prepare を `tools/list` に出さない(`api-handler.ts` が `ALL_TOOLS` から外す)。`PUT /uploads/*` は 404。`upload_id` を渡されたら Backlog を呼ばずに `argument_error`(「base64 を使う」と案内)。**スキーマは binding の有無で変えない**。
- **ADR 0008 との関係**: binding の有無は「機能が物理的に動くか」であり、フラグではない。R2 が無ければ URL 経路はそもそも動かないので、出さない。文字列の vars で機能を切り替えることは引き続き禁止する。
- `wrangler.jsonc` にはローカル・テスト用のダミーの `r2_buckets`(`logbutler-uploads-local`)を置く。
- 生成スクリプト(`scripts/render-wrangler-config/core.ts`)は、`LOGBUTLER_UPLOAD_BUCKET_NAME` があれば `bucket_name` を差し替え、無ければ `r2_buckets` から UPLOAD_BUCKET の要素を取り除く(空になれば `r2_buckets` ごと)。**ADR 0011 の「それ以外はそのまま届く」への例外**: ダミー名のバケットを下流にデプロイさせないため。`mise run deploy:check` は「あり」(`--example`)と「なし」(`--example --no-upload-bucket`)の両方を dry-run する。
- R2 のライフサイクルルールで `ticket/`・`data/`・`claim/` を 1 日で消すことを、runbook と setup スキルの**必須手順**にする。

### R2 のキー

| キー | 本文 | 書き方 |
|---|---|---|
| `ticket/<id>` | `{uid, expiresAt}`(expiresAt は PUT の受付期限 = prepare から 60 秒) | prepare が put |
| `data/<id>` | PUT の本文 | `If-None-Match: *`(存在しなければ)。2 回目は 409 |
| `claim/<id>` | `{uid, issue_key, file_name, state, attachmentId?, claimedAt, nonce}` | 作成は `If-None-Match: *`、以降はすべて `etagMatches` |

- upload_id は 256bit の乱数(`crypto.getRandomValues` → base64url、43 文字)。prepare を 2 回呼べば別の ID になる。
- **1 Worker が扱うのは 1 スペース**(`BACKLOG_SPACE_HOST` は固定)なので、所有者は Backlog のユーザー ID(`uid`)だけで照合する。

### prepare のカテゴリ

**WriteIdempotent + 注釈 `idempotentHint: false`**。WriteNonIdempotent にすると registry の冪等キャッシュ(ADR 0005)で包まれ、同じ URL が 5 分間返り、capability URL が KV の `idem:` に残るため。WriteIdempotent なので `read_only=true` では隠れ、`max_response_tokens` は付かない(ADR 0007)。toolset は `issue`。

### PUT /uploads/:id(`src/uploads/put.ts`。Hono、OAuth の外側)

判定の順序:

1. binding が無い → 404。
2. ID の形式が不正(base64url の 43 文字でない)→ R2 を読まずに 404。
3. ticket が無い・PUT の受付期限(prepare から 60 秒)切れ → 404(存在を教えない)。判定は本文を読む前なので、転送が 60 秒を超えても受付は切れない。
4. `Content-Length` が無い → 411、0 → 400、上限 `MAX_URL_UPLOAD_BYTES`(20 MiB)超え → 413。いずれも本文を読む前。
5. `request.body` をそのまま `data/<id>` に「存在しなければ」で put。null なら 409。
6. 保存した `size` が `Content-Length` と違えば、消して 400。put 自体が例外(R2 の障害、本文が途中で切れた、など)なら、何も書かれていないので消さずに 503(同じ URL で再送できるのは、prepare から 60 秒以内に限る。過ぎていれば 404 なので prepare からやり直す)。

応答は `Cache-Control: no-store`、成功は 201 で本文は `{upload_id, size}` だけ。CORS のヘッダは付けない。GET などのメソッドは作らない。アプリのログに ID を出さない。
R2 の想定外の例外は 503 `{"error":"storage_unavailable"}` にし、ログには `{"event":"upload_storage_failed","error":<例外名>}` だけを出す(R2 の例外の文面にはキー = upload_id が入りうるため。ツール側も同じ扱い)。
上限 20 MiB はダウンロード(ADR 0004)と同じ値で置いた。**実環境での確認(V19・V20)が済むまで、この値は暫定**。

### 完了(`src/uploads/attach.ts`)

claim は**削除せず、すべての遷移を条件付き put で行う**(R2 の `delete` には `onlyIf` が無い。`@cloudflare/workers-types` の `R2Bucket.delete(keys)` で確認)。遷移の前提には、自分の put が返した etag を使う。

| 遷移 | 条件 | 失敗したとき |
|---|---|---|
| なし → claimed | ticket があり uid が一致し、data があり、その保存時刻から 15 分以内 | 下の「完了の入口」の順に判定する。claim は作らない |
| claimed → attached(attachmentId) | `POST /space/attachment` の成功後 | put が不成立 = 引き継がれた。PATCH に進まず「処理中」(retryable) |
| claimed → released | POST が失敗(明確なエラー応答でも、例外・タイムアウトでも同じ) | 元のコードで retryable にして返す。**401 は元の例外のまま**(MCP の HTTP 401 に変換させる) |
| released / lease 切れの claimed → claimed | 引き継ぎ。lease は claimedAt から 2 分 | lease 内の 2 人目は「処理中」(retryable) |
| attached → done | PATCH の成功後 | PATCH の応答不明(通信失敗・5xx・429): attached のまま retryable |

- **完了の入口**(claim が無いとき。期限は claim が無いときだけ見る):
  1. ticket が無い、または uid が違う → `not_found`。
  2. data がある → 保存時刻から 15 分(`COMPLETE_WINDOW_MS`)以内なら進む。過ぎていれば `not_found`。ticket の受付期限(60 秒)は見ない。
  3. data が無い → ticket が受付期限内なら「未アップロード」(`not_found`、retryable)。期限切れなら `not_found`。
- **保存時刻は R2 の `uploaded`**(`head` が返す、R2 が保存した時刻)を使う。PUT が自分の時計で customMetadata に書く案は採らない(R2 の値で足り、書き手の時計に依存しない)。unit では `head` で読んだ `uploaded` を基準に時刻を与えて境界を固定する。
- 所有者: claim があれば `claim.uid`、無ければ `ticket.uid` と照合する。不一致は「存在しない・期限切れ」と同じエラー(`not_found`)。
- 再試行で `issue_key` か `file_name` が claim と違えば `argument_error`。
- attached からの再試行は POST を飛ばし、同じ attachmentId で PATCH だけ(lease も ticket の期限も見ない)。再試行の PATCH を Backlog が 4xx(401・429 を除く)で拒否したら、「すでに添付済みの可能性がある。`logbutler_issue_attachment_list` で確認を」と案内する(retryable: false)。
- done の後の呼び出しは「完了済み」(`argument_error`)。
- 正常系: 所有者と期限(data の保存から 15 分)→ claim → data を読む(R2 → Blob → FormData)→ POST → attached → PATCH → done → 削除(**ticket → data の順**)。削除の失敗は無視して成功を返す(ライフサイクルで回収)。成功の応答は base64 の経路と同じ PATCH の結果。
- claim の本文に**試行ごとの乱数(nonce)**を入れる。R2 の etag は内容のハッシュ(unit で確認)なので、時刻が同じだと claimed → released → claimed で etag が元に戻り、古い処理の etagMatches が通ってしまうため。
- `maxApiCalls` は既定(50)のまま。Backlog の呼び出しは最大 2 回(POST と PATCH)だが、429 の自動リトライも回数に数えるので 2 にはしない。

エラーのコード(既存の `src/errors.ts` から選んだ):

| 状況 | code | retryable |
|---|---|---|
| binding が無い Worker で `upload_id` | `argument_error` | false |
| 存在しない・期限切れ・他人の upload_id、形式不正 | `not_found` | false |
| 未アップロード(data が無い) | `not_found` | true |
| 処理中(lease 内・引き継がれた・同時作成に負けた) | `generic_error` | true |
| POST の失敗 | 元のコード(通信失敗は `api_error`) | true |
| PATCH の応答不明 | 元のコード(通信失敗は `api_error`) | true |
| 初回の PATCH が 4xx(401・429 を除く) | 元のコード(文面で prepare からのやり直しを案内) | 元のまま |
| 再試行の PATCH が 4xx | 元のコード | false |
| 完了済み | `argument_error` | false |
| R2 の想定外の失敗(prepare・完了) | `generic_error` | true |

### 冪等キャッシュとの関係

`logbutler_issue_attachment_upload` は WriteNonIdempotent なので、registry の冪等キャッシュ(ADR 0005。5 分)で包まれる(base64 の経路を変えないため registry は触らない)。キーは引数のハッシュで、upload_id は KV に平文では残らない。

- 成功から 5 分以内に同じ引数で呼ぶと、キャッシュの成功が返る(Backlog も R2 も見ない。E2E で固定)。5 分を過ぎると「完了済み」になる(unit で固定)。
- 失敗はキャッシュしないので、再試行は状態の遷移どおりに進む。

## 理由

- LLM が書くのは 43 文字の ID と短い URL だけになり、20 MiB まで扱える(base64 は 4 MiB)。
- Durable Objects を使わない方針のまま、R2 の条件付き put だけで、二重実行と途中終了からの回復を扱える。miniflare で原子性を unit(`test/unit/r2-conditional.test.ts`)で確認した。
- binding を任意にしたので、R2 を使わない運用者は何もしなくてよい。

## 却下した案

- **prepare を WriteNonIdempotent にする**: 冪等キャッシュで同じ URL が返り、capability URL が `idem:` に残る(上記)。
- **vars のフラグで URL 経路を有効にする**: ADR 0008 に反する。binding の有無で決める。
- **ticket の期限を単純に 60 秒にする**(PUT と完了を同じ期限にする): prepare → PUT → 完了の LLM の往復 3 回が 60 秒に収まらない。
- **完了の期限をなくす**: 放置された data が、いつまでも添付できる状態になる。
- **claim を削除して状態を戻す**: R2 の `delete` は条件を付けられず、別の呼び出しが作った claim を消しうる。
- **一時置き場(本文・ticket・状態)を既存の `OAUTH_KV` に置く**: 次の 3 つの理由による([How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/))。
  - 存在しないキーの読み取りもキャッシュされる。PUT より先に完了を呼ぶと、直後の再試行も空振りする。
  - 書いた拠点ですぐ読めることも、公式は保証していない。
  - 条件付きの書き込みがない(二重実行を防げない)。
  - ADR 0005 の冪等キャッシュは KV が失敗しても呼び出しを止めない(best-effort)が、今回の置き場は処理の本線にあり、読み書きの不確かさがそのまま結果を左右する。
- **UPLOAD_BUCKET を必須の設定にする**: ADR 0010 により、既存の下流は pull して deploy しただけで全経路が 500 になる。バケットがなければ deploy 自体も失敗する。
- **完了を別ツール(`_upload_complete`)にする**: ツールが 2 個増える。既存の `issue_attachment_upload` に `issue_key` と `file_name` がある。
- **ticket を grant 単位に束縛する**: 権限は利用者単位で同じ。grantId を取るための配線が増える。
- **prepare で `issue_key` と `file_name` を束縛する**: 完了は同じ利用者のトークンで実行されるので、安全上の意味がない。不一致の扱いが増える。
- **POST の応答が不明なときに claim を残してエラーにする**: POST の重複は無害(結び付けなかった一時添付が残るだけ)で、行き止まりを作るだけ。released にして再試行させる。
- **利用者ごとの発行数の制限**: 数えるには R2 の一覧取得か別の置き場が要る。限界として受け入れ、ライフサイクルルールで回収する(下の「限界」)。

## 独立レビュー(決裁とは別の記録)

openai/gpt-6.1-sol による独立レビューの指摘と、cto の再決裁での採否。

| # | 指摘 | 採否 | 反映 |
|---|---|---|---|
| 1 | Backlog で部分的に成功したとき(POST は成功、PATCH は不明)の二重実行 | 採用 | claim に進捗(state)と attachmentId を持たせ、attached からの再試行は PATCH だけにする |
| 2 | Worker が途中で終了したときの回復 | 採用 | claimedAt から 2 分の lease。切れたら引き継げる |
| 3 | 発行数の制限 | 不採用 | 限界として書き(下記)、ライフサイクルルールを必須にする |
| 4 | スペースをまたぐ照合 | 該当しない | 1 Worker = 1 スペース。uid だけで照合する |
| 5 | 遅れて届いた PUT | 採用 | 完了時の削除を ticket → data の順にする(ticket が無ければ PUT は 404 で、data は作り直されない) |
| 7 | URL がログに残る | 採用 | 秘密の URL であることを description・応答に明記し、Workers Logs に残ることとログの保持の確認を runbook(5-1)に書く |

## 適用範囲

- `logbutler_issue_attachment_upload` の `upload_id` と、`logbutler_issue_attachment_upload_prepare`、`PUT /uploads/:id`。
- ほかのアップロード(Wiki・ドキュメントの添付など)は対象外。同じ方式を広げるときは本 ADR を参照して別に決める。

## 限界

- **発行数を制限しない**: 認可済みの利用者は prepare を何度でも呼べ、PUT だけして放置すれば R2 に溜まる(最大 20 MiB × 発行数)。ライフサイクルルール(1 日)で消える前提。利用者は OAuth で認可済みの人に限られる。
- URL を知っていれば誰でも、prepare から 60 秒以内に 1 回だけ PUT を始められる(capability URL)。完了は uid を照合するので、他人が完了させることはできない。
- 60 秒を過ぎても転送中の PUT がある間に完了を呼ぶと、data がまだ無く ticket の受付期限も切れているので `not_found` になる(まれ。PUT の完了を待ってから呼べば完了できる)。
- 引き継がれた側が POST した一時添付は、課題に結び付かないまま Backlog に残る(V22)。
- 初回の PATCH が明確な 4xx(例: issue_key の誤り)で失敗すると、claim は attached のまま残る。issue_key を直した再試行は「claim と違う」の `argument_error` になり、その upload_id は使えない。そのため初回の 4xx のエラーは、コードと retryable を Backlog のままにして、文面に「ファイルは課題に添付されていない。この upload_id はもう使えないので、`logbutler_issue_attachment_upload_prepare` からやり直す」と足す(401 は包まずに投げ直す)。

## 再審議条件

- 実環境で条件付き put が原子的でない(V18)。
- 20 MiB が Workers のメモリ・`client.ts` の期限(30 秒)・Backlog の上限に収まらない(V19・V20)。上限を実測値で固定し直す。
- 消費済みの attachmentId での PATCH が二重に添付する(V21)。
- 結び付けなかった一時添付が Backlog に残り続ける(V22)。
- 発行数の乱用が観測された(レート制限を検討する)。
- claude.ai のサンドボックスなど、shell から Worker に届かないクライアントへの対応が必要になった。

## 未検証の前提

確認手順は [docs/manual-verification.md](../manual-verification.md) の V18〜V24。

1. 条件付き put(`If-None-Match: *` / `etagMatches`)の実環境での原子性(V18。miniflare では確認済み)。
2. 20 MiB の完了が Workers のメモリと `client.ts` の期限に収まるか(V19)。
3. Backlog の添付の上限(V20)。
4. 消費済みの attachmentId で PATCH したときの Backlog の応答(二重に添付されないか。V21)。
5. 課題に結び付けなかった一時添付が Backlog で消えるか(V22)。
6. R2 の有効化に支払い方法の登録が要るか(V23)。

## テスト

- unit: `test/unit/r2-conditional.test.ts`(条件付き put の原子性と etag)、`test/unit/uploads-put.test.ts`(PUT の 201 / 404 / 409 / 411 / 400 / 413 / サイズ不一致)、`test/unit/tools-attachment-upload-url.test.ts`(prepare と完了の全遷移)、`test/unit/mcp-api-handler.test.ts`(binding の有無)、`test/unit/render-wrangler-config.test.ts`(バケット名の差し替え・除去)。
- E2E: `test/e2e/attachment-upload-url.test.ts`(OAuth 済みの `/mcp` で prepare → PUT → 完了、binding の無い Worker)、`test/node-e2e/render-wrangler-config.test.ts`(生成と `wrangler deploy --dry-run` の両形)。
