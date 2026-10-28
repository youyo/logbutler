# logvalet との差分

Logbutler の MCP ツールは、logvalet の MCP ツールと同じ名前(接頭辞だけ `logvalet_` → `logbutler_`)・同じ引数で動くことを目標にする。
ここには、**意図して違えている点**を理由つきで記録する。

## スキーマ(tools/list)の差分

M03 で移植した 38 ツールの `description` / `inputSchema` / `annotations` は、logvalet の baseline
(`test/fixtures/logvalet_tools_list_baseline.json`)と**差分 0**(`test/helpers/baseline.ts` の `ALLOWED_CHANGES` は空)。
比較は次の正規化のうえで行う: ツール名の接頭辞の置換、キー順の無視、zod が付ける `$schema` と
`additionalProperties: false` の除外、`required` と `enum` の**順序の無視**(Go 版は辞書順、zod は定義順のため。集合としては比べる)。

整数の引数(ID・件数)は、JSON Schema 上は logvalet と同じ `number` のまま公開する(`integer` や `minimum` を足すと baseline と食い違うため)。
整数かどうか・範囲は、スキーマではなく実行時に検証して `argument_error` にする。

M04 で移植した書き込み・破壊的ツール 14 個と `project_conventions`(M05 から前倒し)の計 15 ツールも、baseline と**差分は
`issue_attachment_upload` の 3 か所だけ**(`ALLOWED_CHANGES`。`test/unit/tools-list-snapshot.test.ts` が 3 か所に固定している):

- `description`: 「Specify EITHER file_paths (...) OR file_name + file_content_base64」から file_paths の記述を除いた。
- `inputSchema.properties.file_paths`: 削除。Workers にはファイルシステムがなく、サーバー上のパスを受け取る意味がない(決定済み事項)。
- `inputSchema.properties.file_content_base64.description`: 「Mutually exclusive with file_paths.」を除いた。

`idempotency_key` は inputSchema に宣言していない(baseline と一致させるため。受け取り方は ADR 0005)。

## 振る舞いの差分

