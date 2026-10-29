# ADR 0015: 親子課題の 3 階層目(孫課題)に対応する

- 状態: 採用(2026-10-29。ユーザーと合意)
- 関連: ADR 0003(直列・ページ数の上限)、ADR 0004(エラー形式)、ADR 0006(`maxApiCalls`)、ADR 0007(応答サイズ)、`src/backlog/errors.ts`、`src/mcp/tools/issue-write.ts`、`src/mcp/tools/issue.ts`

## 背景

Backlog のプロジェクト設定「親子課題に 3 階層目を使用する」は、プランによって使える・使えないが分かれる。有効・無効のどちらでも Logbutler が正しく振る舞い、利用者(AI)が原因を自分で直せる必要がある。次の 3 つの問題があった。

1. 親子関係の制約違反が `Backlog API error (HTTP 400, code=7): err.editIssue.parentChildIssue.N` のまま返り、意味が分からない。
2. `issue_update` に `engagement` を指定して `parent_issue_id` を省略すると、親を案件の親課題(「[案件] 名前」)に付け替える。孫課題だと 2 階層目に引き上げられ、途中の課題との関係が切れる。案件の親課題自身に指定すると、自分自身を親にして失敗する。
3. `issue_list` の `parent_issue_ids` は直下の子しか返さない。孫までまとめて取る手段がない。

## 実機で確かめた Backlog の挙動(2026-10-29、テスト用プロジェクト LOGBUTLER)

- `GET /projects/:key` の応答に `grandchildIssueEnabled: true|false` がある(`subtaskingEnabled` とは別)。`logbutler_project_get` は生データを返すので、すでに見える。
- 有効のとき: 孫課題は作れる。4 階層目になる操作(作成も付け替えも)は HTTP 400・code=7・`err.editIssue.parentChildIssue.6`。子と孫を持つ課題を別の課題の下へ付け替えると、孫もそのまま付いてくる(サブツリーごと移動)。
- 無効のとき: 子課題を親に指定すると `.3`(作成・更新とも)。子を持つ課題を誰かの子にすると `.5`。既存の孫課題は残り、編集もできる(無効にしても消えない)。
- 共通: 課題自身を親に指定すると `.1`。`GET /issues?parentIssueId[]=X` は直下の子だけを返し、孫は含まない。
- 2 / 4 などほかの番号の意味は未確認。

## 決定

### 1. 親子関係のエラーは argument_error にする

`BacklogApiError`(`src/backlog/errors.ts`)のコンストラクタで、HTTP 400・Backlog の code 7・message が `err.editIssue.parentChildIssue.<N>` に完全一致するものを、`argument_error`(`retryable: false`)にして message を差し替える。

- **場所**: `issue_create` / `issue_update` の個別の catch ではなく、BacklogApiError の生成点にした。エラーの code と message はこのクラスで一括して決めており(`errorCodeForStatus` / `describe`)、親子関係を扱う書き込みはほかにも増えうる(将来のツール、`issue_update` 以外の経路)。完全一致で絞っているので、無関係な 400 を巻き込まない。`backlogCode` / `backlogMessage` は元のまま残るので、`isNoChangeUpdate` など既存の判定は影響を受けない。
- **言語**: 日本語。この種のドメイン固有の検証メッセージ(`resolveEngagement` の「案件 ... は規約にありません」、`priority_id を指定してください`)に合わせた。引数の形式エラーは英語だが、利用者が何をすべきかを日本語の運用規約の語彙で伝える方を優先した。
- **内容**: 理由 + (3 / 5 / 6 は)`logbutler_project_get` の `grandchildIssueEnabled` で設定を確認できるという手がかり + 元のキー。

| N | 理由 |
|---|---|
| 1 | 自分自身を親課題にはできない |
| 3 | 3 階層目が無効なプロジェクトでは、子課題を親課題にできない |
| 5 | 3 階層目が無効なプロジェクトでは、子を持つ課題を子課題にできない |
| 6 | 親子課題は 3 階層まで(4 階層目になる) |
| その他 | 「親子関係の制約に違反しました」と元のキー |

トークンなどの秘密は message に入らない(Backlog の message は元から伏せ済みで、キー文字列だけを使う)。

### 2. `issue_update` の `engagement` は、祖先に案件の親課題がいれば親を変えない

`engagement` を指定して `parent_issue_id` を省略し、案件の親課題があるとき、対象の課題を `GET /issues/:key` し、次で分岐する。

- 対象が案件の親課題そのもの → 親を設定しない(カテゴリだけ設定する)。
- 親が案件の親課題 → 親を変えない。
- 親の親が案件の親課題(孫課題) → 親を変えない。親を `GET` して確かめる。階層は最大 3 なので、祖先は 2 段までで足りる。
- それ以外 → 従来どおり案件の親課題を親にする。

