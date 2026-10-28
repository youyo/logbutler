# M05: 分析・digest（加工系の読み取りツール 18 個）

ロードマップ: `plans/logbutler-roadmap.md`（決定済み事項の「分析系の取得件数」「日付の until」「完了とみなす状態」「出力」行を必ず読む）。
前提: M04 完了（`project_conventions` と conventions モジュールは M04 で実装済み。ambiguity 検出はそれを使う）。

量が多いため **M05A（分析系 11 個）** と **M05B（digest 系 6 個 + user_activity）** に分けて順に実装・検証・コミットする。

## 共通方針（5A・5B 共通。最初に共通基盤として実装する）

- **出力の型**: logvalet と同じエンベロープ。キーは snake_case
  - `AnalysisEnvelope`: `schema_version`("1"), `resource`, `generated_at`, `profile`, `space`, `base_url`, `warnings`, `analysis`
  - `DigestEnvelope`: 同上で最後が `digest`
  - `warnings[]`: `{code, message, component?, retryable}`。空でも `[]`
  - `llm_hints`: `{primary_entities, open_questions, suggested_next_actions}`。空でも `[]`
  - ページングで集めるツールは最上位（`analysis` / `digest` と同じ階層ではなく、その中の最上位）に `truncated` を常に出す（ADR 0004 の決定に従う。置き場所は ADR を確認して合わせる）
- **時刻**: `generated_at` を含め、すべて `ToolContext.now` から取る（logvalet の digest は time.Now 直書きでテストで固定できなかった）。日付の解釈は `LOGBUTLER_TIMEZONE`
- **until**: 全ツールで当日を含める（タイムゾーン基準で当日 23:59:59.999 まで）。since は当日 00:00
- **完了集合**: {完了, 対応済み, Closed, Done, Resolved}。`exclude_status` 引数があればそれを優先
- **件数**: 課題・コメント・アクティビティはページングで取得する（M02 のページングヘルパー）。上限を超えたら打ち切り、warning（例 `issues_truncated`）と `truncated: true`。課題の上限は 1,000 件（100 × 10 ページ）を既定にする
- **直列化**: logvalet の errgroup / WaitGroup による並列呼び出しは移植しない。すべて直列
- **API 呼び出し数**: ツールごとに最悪ケースの式を ADR 0006 に書き、`maxApiCalls` をツールごとに明示する。テストで「最悪ケースでも上限を超えない」「上限で止まる」を固定する（ロードマップ M05 の完了条件）
- **重複取得の排除**: project_health は stale / blockers / workload / ambiguity が同じプロジェクトの課題一覧を使う。1 回取得して共有する（logvalet は 4 回取得していた）
- **安定ソート**: 同順位の並びを決める（logvalet の sort.Slice は非安定、health の warnings は goroutine の完了順だった）。同順位は issue_key 昇順など、ツールごとに明記
- **activity type 名の変換表**は 1 か所にまとめる（logvalet は 2 か所に重複定義）
- **スキーマ**: 18 ツールの description / inputSchema / annotations は logvalet baseline と一致させる

## M05A: 分析系（11 個）

実装順: issue_stale → project_blockers → user_workload → project_health → issue_context → issue_triage_materials → my_tasks → digest_daily / digest_weekly → issue_timeline → activity_stats

| ツール | 要点（logvalet の仕様。数値は維持） | 意図した変更 |
|---|---|---|
| issue_stale | 閾値 days（既定 7）、`floor((now−updated)/24h) ≥ days`。Updated なしは除外。並びは days_since_update 降順 | 全件ページング、完了集合、安定ソート（同順位は issue_key 昇順） |
| project_blockers | high_priority_unassigned（優先度「高」「最高」かつ担当なし）、long_in_progress（「処理中」かつ ≥ days、既定 14）、overdue_open、blocked_by_keyword（include_comments 時、最新コメントにキーワード）。severity: high_priority_unassigned か overdue_open があれば HIGH、他 MEDIUM（logvalet `blocker.go` の calcSeverity。当初この欄を誤記していた） | 全件ページング、完了集合。include_comments の課題ごとのコメント取得は呼び出し上限に含める |
| user_workload | load_level: total ≥ 20 overloaded / ≥ 10 high / ≥ 5 medium / 他 low。stale は days（既定 7） | 全件ページング、完了集合 |
| project_health | score = 100 − stale×5 − HIGH×10 − MEDIUM×5 − overloaded×8 − (未割当率 > 20% なら 10) − min(ambiguity×2, 20)、下限 0。≥80 healthy / ≥60 warning / 他 critical | 課題一覧は 1 回だけ取得して共有。days 未指定時は stale と workload が 7、blocker が 14（logvalet の挙動を維持し、説明文との不一致は tool-diff に記録）。未割当率は実数で計算（logvalet は整数除算） |
| issue_context | IsStale ≥ 7、recent_comments は先頭 min(件数, comments 既定 10) | コメントは新しい順で必要数を取得し、comment_count はページングで正確に数える（上限つき） |
| issue_triage_materials | project_stats（by_status / by_priority / by_assignee / avg_close_days）、similar_issues | 統計用の課題一覧を全件ページング |
| my_tasks | week = 今週月〜日、next の日数オフセット（月 +4、火〜金 +6、土 +5、日 +4）、watching から担当済みと status.id 4 を除外 | overdue と upcoming の重複を排除（overdue を優先）。日付は `LOGBUTLER_TIMEZONE` 基準 |
| digest_daily / weekly | completed > blocked > started の優先順位。blockedKeywords {対応中断, 保留, ブロック, blocked, on hold} | 期間内の課題をページング。until は当日を含める |
| issue_timeline | activity type 1, 2, 14 と comment を時系列に。max_activity_pages 既定 5 | コメントもページング。max_comments=0 は「上限まで全件」を正しく意味するようにする |
| activity_stats | 集計キー・TopN=5・concentration は上位 3 件 | ページ上限を設けて warning + truncated（logvalet は上限なし）。未知の scope は argument_error。scope=user の user_id で "me" を解決。scope=project で project_key なしは argument_error |

