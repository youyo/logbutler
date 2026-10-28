# 実機確認リスト

Logbutler はまだ実デプロイしていない。これまでの ADR と `docs/tool-diff-from-logvalet.md` に「未検証の前提」として書いたものを、ここに集約する。
ユーザーが検証用の環境を用意したら、この表の順に実施し、**結果の欄に記入する**(実施はユーザーの指示を受けてから)。
デプロイ手順は [docs/runbook.md](runbook.md)。

## 使い方

- 表記: `<domain>` は Logbutler の公開ドメイン、`<space>` は Backlog のスペース名、`BASE=https://<domain>`。
- **検証用の Backlog スペースとプロジェクトを使う**。書き込みを伴う項目(V08・V11)は、検証用プロジェクトでだけ行う。本番のスペースで試さない。
- トークン・クライアントシークレット・`.verify-oauth.local.json` の中身を、この表・Issue・チャットに**貼らない**。値の代わりに「一致 / 不一致」「あり / なし」を書く。
- 結果は `OK` / `NG` / `要対応` のどれかで記入し、`メモ` に日付・環境(例: `staging, 無料プラン`)・気づきを書く。NG は該当 ADR / tool-diff の「未検証の前提」を更新する。
- 実施前の準備: runbook の手順 0〜3(下流リポジトリ、Backlog アプリ、Cloudflare、Variables / Secrets とデプロイ)を終え、`curl -s $BASE/healthz` が `{"status":"ok"}` を返すこと。

## 実環境の OAuth 確認ツール `mise run verify:oauth`

