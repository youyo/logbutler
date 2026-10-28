# ADR 0006: 分析ツールのページングと API 呼び出しの予算

- 状態: 採用(M05A)。M05B で digest 系 6 個と user_activity を追加
- 日付: 2026-10-28(全件ページング・until の当日を含める・完了集合は、ロードマップ「決定済み事項」のユーザー決定)

## 背景

logvalet の分析系は、課題一覧を `count` なしで 1 回呼ぶ(Backlog 既定の 20 件)だけで分析していた。20 件を超えるプロジェクトでは
stale / blockers / workload / health / triage の結果が、黙って一部の課題だけのものになる。`project_health` は同じ一覧を 4 回取得し、
errgroup / WaitGroup で並列に呼んでいた(ADR 0003 の「直列」に反する)。`blockers` の `include_comments` は課題 1 件ごとに 1 回呼び、
上限がなかった。コメントとアクティビティも同様に 1 ページ(または上限なし)だった。

## 決定

### ページング

- 課題一覧は offset(`fetchByOffset`)、コメントとアクティビティは `maxId` のカーソル(`fetchByCursor`。`/comments` と
  アクティビティ API に `offset` はない)で、**直列に**全件取る。1 ページ 100 件、**10 ページ(= 1,000 件)が上限**(ADR 0003)。
- 上限で止めたら、ツールの出力 `analysis` の最上位に **`truncated: true`** を載せ(取り切れたときも `false` を省略しない。ADR 0004)、
  warning を足す。code は `issues_truncated` / `comments_truncated` / `activities_truncated` / `overdue_truncated` /
  `upcoming_truncated` / `watching_truncated` / `activity_pagination_truncated` / `comment_check_truncated`。`retryable` は false。
- 100 件ちょうどのページが続く場合も次のページを取る(`batch.length < count` で終わりを判定。カーソルが 0 以下になっても終わり)。
- 期間で絞れるもの(コメント・アクティビティは新しい順)は、期間より古いものに届いた時点でページングをやめる。

### 部分失敗は warning

logvalet と同じく、必須でない取得の失敗(プロジェクト、課題一覧、コメント、ステータス、関連課題、ウォッチ、アクティビティ、規約)は
`warnings[]` に `{code, message, component, retryable}` で入れ、取れた分を返す。必須の取得(`issue_context` などの GetIssue、
`my_tasks` の GetMyself、digest の GetProject)の失敗はツールエラー(ADR 0004)。

- `retryable` は logvalet が常に true だったが、Backlog のエラーに従う(404 を再試行可能と言わない)。
- **401 は warning にせず投げ直す**(トークン更新の合図。`api-handler.ts` が HTTP 401 にする)。Backlog 以外の例外(バグ)も握りつぶさない。

### 呼び出し数の上限(`maxApiCalls`)

`defineTool` に `maxApiCalls` を足した。`registerTools` が `getClient({ maxApiCalls })` でクライアントに渡す(宣言がなければ既定の 50)。
値は `src/analysis/budget.ts` の `API_BUDGET` に式で書き、テストが「宣言した値」と「最悪ケースの実測(モックで全ページ満杯を返す)」を固定する。

定数: `PAGES` = 10(ページ数の上限)、`P` = `MAX_PROJECT_KEYS` = 5、`K` = `COMMENT_LOOKUP_BUDGET` = 50。