## M05B: digest 系（6 個）+ user_activity

実装順: space_digest → document_digest → document_search → search → activity_digest → user_activity → digest_unified

| ツール | 要点 | 意図した変更 |
|---|---|---|
| space_digest | GetSpace + GetSpaceDiskUsage（失敗は warning）。used_bytes は 6 項目の和 | なし |
| document_digest | GetDocument → ListProjects → ListDocumentAttachments | なし |
| document_search | snippet は keyword 周辺 ±100 文字、plain ≤ 200 文字なら全文。count 既定 100・上限 100 | URL のパスをエスケープ（logvalet は未エスケープ）。snippet の切り出しはコードポイント単位 |
| search | issues / documents / wikis を統合。count 既定 20（1〜100） | project_keys の GetProject 失敗も warning にする（logvalet は全体エラー）。wiki 検索のプロジェクト数も呼び出し上限に含める |
| activity_digest | 1 回取得、type 3 からコメント抽出、プロジェクト別集計 | since / until を実際にフィルタとして使う（logvalet はエコーのみ）。related_* の並びを決定的にする（昇順）。limit は 1〜100 |
| user_activity | "me" 解決、maxId カーソルで取得 | 日付指定時もページ上限を設けて truncated（logvalet は上限なし）。出力はエンベロープなしの配列（logvalet 互換）を維持するか、truncated を出すためにエンベロープ化するかは ADR 0004 の決定に従い、tool-diff に記録 |
| digest_unified | scope（projects / users / teams / issues）別に合成 | maxId カーソルを正しく渡す（logvalet は同じページを繰り返し取得し、until 指定時に無限ループしうる）。project_keys の GetProject 二重呼び出しと projectId[] の重複を解消。`due_date` / `start_date` を issue_list と同じ解釈で実装（logvalet はスキーマにあるのに未使用）。summary.by_user を実際に集計 |

## 完了条件（5A・5B それぞれ）

- `mise run test`（unit + e2e）と `mise run lint` が通る
- 対象ツールのスキーマが baseline と一致（許容リストは空のまま、を目標）
- ツールごとの unit テスト: 入力の課題・活動の配列 → 期待する出力（閾値の境界値、同順位の並び、完了集合、until の境界、ページ上限での truncated と warning）
- ツールごとに「最悪ケースの API 呼び出し数」をテストで固定
- logvalet の不具合を直した箇所は、不具合を再現するテストを先に書いてから直す（例: digest_unified の maxId、100 件ちょうどのページが続くケース）
- E2E: 代表ツール（project_health、my_tasks、digest_unified、search）を `/mcp` 経由でモック Backlog に対して実行
- `docs/tool-diff-from-logvalet.md` に意図した変更をすべて記録、`docs/adr/0006-analysis-paging-and-call-budget.md`

## やってはいけないこと

- 同一ツール呼び出し内での並列呼び出し、上限なしのループ
- 実 Backlog への通信、テストを弱める・skip・削除、コミット・push、logvalet の変更、Durable Objects

## 一次参照（`/Users/youyo/src/github.com/youyo/logvalet/` 基点）

- 分析: `internal/analysis/`（analysis.go:23-121 共通、stale.go、blocker.go、workload.go、health.go:79-342、context.go、triage.go、my_tasks.go:86-331、periodic.go、timeline.go、activity_stats.go、related.go、ambiguity.go）
- digest: `internal/digest/`（common.go、space.go、document.go、document_search.go、search.go、activity.go、activity_filter.go、unified.go）
- 登録とスキーマ: `internal/mcp/tools_analysis.go`、`tools_activity.go`、`tools_document.go`、`tools_search.go`、`tools_space.go`、`tools_user.go:44-106`
- テスト（期待値の書き起こし元）: `internal/analysis/*_test.go`、`internal/digest/*_test.go`、golden `internal/digest/testdata/document_search_snippet.json`