| ツール | logvalet | Logbutler | 理由 |
|---|---|---|---|
| すべて | エラーはプレーンテキスト | spec §9 のエンベロープ(`isError: true`)。429 は `rate_limited` | ADR 0004 |
| 全般(Backlog の生データを返すツール) | logvalet のドメイン型に詰め直して JSON 化 | Backlog の応答を**そのまま**返す(camelCase) | ADR 0004。変換しない |
| `issue_list` の `due_date` / `start_date` | `today` などをサーバーのローカル時刻で解決 | ツール引数 `timezone`(IANA 名。省略時 `Asia/Tokyo`)の暦日で解決 | Workers は UTC で動く。週の始まりは月曜のまま。引数の追加は下の「M05.5」参照 |
| `issue_list` の `project_key` + `project_keys` | 重なったキーも ID も重複して送る | 同じキーは 1 回だけ解決し、ID も重複させない | 無駄な API 呼び出しの削減 |
| `shared_file_list` の `path` | 未エスケープでパスに埋め込む | `/` で分けたセグメントごとに `encodeURIComponent`。`.` と `..` のセグメントは `argument_error` | `?` `#` や `..` で別の API を叩けてしまうため |
| すべての ID・キーのパス部分 | `url.PathEscape` | `encodeURIComponent`。`.` と `..` のみの値は `argument_error` | 同上(URL の正規化でパスを辿れる) |
| `user_get` の `user_id` | `me` は未対応(ユーザー ID として問い合わせる) | `me` を受け付け、`GET /users/myself` 1 回で返す | スキーマ(型・説明文)は変えない |
| ダウンロード系(`issue_attachment_download` / `shared_file_download`) | 上限 20 MiB(超過は ErrDownloadTooLarge → プレーンテキスト) | 返却形式は同じ `{content_base64, filename, content_type, size_bytes}`。上限 20 MiB を**上限 + 1 バイトまで読んで**判定し、超過は `api_error`(retryable でない)・message は `File is too large to download (limit 20 MiB). ...`。`Content-Length` が上限超なら本文を読まない | 全体をメモリに読んでから判定しない。`argument_error` ではない(入力の誤りではないため) |
| `count` の上限(`activity_list` `issue_list` `team_list` `watching_list` `wiki_history`) | 範囲外は黙って Backlog に渡す、または既定値に丸める | 説明文に最大 100 とあるものは 1〜100 に限り、範囲外は `argument_error`。`activity_list` の既定は 20 | 計画書の方針。説明文に上限がないもの(`document_list` `issue_comment_list` `shared_file_list`)は Backlog に任せる |
| `count` / `offset` が 0 以下(上限のないもの) | 送らない | 送らない(同じ)。ただし `document_list` の `offset` は 0 でも送る | Backlog のドキュメント API の要件 |
| `activity_list` の `user_id` と `project_key` | 同時指定は error | 同じ(`argument_error`)。空文字は未指定として扱う | — |
| 引数の型違い・必須の欠落 | 各ツールで「x is required」 | zod の検証で `argument_error`(どの引数が悪いかを message に入れる) | `registerTools` が一括で検証する |
| 冪等キャッシュ(`issue_create` `issue_comment_add` `issue_attachment_upload` `document_create`) | プロセス内メモリ。キーにユーザーなし。`params._meta` は本番で読めていなかった。エラーもキャッシュ | KV(`idem:<ユーザーID>:<ツール>:<explicit\|hash>:<値>`)。ユーザーごとに分離。`params._meta.idempotency_key` → 引数 `idempotency_key` の順。**成功した結果だけ** TTL 5 分で保存。ほぼ同時の 2 回は両方実行されうる | ADR 0005 |
| `issue_create` の `priority_id` | 未指定でも `priorityId=0` を送る | 未指定(0 を含む)なら `priorityId` を送らない | 0 は有効な優先度 ID ではない。実機での挙動は未検証の前提(Backlog が 0 を既定の「中」に読み替えるのか、エラーにするのかは確認していない) |
| `issue_attachment_upload` | `file_paths` でサーバー上のパスも受け取る | `file_paths` なし。base64 のみ。上限 4 MiB は**デコード後の実サイズ**で判定（ちょうど 4 MiB は通り、4 MiB + 1 は `argument_error`）。`file_name` が空・`.`・`..` なら `argument_error` | 推定 `(len/4)*3` は、ちょうど 4 MiB を誤って弾きうる。base64 長が上限の約 1.25 倍を超える入力はデコードせずに弾く |
| MCP の POST 本文の上限 | 4 MiB 相当 | 8 MiB（`src/mcp/request-body.ts`）。超えたら 413 | 4 MiB のファイルを base64 にして JSON に入れると約 5.6 MB。agents の stateless ハンドラは `maxRequestBodySize` を 2025 年版プロトコルの判定に渡さず、4 MiB を超えると 400 になるため、本文を自前で読んで `parsedBody` を渡す |
| `issue_related_delete` | 空本文のとき、ゼロ値の関連課題を返す | 空本文・204 のとき `{"result":"ok"}` | 意味のないゼロ値の JSON を返さない |
| `star_add` `watching_mark_as_read` | 204 → `{"result":"ok"}` | 同じ | — |
| `issue_update` の更新項目の判定 | `hasUpdateField` | 同じ。`category_ids` などの空文字は更新項目に数えない。`engagement` は補完したカテゴリ・親課題を数える | — |
| `project_conventions`・`engagement` | ListIssues を count 無指定で 1 回だけ呼ぶ。規約課題が 1 ページ目になければ見落とす疑い | 規約の課題種別(`issueTypeId`)で絞ったうえでページングする(ADR 0003 の上限: 100 件 × 10 ページ)。案件親課題も案件種別で絞って探す。GetProject は 1 回(ツール呼び出し内でキャッシュ) | 見落としの防止と API 呼び出し回数の削減 |
| `project_conventions` の YAML | `KnownFields(true)` で未知のフィールドはエラー | 同じ（`src/conventions/load.ts`）。未指定のリストは JSON で `null`（Go の nil スライスと同じ） | — |
| `engagement` の失敗 | プレーンテキスト | 規約にない案件は `argument_error`（使える案件名つき）、規約が未導入・カテゴリなし・YAML 不正は `generic_error`（message はそのまま見える） | ADR 0004 |
| タイムアウト | 接続・応答ヘッダーまで | 応答**本文の読み取りまで**同じ期限(既定 30 秒) | Workers の実時間制限と MCP クライアントの待ち時間 |

## M05A: 分析系の加工ツール 11 個