| ツール | 最悪ケースの式 | maxApiCalls | 固定するテスト |
|---|---|---|---|
| `issue_stale` | P × (GetProject 1 + 課題 PAGES) = 5 × 11 | 55 | unit `tools-analysis-stale.test.ts:215,219` / e2e `analysis-tools.test.ts:130` |
| `project_blockers` | P × (1 + PAGES) + K(コメント確認) = 55 + 50 | 105 | `tools-analysis-blockers.test.ts:317,321` |
| `user_workload` | 1 + PAGES | 11 | `tools-analysis-workload.test.ts:150,153` |
| `project_health` | (1 + PAGES) + 規約(課題種別 1 + 規約課題 PAGES) + K = 11 + 11 + 50 | 72 | `tools-analysis-health.test.ts:308,312` |
| `issue_context` | GetIssue 1 + コメント PAGES + ステータス 1 + 関連課題 1 | 13 | `tools-analysis-context.test.ts:225,228` |
| `issue_triage_materials` | GetIssue 1 + (1 + PAGES) + コメント PAGES + 関連課題 1 | 23 | `tools-analysis-triage.test.ts:226,229` |
| `my_tasks` | GetMyself 1 + プロジェクト一覧 1 + 状態一覧 S(= `MAX_STATUS_PROJECTS` = 20)+ overdue PAGES + upcoming PAGES + watching PAGES = 1 + 1 + 20 + 30(ADR 0012) | 52 | `tools-analysis-my-tasks.test.ts`(`maxApiCalls は 52` と上限まで続く最悪ケース) |
| `digest_daily` / `digest_weekly` | GetProject 1 + 課題 PAGES | 11 | `tools-analysis-digest-periodic.test.ts:246,250` |
| `issue_timeline` | GetIssue 1 + コメント PAGES + アクティビティ `max_activity_pages`(≤ 10) | 21 | `tools-analysis-timeline.test.ts:320,323` |
| `activity_stats` | (scope=user の "me": GetMyself 1) + アクティビティ PAGES | 11 | `tools-analysis-activity-stats.test.ts:150,153,171` |

#### M05B: digest 系 6 個 + user_activity

追加の定数: `U` = `UNIFIED_MAX_USERS` = 10、`T` = `UNIFIED_MAX_TEAMS` = 3、`K` = `UNIFIED_MAX_ISSUE_KEYS` = 20、
`A` = `UNIFIED_ACTIVITY_PAGES` = 5(`digest_unified` で 1 ソースあたりのアクティビティのページ数)、
`W` = `MAX_SEARCH_WIKI_PROJECTS` = 10(`search` の Wiki 検索の対象プロジェクト数)。

| ツール | 最悪ケースの式 | maxApiCalls | 固定するテスト |
|---|---|---|---|
| `space_digest` | GetSpace 1 + GetSpaceDiskUsage 1 | 2 | unit `tools-digest-document.test.ts:40,95` |
| `document_digest` | GetDocument 1 + ListProjects 1 + 添付 1 | 3 | `tools-digest-document.test.ts:130,237` |
| `document_search` | project_keys: GetProject P + 検索 1(URL 用の ListProjects は呼ばない)。キーなし: 検索 1 + ListProjects 1 = 2 | 6 | `tools-digest-document.test.ts:469,483` |
| `search` | キーあり: GetProject P + 課題 1 + ドキュメント 1 + Wiki P = 12。キーなし: ListProjects 1 + 課題 1 + ドキュメント 1 + Wiki W = 13 | 13 | `tools-digest-search.test.ts:310,370,385` / e2e `digest-tools.test.ts:306` |
| `activity_digest` | アクティビティ 1(`limit` ≤ 100 の 1 ページ) | 1 | `tools-digest-activity.test.ts:53,223` |
| `user_activity` | ("me": GetMyself 1) + アクティビティ PAGES(10) | 11 | `tools-digest-activity.test.ts:414,426` / e2e `digest-tools.test.ts:379` |
| `digest_unified` | GetTeam T + GetProject P + GetUser U + max(課題 PAGES, GetIssue K) + max(U, P) × A = 3 + 5 + 10 + 20 + 10 × 5 | 88 | `tools-digest-unified.test.ts:452,488` |

`digest_unified` の最悪ケース(88)は、チーム 3・プロジェクト 5・ユーザー 10(チームのメンバーに含まれない ID)・課題キー 20 を
すべて指定し、ユーザーごとのアクティビティが 5 ページ満杯で続く場合。テストはちょうど 88 回で終わることを確かめる。
logvalet は同じツールが最悪 2,000 回超(課題 10,000 件のページング + 並列のアクティビティ)だった。

M05B の上限で止まったときの扱い:

- **`truncated`**: ページングで集める `search`(Wiki のプロジェクト数の上限)、`user_activity`、`digest_unified` は、`digest` の最上位に
  `truncated` を常に出す(ADR 0004)。`activity_digest` は 1 回の取得だが `limit` 件ちょうど取れて期間の端(`since`)に届いていないとき
  `truncated: true`(警告は出さない。`limit` は呼び出し側の指定)。単純な取得のツール(`space_digest` `document_digest`
  `document_search`)は `truncated` を持たない。