V01(一部)・V03・V05・V06・P1〜P3 の確認に使う、テスト用の小さな MCP クライアント。使い方の詳細は [README](../README.md#実環境の-oauth-確認mise-run-verifyoauth)。

```sh
mise run verify:oauth -- $BASE/mcp                                     # フル検証(ブラウザで Backlog のログインと同意を 1 回する)
mise run verify:oauth -- "$BASE/mcp?toolsets=user&read_only=true"      # クエリつき
mise run verify:oauth -- $BASE/mcp --refresh-only                      # 保存済みの状態で更新だけ(Backlog のトークン期限切れ後に使う)
```

- 人が操作するのは、ブラウザでの Backlog のログインと同意の 1 回だけ。
- 終了コード 0 なら全段階が成功。各段階(`metadata` `register` `authorize` `token` `tools_list` `user_me` `refresh` `user_me_after_refresh`)の成否と、`expires_in`、リフレッシュでトークンが変わったかが出る。
- 状態ファイル `.verify-oauth.local.json` はリフレッシュトークンを含む。検証が終わったら削除する。
- このツールが見られるのは MCP 側のトークン(Logbutler 発行)。**Backlog 側のリフレッシュトークンの挙動は見えない**(V01 は別手順)。

---

## A. Backlog との OAuth(ADR 0001)

### V01 Backlog のリフレッシュトークンがローテーションするか

- 出典: [ADR 0001 の未検証 1](adr/0001-oauth-server-in-worker.md)
- 目的: 更新のたびに `refresh_token` が変わるか。実装は両対応だが、ローテーションする場合の並列更新の競合(`invalid_grant`)の起こりやすさを知る。
- 手順(Logbutler を通さず Backlog に直接。検証用のクライアント ID / シークレットを使う):
  1. ブラウザで `https://<space>.backlog.com/OAuth2AccessRequest.action?response_type=code&client_id=<クライアントID>&redirect_uri=https://<domain>/callback&state=x` を開き、ログイン・同意する。
     runbook 手順 1 で登録済みの Backlog の OAuth アプリ（リダイレクト URI `https://<domain>/callback`）を使う。認可コードは 1 回しか使えず有効期限も短いので、取得後すぐ手順 3 に使う。
  2. 移動先の `https://<domain>/callback?code=...&state=x` は Logbutler が拒否するが(state の cookie が無い)、アドレスバーの `code=` の値を控える(1 回しか使えない)。
  3. シェルで次を実行する(トークンは変数にだけ入れ、画面に出さない):
     ```sh
     read -rs CLIENT_SECRET; read -rs CODE   # 値を貼る(画面に出ない)
     T1=$(curl -s -X POST https://<space>.backlog.com/api/v2/oauth2/token \
       -d grant_type=authorization_code -d client_id=<クライアントID> -d client_secret=$CLIENT_SECRET \
       -d redirect_uri=https://<domain>/callback -d code=$CODE)
     R1=$(echo "$T1" | jq -r .refresh_token)
     echo "expires_in(最初): $(echo "$T1" | jq .expires_in)"
     T2=$(curl -s -X POST https://<space>.backlog.com/api/v2/oauth2/token \
       -d grant_type=refresh_token -d client_id=<クライアントID> -d client_secret=$CLIENT_SECRET -d refresh_token=$R1)
     echo "更新応答に refresh_token があるか: $(echo "$T2" | jq 'has("refresh_token")')"
     echo "ローテーションしたか: $([ "$(echo "$T2" | jq -r .refresh_token)" != "$R1" ] && echo はい || echo いいえ)"
     echo "expires_in(更新後): $(echo "$T2" | jq .expires_in)"
     T3=$(curl -s -X POST https://<space>.backlog.com/api/v2/oauth2/token \
       -d grant_type=refresh_token -d client_id=<クライアントID> -d client_secret=$CLIENT_SECRET -d refresh_token=$R1)
     echo "古いリフレッシュトークンで再更新できるか: $(echo "$T3" | jq 'has("access_token")')"
     unset CLIENT_SECRET CODE T1 T2 T3 R1
     ```
- 期待結果: 実装はどちらでも動く。ローテーションする(`いいえ`でなく`はい`)場合は、最後の行が `false`(古いものが失効)なら競合に弱いので、V02 を丁寧に確認する。
- 結果: ローテーション [ はい / いいえ ] ／ 古いトークンの再利用 [ 可 / 不可 ] ／ 判定 [ OK / NG / 要対応 ] ／ メモ:

### V02 KV の結果整合性がリフレッシュ直後のトークン利用に影響しないか

- 出典: [ADR 0001 の未検証 2](adr/0001-oauth-server-in-worker.md)
- 目的: リフレッシュ直後に別ロケーションの isolate が古い `props`(失効済みの Backlog リフレッシュトークン)を読んで `invalid_grant` にならないか。V01 でローテーションする場合に重要(しない場合は影響なし)。
- 手順:
  1. `mise run verify:oauth -- $BASE/mcp` を実行して成功させる(状態が保存される)。
  2. Backlog のアクセストークンが期限(`expires_in`、V03)に近づくまで待つ。MCP のトークン更新で Backlog も更新される条件は「Backlog の残り < 約 31 分」なので、**認可の約 30 分後〜期限前**に次を行う。
  3. `mise run verify:oauth -- $BASE/mcp --refresh-only` を、**間隔をあけずに 5 回以上連続で**、できれば別のネットワーク(スマートフォンのテザリングなど、別ロケーションに届く経路)からも実行する。
  4. 最初の更新から 2 分以内に、別経路から `--refresh-only` と `tools/call` を行う(KV の伝播が最大 60 秒ほどかかる想定)。
  5. `mise run verify:oauth -- https://<domain>/mcp --refresh-only` を同時に 3〜5 本起動する（例: シェルで各コマンドに `&` を付けて並列実行し、最後に `wait`）。
- 期待結果: すべて `user_me_after_refresh` が OK。`invalid_grant`(`authorize を再度` の案内)や 503 が出ない。出た場合は NG とし、発生の間隔・経路を記録する。並列実行（手順 5）: すべて成功する。V01 で Backlog のリフレッシュトークンがローテーションすると分かった場合、1 本以上が invalid_grant で失敗するなら ADR 0001 の未検証 1（並列更新の競合）が現実の問題になる。結果を記入し、失敗した場合は ADR 0001 に追記する。
- 結果: 連続 [ 回数 ] ／ 別経路 [ あり / なし ] ／ 並列 [ 本数 / 成功本数 ] ／ エラー [ なし / あり: ] ／ 判定 [ OK / NG / 要対応 ] ／ メモ:

### V03 Backlog のアクセストークンの実際の `expires_in`

- 出典: [ADR 0001 の未検証 3](adr/0001-oauth-server-in-worker.md)
- 目的: 約 1 時間と想定している Backlog の `expires_in` の実値。MCP のアクセストークンの寿命(30 分)の前提。
- 手順: V01 の手順 3 で出る `expires_in` を記録する。`verify:oauth` が出す `expires_in` は MCP 側(30 分以下)なので区別する。
- 期待結果: 3600 秒前後。MCP の 30 分より十分長い。短い(30 分以下)場合は `src/auth/token-exchange.ts` の `MCP_ACCESS_TOKEN_TTL_SECONDS` を見直す。
- 結果: Backlog `expires_in` = [ ] 秒 ／ MCP `expires_in` = [ ] 秒 ／ 判定 [ OK / NG ] ／ メモ:

### V04 Backlog の `redirect_uri` 検証と client_secret のフォーム送信

- 出典: [ADR 0001 の未検証 4](adr/0001-oauth-server-in-worker.md)
- 目的: Backlog が `redirect_uri=https://<domain>/callback` の完全一致を要求しても通ること、client_secret をフォームで送る方式が通ること。
- 手順: `verify:oauth` のフル検証で `authorize` と `token` 段階が OK になること(Logbutler が Backlog のコード交換をしている)。リダイレクト URI を末尾スラッシュ付きなどに変えた場合の失敗の仕方も 1 回試す(任意)。
- 期待結果: `token` 段階が OK。失敗するなら Backlog の返すエラーが Worker のログ(Workers Logs)に出る。
- 結果: 判定 [ OK / NG ] ／ メモ:

## B. MCP クライアントとの接続(ADR 0002 / 0008)

### V05 `verify:oauth` の全段階

- 出典: [ADR 0008](adr/0008-client-side-control-and-mcp-2026.md)(DCR の `application_type`、MCP 2026-07-28、`iss`)
- 目的: 実環境で DCR → PKCE → 認可(`state` と `iss` の検証)→ `/token` → MCP 2026-07-28 レーン → refresh が通ること。
- 手順: `mise run verify:oauth -- $BASE/mcp`。ブラウザで Backlog のログインと同意をする。
- 期待結果: 8 段階すべて OK、終了コード 0。ツール数は 74(`toolsets` なし)。`user_me` の `id` が自分の Backlog ユーザー ID。
- 結果: 判定 [ OK / NG ] ／ ツール数 [ ] ／ 失敗した段階 [ なし / ] ／ メモ:

### V06 各 MCP クライアントの DCR リクエストで登録に失敗しないこと

- 出典: [ADR 0008 の DCR の application_type](adr/0008-client-side-control-and-mcp-2026.md)
- 目的: Claude(claude.ai のカスタムコネクタ / Claude Code)、Cursor、Portal などが送る DCR で登録できること(`application_type` の有無、`redirect_uris` の形、`scope` の有無)。
- 手順: 使うクライアントごとに `$BASE/mcp` を追加して接続する。失敗したクライアントは、Workers Logs で `/register` の応答コードを見る。
- 期待結果: 登録でき、ブラウザで Backlog のログイン → 接続完了、ツール一覧が見える。
- 結果: クライアント別 [ 名前: OK/NG ] ／ メモ:

### V07 CIMD(Client ID Metadata Document)を有効にするか

- 出典: [ADR 0002 の未検証の前提](adr/0002-single-worker-auth-and-mcp.md)
- 目的: 使うクライアント / Portal が DCR ではなく CIMD で接続してくるか。CIMD は `global_fetch_strictly_public` フラグが必要で、現在は有効にしていない。
- 手順: V06 / P1〜P2 で、クライアントの `client_id` が URL(`https://...`)の形で `/authorize` に届くか、Workers Logs で確認する。DCR で接続できるなら CIMD は不要。
- 期待結果: すべて DCR で接続できる(CIMD 不要)。CIMD が必要なクライアントがあれば、有効化を別マイルストーンとして起票する。
- 結果: CIMD で来たクライアント [ なし / あり: ] ／ 判定 [ OK / 要対応 ] ／ メモ:

## C. Backlog API の挙動(tool-diff / ADR 0003 / 0004 / 0006)

### V08 `priorityId` を送らない `issue_create` が通るか

- 出典: [docs/tool-diff-from-logvalet.md](tool-diff-from-logvalet.md)(`issue_create` の `priority_id`)、[ADR 0005](adr/0005-idempotency-cache-on-kv.md)(冪等性)
- 目的: logvalet は未指定でも `priorityId=0` を送るが、Logbutler は未指定なら送らない。Backlog が省略を許すか(既定の「中」になるか、エラーか)。
- 手順(**検証用プロジェクト**で): 先に `logbutler_meta_issue_types` で `issue_type_id` を調べ、`logbutler_issue_create` を `project_key` / `summary` / `issue_type_id` だけで呼ぶ。続けて `priority_id` を `0` で呼ぶ。作った課題は検証後に Backlog 側で削除する。
- 期待結果: 省略で作成でき、優先度が既定(中)になる。エラーなら、そのメッセージを記録し tool-diff を更新する(必要なら既定の `priorityId` を補う)。
- 結果(2026-10-29): 省略 [ エラー: `HTTP 400, code=7: error.invalid : priorityId` ] ／ 0 を明示 [ 同エラー ] ／ 3 を明示 [ 作成できた(優先度: 中) ] ／ 判定 [ NG → 修正済み ] ／ メモ: 省略時は `GET /priorities` から既定値(id 3 があれば 3、なければ中央)を決めて送るよう修正(優先度 ID は公式に固定とは明記されていないので決め打ちしない)。明示値は 0 も含めそのまま送り、Backlog に検証を任せる。

### V09 未公開 API(`/issues/{key}/relatedIssues`)の実際の応答

- 出典: `src/analysis/issue-detail.ts`(`issue_context` の `include_related_issues`)、[ADR 0006](adr/0006-analysis-paging-and-call-budget.md)
- 目的: Backlog の公式 API ドキュメントにない(logvalet が使っている)エンドポイントが、実際に期待した形で返るか。
- 手順: 関連課題を持つ課題に対し `logbutler_issue_context`(`include_related_issues` 既定)を呼び、`related_issues` が埋まるか、`related_issues_fetch_failed` の warning が出ないかを見る。関連課題の無い課題でも呼ぶ。
- 期待結果: 関連あり: 一覧が返る。関連なし: 空配列。warning が出る場合は HTTP ステータスを記録し、tool-diff に反映する。
- 結果: 関連あり [ ] ／ 関連なし [ ] ／ warning [ なし / あり: ] ／ 判定 [ OK / NG ] ／ メモ:

### V10 20 MiB ダウンロードの workerd 上のメモリと時間

- 出典: [ADR 0004](adr/0004-tool-output-and-error-format.md)・[ADR 0007](adr/0007-response-size-limit.md)(`issue_attachment_download` / `shared_file_download` の上限 20 MiB)
- 目的: 上限ぎりぎりのファイルをダウンロードして base64 にしても、Worker のメモリ(128 MB)と実行時間に収まるか。
- 手順(検証用プロジェクト): 約 19 MiB の添付ファイルを課題に付け、`logbutler_issue_attachment_download` を呼ぶ。20 MiB 超のファイルでも呼ぶ。Workers Logs / ダッシュボードで CPU 時間とエラー(`Exceeded Memory` など)を確認する。
- 期待結果: 19 MiB は成功。20 MiB 超は `File is too large to download (limit 20 MiB)` の `api_error`。メモリ超過や CPU 時間超過が出ない。出る場合は上限を下げる(`MAX_DOWNLOAD_BYTES`)。
- 結果: 19 MiB [ 成功 / 失敗: ] ／ 所要時間 [ ] ／ 超過 [ 想定どおり / ] ／ 判定 [ OK / NG ] ／ メモ:

### V11 4 MiB アップロードの workerd 上のメモリと時間

- 出典: [docs/tool-diff-from-logvalet.md](tool-diff-from-logvalet.md)(`issue_attachment_upload` はインライン base64 のみ、上限 4 MiB)
- 目的: base64 の入力(約 5.3 MB の文字列)をデコードして Backlog に multipart で送る処理が、メモリと時間に収まるか。
- 手順(検証用プロジェクト): 約 3.9 MiB のファイルを base64 にして `logbutler_issue_attachment_upload`(`file_name` + `file_content_base64`)で課題に添付する。4 MiB 超でも試す。
- 期待結果: 3.9 MiB は成功し、課題に添付される。4 MiB 超は `argument_error`。メモリ・時間の超過が出ない。
- 結果: 3.9 MiB [ 成功 / 失敗: ] ／ 超過 [ 想定どおり / ] ／ 判定 [ OK / NG ] ／ メモ:

### V12 Backlog の 429 の実際の `Retry-After`

- 出典: [ADR 0003](adr/0003-backlog-client-serialization-and-retry.md)
- 目的: Backlog が返す 429 の `Retry-After` の形式(秒か日時か)と、リトライの待ち時間(上限 10 秒)の妥当性。
- 手順: レート制限(約 1 分 600 回)に当てるのは避ける。当てた場合のみ記録する。偶然 429 が出たら Workers Logs で `Retry-After` の値を確認する。意図して試す場合は検証用スペースで、`issue_list` を短時間に繰り返す。
- 期待結果: `Retry-After` が秒数。長すぎる場合(10 秒超)は `rate_limited`(retryable)がそのまま返る。
- 結果: `Retry-After` の実値 [ 未観測 / ] ／ 判定 [ OK / 未観測 ] ／ メモ:

### V13 有料プランの subrequest 上限と分析系の `maxApiCalls`

- 出典: [ADR 0006 の帰結](adr/0006-analysis-paging-and-call-budget.md)、[ADR 0003](adr/0003-backlog-client-serialization-and-retry.md)
- 目的: 分析ツールは 1 回で最大 105 回の Backlog 呼び出しをする(`project_blockers` + `include_comments`)。Workers の subrequest 上限(無料プランは 50。有料プランはそれより大きい。実際の値は Cloudflare のドキュメントで確認する)で動くこと。
- 手順: **有料プランの Worker**で、`logbutler_issue_stale`(最悪 55 回)と `logbutler_project_health` を課題の多い検証用プロジェクト(100 件以上)に対して呼ぶ。無料プランの場合は、同じ呼び出しが `Too many subrequests` で失敗することを確認し、分析ツールを無効にするクエリ(`toolsets` から `analysis` を除く)を案内する。
- 期待結果: 有料プランで成功。無料プランでは 50 超のツールが失敗する(想定どおり)。
- 結果: プラン [ 有料 / 無料 ] ／ `issue_stale` [ 成功 / 失敗: ] ／ 判定 [ OK / NG ] ／ メモ:

### V14 読み取りツールが実 Backlog に対して動くこと(ロードマップの元の M07 完了条件)

- 出典: `plans/logbutler-roadmap.md` の M07
- 目的: 代表的な読み取りツールが、実 Backlog に対して OAuth 経由で動く。
- 手順: クライアント(Portal 経由でもよい)から次を呼ぶ: `logbutler_user_me`、`logbutler_project_list`、`logbutler_issue_list`、`logbutler_issue_get`、`logbutler_wiki_list`、`logbutler_my_tasks`、`logbutler_digest_daily`、`logbutler_search`。`?toolsets=...&read_only=true` の接続でも `tools/list` を確認する。
- 期待結果: いずれも `isError` でなく、Backlog の生データ(camelCase)または加工済みデータ(snake_case)が返る。`read_only=true` では書き込み系(`issue_create` など)が一覧に出ない。
- 結果: 呼んだツール [ ] ／ 失敗 [ なし / ] ／ 判定 [ OK / NG ] ／ メモ:

## D. 運用(ADR 0009 / 0010)

### V15 設定チェックとログにトークンが出ないこと

- 出典: [ADR 0010](adr/0010-startup-config-check.md)、CLAUDE.md の「トークンは grant の props にだけ置く」
- 手順:
  1. デプロイ直後に `curl -s -o /dev/null -w '%{http_code}\n' $BASE/healthz` と本文を確認する(secrets 投入前なら `503` と欠けた項目名、投入後は `200`)。
  2. V05 / V14 を実施したあと、Workers Logs(ダッシュボードまたは `mise run deploy:render` のあと `wrangler tail <Worker 名>`)で、`access_token` `refresh_token` `Bearer ` `client_secret` の文字列を検索する。
- 期待結果: 1 は設定どおりの応答。2 はヒット 0 件(トークンやシークレットの値がログに出ない)。
- 結果: healthz [ 503→200 / 200 ] ／ ログ検索 [ 0 件 / あり: ] ／ 判定 [ OK / NG ] ／ メモ:

### V16 匿名の `/register` への対策(WAF / Rate Limiting)

- 出典: [ADR 0009](adr/0009-remove-cloudflare-access.md)
- 目的: Logbutler は DCR にレート制限を持たない。前段の Cloudflare で必要な制限を掛けたか(掛けない判断でもよい)。
- 手順: `/register` への Rate Limiting ルールの有無を確認する。掛ける場合は、通常のクライアント登録(数回 / 日)が通る値にする。
- 期待結果: 判断が記録されている。
- 結果: 対策 [ なし(理由: )/ あり: ] ／ 判定 [ OK / 要対応 ] ／ メモ:

---

## E. Portal を使う場合

Logbutler の前段に Cloudflare MCP Server Portals を置く場合だけ実施する。Portal・Access の設定手順は Logbutler の範囲外(runbook に注意点だけある)。
参照: [MCP Server Portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)、[Access の Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)。

### P1 Portal に「OAuth(DCR 自動登録)+ Require user auth」で登録でき、ツールが同期されること

- 出典: 計画書 M07 の (a)、[ADR 0002](adr/0002-single-worker-auth-and-mcp.md)
- 手順: Portal の管理画面で、サーバー URL `https://<domain>/mcp` を、認証方式 **OAuth**(クライアントは DCR で自動登録)、**Require user auth** を有効にして登録する。登録後、ツールの同期(一覧の取得)を実行する。
- 期待結果: 登録が通り、ツールが同期される(`toolsets` なしで 74 個)。同期にユーザーの認可が要る場合は、その操作が P2 の手順になる。
- 結果: 登録 [ OK / NG ] ／ 同期されたツール数 [ ] ／ メモ:

### P2 各ユーザーが Portal の Connect から自分の Backlog アカウントで認可できること

- 出典: 計画書 M07 の (b)、[ADR 0008](adr/0008-client-side-control-and-mcp-2026.md)(DCR)
- 手順: 別々の 2 人のユーザー(または 2 つの Backlog アカウント)が、Portal の Connect から認可する。Workers Logs で `/register` のリクエストを見て、DCR の `redirect_uris` に Portal のコールバック `https://<portal-host>/servers-callback` が入っていること、`application_type` や `scope` の有無を記録する。各ユーザーで `logbutler_user_me` を呼ぶ。
- 期待結果: 各ユーザーが自分の Backlog アカウントでログイン・同意でき、`user_me` が**それぞれ自分の** Backlog ユーザーを返す(他人の情報にならない)。DCR は 201 で成功する。
- 結果: DCR の `redirect_uris` [ ] ／ `application_type` [ なし / ] ／ `scope` [ なし / ] ／ 1 人目の `user_me.id` [ ] ／ 2 人目 [ ] ／ 判定 [ OK / NG ] ／ メモ:

### P3 Portal がクエリ付き URL(`?toolsets=...&read_only=true`)を保持するか

- 出典: 計画書 M07 の (c)、[ADR 0008](adr/0008-client-side-control-and-mcp-2026.md)(OAuth の resource とクエリ付き URL)
- 手順: Portal に `https://<domain>/mcp?toolsets=user&read_only=true` を登録して接続し、ツール一覧を見る。Workers Logs で、Portal からの `/mcp` リクエストの URL にクエリが付いているか、`resource` パラメータ(`/authorize` と `/token`)が正規 URL(クエリなし)で届いているかを確認する。
- 期待結果: ツールが `user` の 3 個だけになる(クエリが保持されている)。認可・トークン取得も通る。
- クエリが落ちる場合の代替案: toolset 別のパス(`/mcp/issue` など。resource 識別子が増えるため ADR 0008 では不採用)。判断を起票する。
- 結果: クエリ保持 [ はい / いいえ ] ／ 一覧のツール数 [ ] ／ `resource` [ ] ／ メモ:

### P4 Portal のクエリ(`optimize_context`、`codemode`)と Logbutler のクエリが衝突しないこと

- 出典: 計画書 M07 の (d)、[ADR 0008](adr/0008-client-side-control-and-mcp-2026.md)(関係のないクエリは無視、綴り違いは 400)
- 手順: Portal 側で `optimize_context` / `codemode` を有効にした接続をつくり、Logbutler 宛の `/mcp` リクエストに付くクエリを確認する。さらに `$BASE/mcp?toolsets=user&optimize_context=true&codemode=true` を `verify:oauth` で叩く。
- 期待結果: 無関係なクエリは無視され、`toolsets` の絞り込みは効く。400 `invalid_query` にならない。
- 結果: Portal が付けるクエリ [ ] ／ `verify:oauth` [ OK / NG ] ／ メモ:

### P5 Access の Managed OAuth を有効にしていないこと

- 出典: 計画書 M07 の (e)、[ADR 0009](adr/0009-remove-cloudflare-access.md)(公式ドキュメントが「自前の OAuth を持つサーバーには使わない」と明記)
- 手順: Logbutler を保護する Access アプリ(あれば)の設定で Managed OAuth が**無効**であることを確認する。
- 期待結果: 無効。有効だと Logbutler 自身の OAuth(DCR / `/authorize` / `/token`)と二重になり、接続が壊れうる。
- 結果: Managed OAuth [ 無効 / 有効(要修正)] ／ メモ:

---

## 名前の長さ上限(実測)

Backlog の公式 docs に記載がない上限を、2026-10-29 に実 Backlog で 1 文字ずつ確認した値。超えると `HTTP 400 code=7 error.maxLength : name`。

| 対象 | 上限(文字) |
|---|---|
| カテゴリー名 | 40 |
| バージョン/マイルストーン名 | 40 |
| 状態名 | 20 |

Logbutler 本体(src)は長さを検証せず、Backlog の応答(`api_error` として返る)に任せる(上限が docs になく変わりうるため。ADR 0013)。`test/live/` の作成物の名前は `NAME_MARK`(`lv` + HHMMSS)で上限内に収めている(`test/live/helpers/live.ts` の `NAME_LIMITS`、`test/node/live-names.test.ts`)。

## 一覧(ADR との対応)

| 項目 | 内容 | 出典 |
|---|---|---|
| V01 | Backlog のリフレッシュトークンのローテーション | ADR 0001 |
| V02 | KV の結果整合性とリフレッシュ直後のトークン利用 | ADR 0001 |
| V03 | Backlog の `expires_in` | ADR 0001 |
| V04 | Backlog の `redirect_uri` 検証・client_secret のフォーム送信 | ADR 0001 |
| V05 | `verify:oauth` の全段階 | ADR 0008 |
| V06 | 各 MCP クライアントの DCR | ADR 0008 |
| V07 | CIMD | ADR 0002 |
| V08 | `priorityId` を送らない `issue_create` | tool-diff / ADR 0005 |
| V09 | 未公開 API `relatedIssues` | tool-diff / ADR 0006 |
| V10 | 20 MiB ダウンロード | ADR 0004 / 0007 |
| V11 | 4 MiB アップロード | tool-diff |
| V12 | 429 の `Retry-After` | ADR 0003 |
| V13 | subrequest 上限・有料プラン | ADR 0006 / 0003 |
| V14 | 読み取りツールが実 Backlog で動く | ロードマップ M07 |
| V15 | 設定チェック・ログにトークンが出ない | ADR 0010 |
| V16 | 匿名 `/register` への対策 | ADR 0009 |
| P1〜P5 | Portal を使う場合の (a)〜(e) | ADR 0002 / 0008 / 0009 |