`issue_stale` `project_blockers` `user_workload` `project_health` `issue_context` `issue_triage_materials` `my_tasks`
`digest_daily` `digest_weekly` `issue_timeline` `activity_stats` の `description` / `inputSchema` / `annotations` は、logvalet の baseline と**差分 0**
(`ALLOWED_CHANGES` `ALLOWED_MISSING` `ALLOWED_EXTRA` は増やしていない。`test/unit/tools-list-snapshot.test.ts` が確認)。
出力は snake_case の `AnalysisEnvelope`(`schema_version` `resource` `generated_at` `profile` `space` `base_url` `warnings` `analysis`)。
`profile` は空文字、`space` はスペースのホストの先頭ラベル、`base_url` は `https://<ホスト>`。

数値の閾値・スコア式(stale 7 日 / long_in_progress 14 日 / load_level 5・10・20 / health の減点表 / digest のキーワード)は logvalet と同じ。
意図して違えている点は次のとおり(固定するテストは各行のとおり)。

| ツール | logvalet | Logbutler | 理由・テスト |
|---|---|---|---|
| 分析全般(stale / blockers / workload / health / triage / digest) | 課題一覧を `count` なしで 1 回(Backlog 既定の 20 件) | offset で全件(10 ページ × 100 件が上限)。上限で止めたら `analysis.truncated: true` と `issues_truncated` の warning | ロードマップのユーザー決定。ADR 0006。`analysis-common.test.ts`(20 件超・100 件ちょうど・上限)と各ツールの「20 件より多い」テスト |
| 分析全般 | `analysis` に `truncated` はない | ページングで集めるツールは `analysis.truncated` を常に出す | ADR 0004 |
| 分析全般 | 取得失敗の warning は `retryable: true` 固定 | Backlog のエラーに従う(404 は false、5xx・429・通信失敗は true)。401 は warning にせず投げ直す | トークン更新のため。`analysis-common.test.ts` の `warningFromError` |
| 分析全般 | `time.Now` / `now().UTC()` | `ToolContext.now`。`generated_at` は UTC の ISO 文字列(ミリ秒つき) | テストで固定するため |
| `issue_stale` `project_blockers` `user_workload` `project_health` | 除外する状態は「完了」だけ(`exclude_status` 指定時はそれ) | 既定は {完了, 対応済み, Closed, Done, Resolved}。`exclude_status` 指定時はそれだけ | ロードマップのユーザー決定。各ツールの「完了集合」テスト |
| `issue_stale` | 同順位は非安定ソート。更新順の指定なし | 経過日数の降順 → issue_key 昇順。課題は `sort=updated&order=asc`(更新の古い順)で取る | 上限で切れても、落ちるのは停滞していない側。`tools-analysis-stale.test.ts` |
| `issue_stale` `project_blockers` | `project_keys` の件数に制限なし。重複もそのまま | 5 個まで(6 個以上は `argument_error`)。重複は 1 つにまとめる | 呼び出し数の上限を式で書くため。ADR 0006 |
| `project_blockers` | `include_comments` は対象の全課題に 1 回ずつ(`count=5`)、失敗は黙って無視 | 完了集合を除いた課題を issue_key 昇順に並べた先頭 50 件だけ、`count=1&order=desc`。超過は `comment_check_truncated` の warning と `truncated`。失敗は `comments_fetch_failed` に 1 件にまとめる | 呼び出し数の上限。ADR 0006。`tools-analysis-blockers.test.ts` |
| `project_blockers` | severity: HIGH は `high_priority_unassigned` か `overdue_open` | 同じ(**計画書の表の「前 2 つのどちらか→HIGH」は logvalet のコードと食い違っているので、logvalet のコードに合わせた**) | `blocker.go` の `calcSeverity`。`tools-analysis-blockers.test.ts` の severity |
| `project_health` | stale / blockers / workload / ambiguity が同じ課題一覧を 4 回取得し、errgroup で並列 | GetProject と課題一覧を 1 回だけ取って共有。すべて直列 | `tools-analysis-health.test.ts` の「1 回だけ取得」 |
| `project_health` | 未割当率は整数除算(`unassigned*100/total > 20`)。20.69% が 20 になり減点されない | 実数で `> 20%`(`unassigned * 5 > total`) | `calcHealthScore` のテスト |
| `project_health` | `days` 指定時は 3 つに同じ値。未指定時は stale 7 / blocker 14 / workload 7 | 同じ。ツールの説明文「(default 7)」は blocker の 14 日と食い違うが、説明文は baseline に合わせて変えていない | 計画書。`tools-analysis-health.test.ts` の days |
| `project_health` | 取得失敗の warning は 3 重(stale / blocker / workload がそれぞれ出す)。warnings の並びは goroutine の完了順 | 1 件。並びは 課題取得 → コメント確認 → 規約 の固定順 | 共有取得と直列化 |
| `project_health` | 規約の取得失敗は `ambiguity_detect_failed` の warning | 同じ。規約課題は種別で絞ってページング(M04 の `loadProjectConventions`) | M04 の方針 |
| `project_health` | 曖昧さ検出は全課題(完了を含む)を見る | 同じ(`exclude_status` の対象にしていない) | 計画書に変更の指定がないため据え置き。完了済みの課題が `no_engagement` / `close_candidate` になる点は残課題 |
| `issue_context` | コメントは 1 回(既定の 20 件)で、`comment_count` はその件数 | `maxId` のカーソルで全件(上限 1,000)数える。`recent_comments` は新しい順の先頭 N 件。上限で止めたら `comments_truncated` と `truncated` | 計画書。`tools-analysis-context.test.ts` |
| `issue_triage_materials` | 統計は 20 件の課題から。コメント件数は 20 件まで | プロジェクトの課題を全件(上限つき)、コメントを全件(上限つき)。warning の `component` は `project_stats` / `history.comment_count` | 計画書。`tools-analysis-triage.test.ts` |
| `my_tasks` | overdue と upcoming の期間が重なると同じ課題が両方に出る | overdue を優先し、upcoming から除く(watching の除外にも使う) | `tools-analysis-my-tasks.test.ts` の重複 |
| `my_tasks` | 日付はサーバーのローカル時刻。`date_range` は Go の `time.Time` | `timezone` 引数(省略時 Asia/Tokyo)の暦日。`date_range` はオフセットつき RFC 3339。overdue / upcoming / watching はそれぞれ全件(上限つき) | 同上。`mode` が `week` / `next` 以外は `argument_error`(logvalet は week 扱いで `mode` をそのまま返した) |
| `digest_daily` `digest_weekly` | `until` は 00:00 で切り、当日を含めない。課題一覧は 1 回(20 件) | `until` は当日 23:59:59.999(タイムゾーン基準)。ページングで全件。completed / started / blocked は issue_key 昇順。`since` / `until` はオフセットつき RFC 3339。GetProject の失敗はツールエラー(logvalet と同じ)、課題一覧の失敗は warning | ロードマップのユーザー決定。`tools-analysis-digest-periodic.test.ts`、e2e |
| `issue_timeline` | コメントは 1 回(20 件)。`max_comments` は取得後に先頭から切る。アクティビティは全種別を 5 ページ | コメントを全件(上限つき)。`max_comments=0` は上限まで全件、N は期間で絞ったあとの新しい方から N 件。アクティビティは `activityTypeId[]=1,2,14` で絞って取る。since より古いものに届いたらページングをやめる。`max_activity_pages` は 1〜10 | 計画書。`tools-analysis-timeline.test.ts` |
| `issue_timeline` `activity_stats` | `until` は 00:00 | 当日 23:59:59.999 | ロードマップのユーザー決定 |
| `activity_stats` | ページ数の上限なし。未知の `scope` は space 扱い。project で `project_key` なし、user で `user_id` なしはそのまま API を呼んで失敗 | 10 ページが上限(`activities_truncated` と `truncated`)。未知の scope・必須キーの欠落は `argument_error`(Backlog を呼ばない)。`user_id` の `"me"` は GetMyself で解決 | 計画書。`tools-analysis-activity-stats.test.ts` |
| `activity_stats` | `by_date` / `by_hour` / `peak_day_of_week` は UTC で集計 | `timezone` 引数(省略時 Asia/Tokyo)で集計。`by_type` `by_actor` `by_date` はキー昇順 | 日付の解釈はタイムゾーン基準という方針の一貫性。UTC で見たいときは `timezone: "UTC"`。`tools-analysis-activity-stats.test.ts` の集計 |
| 全般 | activity type 名の表が analysis と digest の 2 か所 | `src/analysis/activity-types.ts` の 1 か所 | 重複の排除 |