- **warning の code**: `wiki_search_truncated`(search)、`activities_truncated`(user_activity / digest_unified)、
  `issues_truncated`・`users_truncated`・`projects_truncated`(digest_unified)。`retryable` は false。
  チームが引けたがメンバー 0 人のときも空の結果を返し、理由を `team_has_no_members`(digest_unified)で伝える。
- **絞り込みを失わない**: `search` の `project_keys` が全部引けない、`digest_unified` の `project_keys` / `user_ids` `team_ids` が
  全部引けないときは、残りの条件だけで範囲が広がる(スペース全体、プロジェクト全員)のを避けて、空の結果と warning を返す。
  一部だけ引けた場合は、引けた分で進めて warning を出す。
- **`user_activity` の `limit`**: logvalet と同じく期間(`since` / `until`)がないときだけ使う。期間があれば期間内を
  PAGES(10 ページ = 1,000 件)まで全部取り、超えたら `activities_truncated`。

上に届いたら `BacklogCallLimitError`(`api_error`、retryable でない)で止まるが、上の式はページ上限で先に止まる値なので、
通常は `truncated` + warning になり、エラーにはならない(テストが「ちょうど式の回数で終わる」ことを確認)。
式の PAGES を超えるのは、リトライ(429)を含むときだけ。リトライが重なると上限に達してエラーになりうる。それは受け入れる。

### 上限を閉じた式にするための制限(logvalet にはない)

- **`project_keys` は 5 個まで**(`issue_stale` `project_blockers`)。logvalet は無制限だったが、プロジェクト数に比例して呼び出しが増え、
  上限が式で書けなくなる。重複は 1 つにまとめる。6 個以上は `argument_error`(Backlog を呼ばない)。
- **`include_comments`(blocked_by_keyword)のコメント確認は 1 回の呼び出しで 50 件まで**。logvalet は課題 1 件につき 1 回(最大
  1,000 回)だった。確認の対象は完了集合を除いた課題を issue_key 昇順に並べた先頭 50 件で、超過分は確認せず
  `comment_check_truncated` の warning と `truncated: true` を出す(AI が検出漏れの可能性を知れる)。取得は `count=1&order=desc`
  (使うのは最新コメントだけ)。確認の失敗は握りつぶさず、`comments_fetch_failed` を 1 件にまとめる(logvalet は黙って無視していた)。
- **`max_activity_pages`(timeline)は 1〜10**。0 以下は既定の 5。11 以上は `argument_error`。
- **M05B**: `search` / `document_search` の `project_keys` は 5 個まで(P)、`search` の Wiki 検索は先頭 10 プロジェクトまで(W)。
  `digest_unified` の `project_keys` 5 個・`team_ids` 3 個・`user_ids` 10 個・`issue_keys` 20 個、チーム展開後のユーザーも 10 人まで
  (超えた分は `users_truncated`)。アクティビティは 1 ソースあたり 5 ページ(500 件)まで。超過の入力は `argument_error`(Backlog を呼ばない)。
  チームのメンバーに含まれるユーザーの名前はチームの応答から取り、GetUser を省く。
- この 2 つの数(5 と 50)は判断で決めた。変えるときは `src/analysis/budget.ts` の定数と、上の表・テストを合わせて変える。

### アクティビティの期間つき取得(`src/analysis/activity-range.ts`)

`user_activity` と `digest_unified` が共有する。新しい順に `maxId` のカーソル(直前のページの最小 id - 1)で遡り、`since` より古い
ものに届いたら止め、`until` より新しいものは取得後に除く。logvalet の `FetchActivitiesWithDateFilter` は取得関数が `maxId` を
受け取らず、同じページを繰り返し取得した(100 件ちょうどのページが続くと、`until` 指定で新しい活動ばかりのとき止まらない)。
ここではカーソルを必ず進め、ページ数に上限を付ける。`activity_stats` は同じ考え方で先に実装済み(M05A)。

### `project_health` は課題一覧を 1 回だけ取る