明示した `parent_issue_id` が優先なのは従来どおりで、そのときは祖先を調べない。`issue_create` は新しい課題に子孫がいないので変えない。対象の課題の GET は、課題キー(数値 ID のとき)の解決と共有して 1 回だけにする。呼び出しは直列(ADR 0003)。

`maxApiCalls` は **27** = 対象の課題 1 + 案件の解決 23(GetProject 1 + 規約(課題種別 1 + 10 ページ)+ カテゴリ 1 + 案件の親課題 10 ページ。`issue_create` の 25 から優先度 1 と POST 1 を除いたもの)+ 親の課題 1 + PATCH 1 + 変更なしの読み戻し 1。従来は既定の 50 だった。

### 3. `issue_list` に `include_descendants` を足す

引数 `include_descendants`(真偽値、既定 false)。`parent_issue_ids` と一緒に使う。`parent_issue_ids` がないのに true なら `argument_error`(Backlog を呼ぶ前)。

1. 子の ID を `parentIssueId[]=親…`(作成順の昇順)で `fetchByOffset` により直列に集める。利用者のフィルタ・count・offset・sort はここには付けない。
2. 最後に `parentIssueId[]=親 ∪ 子` に、利用者のフィルタ・count・offset・sort をそのまま付けて **1 回だけ** 呼ぶ。

フィルタとページングは Backlog が子と孫に一様にかける。子がフィルタで落ちても、その孫は返る。3 階層目が無効でも既存の孫課題が残りうるので、設定を見ずに子孫を返す(`grandchildIssueEnabled` を読む API 呼び出しも省ける)。

**上限と超過時の扱い**: `parentIssueId[]` に載せる ID(親 + 子)は **200 個まで**。1 個は約 30 文字(`parentIssueId%5B%5D=` + 8〜9 桁 + `&`)で、200 個で約 6KB。Cloudflare や Backlog 側の URL 長の上限(8KB 前後を想定)に収まる余裕を残した。親だけで 200 を超えれば Backlog を呼ぶ前に、子を集めて 200 を超えたらその時点で、`argument_error`(`parent_issue_ids` を減らすよう案内)にする。

出力は生の課題配列で警告を載せる場所がない(ADR 0004)。黙って切り詰めると、一部の孫が抜けたまま「全部」と誤解されるので、切り詰めずにエラーにした(ADR 0007 の `response_too_large` と同じ方針)。子の収集は 200 − 親の数 + 1 件までで止まるので、最大 2 ページ。

`maxApiCalls` は **52** = 従来の既定 50(プロジェクト・担当者・状態の解決と最後の一覧)+ 子の収集 2 ページ。

### 4. 実環境 E2E

`test/live/suites/issue.ts` の「課題: 親子課題」で、最初に `logbutler_project_get` の `grandchildIssueEnabled` を読んで分岐する(skip しない)。有効: 孫課題を作れる・4 階層目は `argument_error`・`include_descendants` で孫まで返る。無効: 孫課題の作成が `argument_error`・`include_descendants` が子を返す。設定値を書き換える API は呼ばない。

## 却下した案

- **孫の ID も `parentIssueId[]=` で再帰して集める(子孫を全部たどる)**: 階層は最大 3 なので不要。呼び出しが増える。
- **子と孫を別々に取ってサーバー側で結合・ソート・ページング**: 利用者のフィルタ・sort・count・offset を自前で再現することになり、Backlog とずれる。「親 ∪ 子」の 1 回の呼び出しなら Backlog に任せられる。
- **子の数が上限を超えたら先頭だけ返し、警告を付ける**: 出力が生の配列で警告を置けない。出力の形を変えると logvalet との互換が崩れる。
- **孫の可否を `grandchildIssueEnabled` で分岐する**: 無効でも既存の孫が残るため、設定を見ると取りこぼす。
- **変換を `issue_create` / `issue_update` の catch に置く**: 今後ほかの書き込み経路で同じ 400 が出ても変換されない。完全一致で絞れるので、生成点に置いても誤変換しない。
- **親の付け替えを常に行い、孫もサブツリーごと移動させる**: 付け替えると孫が 2 階層目に引き上がり、途中の課題との関係が切れる。案件の親課題自身では `.1` で失敗する。どちらも意図した結果ではない。

## 未検証の前提

- 親子関係のエラーの番号 2・4 などの意味(未知は一般的な文と元のキーで返す)。
- URL 長 6KB が Backlog 側で通ること(200 ID の実測は未実施。実環境 E2E では少数のみ)。