## M05B: digest 系 6 個 + user_activity

`space_digest` `document_digest` `document_search` `search` `activity_digest` `user_activity` `digest_unified` の `description` /
`inputSchema` / `annotations` は、logvalet の baseline と**差分 0**(`activity_digest` `user_activity` `digest_unified` の
`properties.timezone` の追加だけが `ALLOWED_CHANGES` の許容。M05.5 の決定)。これで baseline の 71 ツールすべてを公開し、
`tools-list-snapshot.test.ts` が 71 ツールで確認する(`ALLOWED_MISSING` `ALLOWED_EXTRA` は空のまま)。
出力は snake_case の `DigestEnvelope`(`AnalysisEnvelope` と同じで最後のキーが `digest`)。`resource` は logvalet と同じ
(`space` `document` `document_search` `search` `activity` `digest`)。`user_activity` は新規に `user_activity`。
toolset: `space_digest` `document_digest` `activity_digest` `digest_unified` は `digest`、`document_search` `search` は `search`、
`user_activity` は `activity`(logvalet は `tools_user.go` に置いていたが、アクティビティの取得なので `activity` に入れた)。
ツール名 `logbutler_search` は、baseline に合わせて action のない唯一の名前(`defineTool` の名前規則の例外)。

| ツール | logvalet | Logbutler | 理由・テスト |
|---|---|---|---|
| 全般: `count` / `limit` の範囲 | `document_search` `search` は 100 超を黙って 100 に丸める | `count` は 1〜100、範囲外は `argument_error`(`activity_digest` の `limit` も 1〜100)。M03 の `boundedCount` と同じ | 黙った丸めをしない。`tools-digest-document.test.ts` `tools-digest-search.test.ts` `tools-digest-activity.test.ts` |
| 全般: `detail` | 知らない値は黙って `meta` 扱い | `snippet` / `meta` / `full`(`search` は `snippet` / `meta`)以外は `argument_error` | 同上 |
| 全般: 時刻 | digest が `time.Now()` 直書き | `generated_at` は `ToolContext.now` | 固定してテストできる |
| 全般: 期間の日付 | UTC の 00:00。`activity_digest` は `since` / `until` を出力にエコーするだけ。`user_activity` だけ `until` を当日の終わりまで含める | `timezone` 引数(省略時 `Asia/Tokyo`)の暦日で、`since` は当日 00:00、`until` は当日 23:59:59.999(当日を含める)。出力の `since` / `until` はオフセットつき RFC 3339 | ロードマップの決定事項 |
| 全般: 並び | related_* などが Go の map の順 | キー昇順に固定(`types` `projects` `by_status` `by_user` `related_issue_keys` `related_project_keys`) | 決定的にする |
| `document_search` | URL のパス(プロジェクトキー・ドキュメント ID)が未エスケープ | `encodeURIComponent`(`/` や空白を含んでも URL が壊れない)。`snippet` はコードポイント単位(サロゲートペアを割らない。小文字化は 1 コードポイントずつで、長さが変わる文字は元のまま) | `analysis-snippet.test.ts`、`tools-digest-document.test.ts` の URL |
| `document_search` / `search` の `project_keys` | 個数に上限なし | 5 個まで(超えたら `argument_error`)。重複は 1 つにまとめる。`document_search` は GetProject の結果から URL のキーを引き、ListProjects を呼ばない | 呼び出し数を式で閉じる(ADR 0006) |
| `search` | `project_keys` の GetProject が 1 つでも失敗すると全体エラー | warning `project_fetch_failed`(component `scope.projects.<KEY>`)にして、引けた分で検索する。**全部引けなければ**スペース全体を検索せず、空の結果と warning | 絞り込みを失って意図しない範囲を返さない。`tools-digest-search.test.ts`、e2e `digest-tools.test.ts:339,362` |
| `search` の Wiki 検索 | 全プロジェクトに 1 回ずつ(プロジェクト数に比例) | 先頭 10 プロジェクトまで。超えたら `wiki_search_truncated` と `truncated: true`。`digest.truncated` を常に出す。`count + offset + 1` 件集まって止めたときは truncated にしない | 呼び出し数の上限(ADR 0006)。e2e `digest-tools.test.ts:264` |
| `search` の `possibly_more_by_type` | 0 / 1 の整数 | 同じ(互換のため 0 / 1 のまま) | — |
| `activity_digest` | 最新 `limit` 件をそのまま使う。`since` / `until` は出力にエコー | 取得は 1 回(最新 `limit` 件)のまま、`since` / `until` で**取得後に絞る**。`created` のない活動は期間指定時に除く。`limit` 件ちょうど取れて期間の端(`since`)に届いていなければ `truncated: true`。`related_*` は昇順 | 期間が実際に効く。**制限**: 期間内でも最新 `limit` 件より古い活動は含まれない(`truncated` で分かる)。`tools-digest-activity.test.ts` |
| `user_activity` の出力 | **エンベロープなしの配列**(`[]Activity`) | `DigestEnvelope`(`resource: "user_activity"`)。`digest` = `{user_id, since?, until?, limit?, total_count, activities, truncated}`。`activities` の各要素は Backlog の生データ(camelCase)のまま | ADR 0004 の決定(ページングで集めるツールは `truncated` を最上位に常に出す)。配列には載せられないため、互換を破ってエンベロープ化した |
| `user_activity` の上限 | 期間指定時はページ数の上限なし | 期間指定時も 10 ページ(1,000 件)まで。超えたら `activities_truncated` と `truncated: true`。`limit` に届いて止まったときは `truncated: true` だが警告は出さない。`limit` は期間がないときだけ適用(logvalet と同じ) | ADR 0006。e2e `digest-tools.test.ts:379` |
| `user_activity` の `project` | 受け取るが**何もしない**(説明文は client-side filter) | 同じく絞り込みには使わない。指定されたら warning `project_filter_ignored` を返して、無視したことを知らせる | 挙動は変えず、黙って無視しない。実装するかは残課題 |
| `digest_unified` のアクティビティ | 取得関数が `maxId` を受け取らず、同じページを繰り返し取得。`until` 指定で新しい活動ばかりだと止まらない(結果が上限件数に届くまで) | `maxId` を直前のページの最後の id - 1 に進める。`since` に届いたら止め、`until` より新しいものは取得後に除く。1 ソース 5 ページ(500 件)まで。超えたら `activities_truncated` | **logvalet の不具合の修正**。再現テスト: `tools-digest-unified.test.ts`(100 件ちょうどのページ、`until` 指定)、e2e `digest-tools.test.ts:74,140`。変異(`maxId` を渡さない)で失敗することを確認 |
| `digest_unified` の GetProject | MCP ハンドラと Builder で各キー 2 回。`projectId[]` に重複 | 各キー 1 回。`projectId[]` は重複なし | e2e `digest-tools.test.ts:74` |
| `digest_unified` の `due_date` / `start_date` | スキーマにあるが**未使用** | `issue_list` と同じ解釈(`today` / `overdue` / `this-week` / `this-month` / 日付 / `A:B`)で `dueDateSince` などを課題一覧に渡す。説明文は logvalet のまま(`issue_list` と同じ解釈の語も受け付ける) | `tools-digest-unified.test.ts`、e2e `digest-tools.test.ts:217` |
| `digest_unified` の `summary.by_user` | 常に空の `{}` | 課題の担当者と活動の実行者を**ユーザー ID**(数値の文字列)ごとに `{issues, activities}` で集計。scope のユーザーは 0 件でも載せる。担当者なしの課題は数えない | `tools-digest-unified.test.ts`、e2e `digest-tools.test.ts:74` |
| `digest_unified` の課題・上限 | 課題を最大 10,000 件までページング。各入力の個数に上限なし。アクティビティはユーザー・プロジェクトごとに**並列** | 課題は 10 ページ(1,000 件)まで(`issues_truncated`)。`project_keys` 5・`team_ids` 3・`user_ids` 10・`issue_keys` 20 を超えたら `argument_error`。チーム展開後のユーザーも 10 人まで(`users_truncated`)。ソースは**直列** | ADR 0006。最悪 88 回 |
| `digest_unified` の名前解決 | ユーザーは全員 GetUser | チームのメンバーに含まれるユーザーの名前はチームの応答から取り、GetUser を省く | 呼び出しの削減 |
| `digest_unified` の部分失敗 | アクティビティはどれか 1 つ失敗すると**全部**捨てる。MCP ハンドラでは GetProject の失敗が全体エラー | ソースごとに warning `activities_fetch_failed` にして、取れた分を残す。GetProject / GetTeam / GetUser / GetIssue の失敗は warning(`project_fetch_failed` `team_fetch_failed` `user_fetch_failed`(名前は `user:<ID>`)`issue_fetch_failed`)。**指定した絞り込み(プロジェクト・ユーザー/チーム)が 1 つも引けなければ**(チームが引けてもメンバー 0 人の場合を含む。warning `team_has_no_members`)、範囲が広がらないよう課題もアクティビティも取らず、空の結果と warning を返す | ADR 0006 の「部分失敗は warning」。e2e `digest-tools.test.ts:236` |
| `digest_unified` の並び | ソース順に連結 | 新しい順(id の降順)にまとめる | 決定的にする |
| `space_digest` `document_digest` | — | 出力の形・サマリーの文言(全角括弧つきの headline など)は同じ。`document_digest` の添付は `{id, name, size}` の 3 項目だけ(logvalet と同じ)。`capacity_bytes` `used_bytes` は 0 のとき省略(logvalet の omitempty と同じ) | — |
| `activity_digest` の `scope.since/until` | UTC の時刻 | オフセットつき(`timezone` 引数の暦日) | 上記の期間 |

