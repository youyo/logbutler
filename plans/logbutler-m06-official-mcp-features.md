# M06: 公式 MCP 由来の追加機能（縮小版）

ロードマップ: `plans/logbutler-roadmap.md`（「Nulab 公式 MCP から取り込む機能」節。2026-10-28 に価値を見直して縮小した経緯と、取り込まないものの理由がある）。
前提: M05 完了。参考元は Nulab 公式 `nulab/backlog-mcp-server` v0.23.3（ソース `src/tools/*.ts` を正とする）。

## 目的

logvalet に無く、実際に価値があるものだけを追加する: 自分宛ての通知の把握と、課題作成時の担当者・通知先の選定に必要なプロジェクトメンバー一覧。
あわせて、巨大な応答で AI のコンテキストを溢れさせないための安全網を入れる。

## 追加するツール（3 個）

| ツール | toolset | カテゴリ | 引数 | Backlog API | 返却 |
|---|---|---|---|---|---|
| logbutler_notification_list | notification | ReadOnly | min_id:number, max_id:number, count:number(1〜100), order:"asc"\|"desc"（すべて任意） | GET /api/v2/notifications（minId, maxId, count, order） | 生データ（camelCase） |
| logbutler_notification_count | notification | ReadOnly | already_read:boolean, resource_already_read:boolean（どちらも任意。未指定なら送らない） | GET /api/v2/notifications/count | `{"count": n}` |
| logbutler_project_users | project | ReadOnly | project_key:string（必須）, exclude_group_members:boolean（任意） | GET /api/v2/projects/{key}/users（excludeGroupMembers） | 生データ |

- 説明文は英語で、既存ツール（logvalet 由来）の書き方に合わせる。annotation の title は日本語
- logvalet に無い追加ツールなので、baseline 比較の「追加ツール」許容リストに載せ、`docs/tool-diff-from-logvalet.md` に記録する
- notification_list の説明文に、既読化はしない（Backlog の画面で確認する）旨を書く

## 応答サイズの上限（安全網）

- ツール引数 `max_response_tokens`（任意、既定 50000 をコード内の定数に、0 で無効）。環境変数にはしない（フラグはクライアント側で制御する、2026-10-28 ユーザー決定）。読み取りツール（ダウンロード系を除く）に付け、baseline との差分として許容リストと tool-diff に記録
- 数え方は近似でよい（例: `JSON 文字列の長さ / 4`、または公式と同じ `/\w+|[^\s\w]/g` のマッチ数）。どちらにしたかと近似であることを ADR に書く
- 上限を超えたら**切り詰めない**。代わりに §9 エンベロープの `isError: true` を返す
  - code は新設の `response_too_large`（retryable: false）。M02 の code 列挙と ADR 0004 に追加する
  - message に「推定サイズ」「上限」と、絞り込みの手がかり（count / offset / 期間 / project_key などを指定して再実行する）を含める
- 対象外: ダウンロード系（issue_attachment_download / shared_file_download。ファイルサイズ上限が別にあるため）
- 冪等キャッシュとの関係: 非冪等ツール（書き込み）が成功したあとで応答が上限を超えた場合は、書き込みは実行済みなので**エラーにせず**そのまま返す（書き込みの成功を失敗に見せない）。テストで固定する
- M05 の上限つき取得（`truncated`）が一次の対策で、これは最後の安全網である旨を ADR に書く

## 完了条件

- `mise run test`（unit + e2e）と `mise run lint` が通る
- 3 ツールの unit テスト（API 写像・返却値）。既存ツールのスキーマは baseline と一致したまま
- 応答サイズ上限: 上限ちょうど（通る）・超過（`response_too_large`）・ダウンロード除外・0 で無効・書き込み成功後の超過は通す、の unit テスト。超過時のエンベロープの E2E
- `/mcp?toolsets=notification` で通知系 2 個だけになること（E2E）
- `docs/adr/0007-response-size-limit.md`、README と `.dev.vars.example` の環境変数の追記

## TDD
unit・E2E とも実装前に Red を確認する（ユーザーの明示要求）。報告に Red の証跡を付ける。

## やってはいけないこと
- 取り込まないと決めたもの（通知の既読化・未読リセット、優先度・完了理由一覧、`fields`、文字数での切り詰め）と、公式の他のツール（Git / PR、Wiki 書き込み、delete_issue、プロジェクト等の編集）
- 実 Backlog への通信、テストを弱める・skip・削除、コミット・push、logvalet の変更、Durable Objects

## 一次参照
- 公式ソース（tag v0.23.3）: https://raw.githubusercontent.com/nulab/backlog-mcp-server/v0.23.3/src/tools/getNotifications.ts 、`getNotificationsCount.ts`、`getProjectUsers.ts`
- Backlog API: https://developer.nulab.com/docs/backlog/api/2/get-notification/ 、https://developer.nulab.com/docs/backlog/api/2/count-notification/ 、https://developer.nulab.com/docs/backlog/api/2/get-user-list-of-project/