GetProject と課題一覧(ページング)を 1 回だけ行い、stale / blockers / workload / ambiguity で共有する(logvalet は 4 回)。純粋関数
(`buildStale` `buildBlockers` `buildWorkload` `detectAmbiguities`)に同じ配列を渡す。規約の読み込みは M04 の `loadProjectConventions`
(GetProject はキャッシュ済み)で、規約課題は種別で絞ってページングする。規約の失敗(YAML 不正など)は致命にせず
`ambiguity_detect_failed` の warning にして曖昧さを空にする。課題取得の失敗は score 0 / critical + warning 1 件(logvalet は 3 重)。

### 日付と時刻

- 時刻はすべて `ToolContext.now`。`generated_at` は `now().toISOString()`(UTC、ミリ秒つき)。
- 日付(`since` `until` `today` の暦日、`by_date` `by_hour` `peak_day_of_week` の集計)はツール引数 `timezone`(省略時 `Asia/Tokyo`)。
  `since` は当日 00:00、**`until` は当日 23:59:59.999**(当日を含める)。`since` / `until` 省略時は `now - N日` / `now`。
- 出力の範囲(`date_range` `since` `until`)はオフセットつきの RFC 3339(例 `2026-10-26T00:00:00+09:00`)。Backlog から来た時刻
  (`updated` `dueDate` など)は元の文字列のまま返す。
- 経過日数は 0 方向への切り捨て(Go の `int(d.Hours()/24)`)。期限超過は `dueDate < now` の瞬間比較(logvalet と同じ。Backlog の
  `dueDate` は日付の 00:00Z なので、期限日の当日の UTC 0 時を過ぎると超過になる。変えていない)。
- `my_tasks` の `overdue` は「昨日まで」で、`upcoming`(週の月〜日、または今日〜営業日 4〜6 日先)と期間が重なる。
  重なった課題は **overdue にだけ**出す(logvalet は両方に出していた)。

### 完了集合

`{完了, 対応済み, Closed, Done, Resolved}`(`src/analysis/statuses.ts`)。stale / blockers / workload / health で既定の除外、
triage の `avg_close_days`、digest の completed 判定に使う。`exclude_status` を渡したツールはそれだけを使い、既定は足さない。
`project_health` の曖昧さ検出は logvalet どおり**除外せず全課題**を見る(`exclude_status` の対象にしていない。残課題)。
`my_tasks` の未完了も完了集合以外に統一した(M08 の実環境 E2E で、カスタム状態の課題が `statusId[]=1,2,3` の決め打ちで漏れると判明。ADR 0012)。overdue / upcoming は参加プロジェクトの状態一覧から決めた ID で絞り、watching は状態名が完了集合のものを除く。

### 同順位の並び

`issue_stale`: 経過日数の降順 → issue_key 昇順。`project_blockers`: severity(HIGH → MEDIUM)→ issue_key 昇順。
`user_workload` の members: user_id 昇順。`digest_*` の各リスト: issue_key 昇順。`activity_stats` の top: count 降順 → 名前昇順、
by_type / by_actor / by_date: キー昇順。曖昧さ: kind の順 → target → summary。issue_key の比較は辞書順(`PROJ-10` < `PROJ-9`。
logvalet の blocker と同じ)。

### activity type 名の表

`src/analysis/activity-types.ts` の 1 か所(logvalet は analysis と digest の 2 か所に重複)。timeline の 1 / 2 / 14 もここから引く。

## 帰結

有料プランの subrequest 上限と未公開 API(`relatedIssues`)の実機確認は [docs/manual-verification.md](../manual-verification.md) の V13・V09。

- 1 回の分析ツール呼び出しは最大 105 回(`project_blockers` + `include_comments`)。Backlog のレート制限の約 17%、Workers 無料プランの
  subrequest 上限(50)を超えるツールがある(`issue_stale` 55 など)。**分析ツールは有料プランを前提にする**(ADR 0003 の「有料プランの範囲で上げる」)。
- 直列なので、最悪ケースは遅い(100 ms/回として 10 秒台)。MCP クライアントの待ち時間に収まる範囲として受け入れる。
- 1,000 件を超えるプロジェクトの分析は一部の課題だけになる。`truncated` と warning で伝える。`issue_stale` は更新の古い順に取るので、
  落ちるのは最近更新された(停滞していない)側。他のツールは Backlog の既定の並び。