## logvalet で見つけた不具合の疑い(logvalet は変更しない)

- `shared_file_list` の `path` が未エスケープ(上記)。
- `internal/mcp/tools_activity.go` の `activity_list`: `user_id` と `project_key` の排他チェックが「キーが存在するか」で判定されるため、空文字でも排他になる。
- `issue_create` が `priority_id` 未指定のとき `priorityId=0` を送る（`internal/backlog/http_client.go` の `CreateIssue`）。Backlog が 0 を拒否する・黙って既定にするのどちらかは未確認。
- `internal/conventions/show.go` の `Show` と `engagement.go` の `ResolveEngagement` は `ListIssues` を件数指定なしで 1 回だけ呼ぶので、プロジェクトの課題が多いと規約課題・案件親課題が 1 ページ目に載らず見落とす疑い。
- `internal/mcp/tools.go` の冪等キャッシュはキーにユーザーがなく、別ユーザーの同一引数の呼び出しが衝突しうる。`params._meta` の `idempotency_key` は本番のハンドラから渡されておらず効いていない（テストは `args["_meta"]` を直接入れている）。
- `internal/mcp/tools_issue.go` の添付アップロードは、デコード前の推定サイズ `(len/4)*3` で弾く（パディングを数えるので、ちょうど上限のファイルを誤って弾きうる）。
- `internal/mcp/tools_user.go` の `user_get` は `me` を扱えないが、同じファイルの `user_activity` や `watching_list` は `me` を解決する(一貫性がない)。
- `internal/analysis/*.go` の分析系は `ListIssues` を `count` なしで 1 回だけ呼ぶため、20 件を超えるプロジェクトでは一部の課題だけで分析している（stale / blocker / workload / health / ambiguity / triage / periodic の全部）。
- `internal/analysis/health.go` は stale / blocker / workload / ambiguity で同じ課題一覧を 4 回取得し、取得失敗の warning が 3 重に出る。warnings の並びは goroutine の完了順。
- `internal/analysis/health.go` の未割当率は整数除算で、20% をわずかに超えても減点されないことがある。
- `internal/analysis/my_tasks.go` は overdue（昨日まで）と upcoming（週の月〜日）の期間が重なる日の課題を両方に出す。`mode` が不正でも week として扱い、その値をそのまま返す。
- `internal/analysis/timeline.go` は `max_comments` を取得後に切るだけで、コメントは 1 回（既定の 20 件）しか取らない。`internal/analysis/activity_stats.go` と `periodic.go` の `until` は 00:00 で切り、当日を含めない。
- `internal/analysis/blocker.go` の `include_comments` は対象の全課題に 1 回ずつコメントを取りに行き（件数の上限なし）、失敗は黙って無視する。`internal/analysis/activity_stats.go` はページ数に上限がなく、未知の `scope` を space として扱う。
- `internal/digest/activity_filter.go` の `FetchActivitiesWithDateFilter` を使う `internal/digest/unified.go` の取得関数は `maxID` を無視して同じページを繰り返し取得する。`until` より新しい活動ばかりが続くと、収集件数(上限 10,000)に届くまで止まらない(1 ソース 100 回超の呼び出し)。`digest_unified` はプロジェクト・ユーザー・チームの数に比例して並列に呼ぶため、最悪 2,000 回超になる。`FetchActivitiesWithDateFilter` 自体は `maxID` を使うが、呼び出し側の関数が受け取っていない。
- `internal/mcp/tools_analysis.go` の `digest_unified` は `due_date` / `start_date` をスキーマに公開しているが、ハンドラが読んでいない。`summary.by_user` は常に空の map。`project_keys` の GetProject を MCP ハンドラと Builder で 2 回呼ぶ。
- `internal/mcp/tools_user.go` の `user_activity` の `project` は、説明文に client-side filter とあるが何もしない。出力がエンベロープなしの配列で、上限に届いたかを伝えられない。
- `internal/digest/search.go` の `search` は `project_keys` の GetProject が 1 つでも失敗すると全体エラー、キーなしでは全プロジェクトに Wiki を検索しに行く(プロジェクト数に比例)。
- `plans/logbutler-m05-analysis-digest.md` の M05A の表（project_blockers の severity「前 2 つのどちらか→HIGH」）は、logvalet のコード（`high_priority_unassigned` と `overdue_open`）と食い違っている。

## M05.5: クライアント制御への移行による差分

| 対象 | logvalet | Logbutler | 理由 |
|---|---|---|---|
| `issue_list` `my_tasks` `digest_daily` `digest_weekly` `activity_stats` `issue_timeline` の `inputSchema` | `timezone` 引数なし | 任意の文字列引数 `timezone`(IANA 名。省略時 `Asia/Tokyo`)を追加。不正な名前は `argument_error`(Backlog は呼ばない) | タイムゾーンの環境変数を廃止し、「今日」の基準を呼び出しごとにクライアントが決める(ロードマップのユーザー決定、2026-10-28)。`ALLOWED_CHANGES` に理由つきで載せ、`tools-list-snapshot.test.ts` が差分を `properties.timezone` の追加だけに固定。M05B の `digest_unified` `user_activity` `activity_digest` にも同じ引数を付ける |
| `toolsets` / `read_only` | (logvalet に相当なし。Logbutler の仕組み) | `/mcp` の URL クエリ。不正値は 400 + 理由 | ADR 0008 |

## 移植していないもの

- `StaleConfig.StatusDays`(ステータス別の stale 閾値)。logvalet の Go ライブラリ側にはあるが MCP のツール引数には公開されておらず、Logbutler にも持ち込んでいない(`issue_stale` / `project_health` は全ステータス共通の `days` だけ)。

## M06: 追加ツールと応答サイズの上限

### 追加ツール(logvalet に無い。Nulab 公式 `nulab/backlog-mcp-server` v0.23.3 から取り込み)

`test/helpers/baseline.ts` の `ALLOWED_EXTRA` に載せている。すべて読み取り専用(ReadOnly)。

| ツール | toolset | 引数 | Backlog API | 返却 |
|---|---|---|---|---|
| `logbutler_notification_list` | notification | `min_id` `max_id` `count`(1〜100) `order`(asc/desc)、すべて任意 | `GET /notifications`(minId, maxId, count, order) | 生データ(camelCase) |
| `logbutler_notification_count` | notification | `already_read` `resource_already_read`(任意。未指定なら送らない) | `GET /notifications/count`(alreadyRead, resourceAlreadyRead) | `{"count": n}` |
| `logbutler_project_users` | project | `project_key`(必須) `exclude_group_members`(任意) | `GET /projects/{key}/users`(excludeGroupMembers) | 生データ |

取り込まないと決めたもの: 通知の既読化・未読リセット、優先度・完了理由一覧、`fields`、文字数での切り詰め、Git / PR、Wiki 書き込み、delete_issue、プロジェクト等の編集。
`notification_list` は既読化しない(Backlog の画面で確認する)。

### 応答サイズの上限(ADR 0007)

| 対象 | logvalet | Logbutler | 理由 |
|---|---|---|---|
| 読み取りツール 55 個(ダウンロード系 2 個を除く)の `inputSchema` | `max_response_tokens` なし | 任意の整数引数 `max_response_tokens`(省略時 50000、0 で無効)を追加。超えたら切り詰めず `response_too_large` | 巨大な応答で AI のコンテキストを溢れさせない最後の安全網。フラグはクライアントが決める(2026-10-28 ユーザー決定)。`ALLOWED_CHANGES` に理由つきで載せ、`tools-list-snapshot.test.ts` が差分を `properties.max_response_tokens` の追加だけに固定している(`timezone` を持つ 9 ツールは両方) |
| エラーコード | `response_too_large` なし | 追加(retryable: false) | ADR 0004 |
