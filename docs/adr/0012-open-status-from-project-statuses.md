# ADR 0012: 「未完了」を完了集合以外の状態として、プロジェクトの状態一覧から決める

- 状態: 採用(2026-10-29。実環境 E2E で見つかった不具合の修正)
- 関連: ADR 0003(ページング)、ADR 0006(API 呼び出しの予算)、`src/analysis/statuses.ts`(完了集合)、`src/analysis/open-statuses.ts`

## 背景

`my_tasks` は未完了を状態 ID `[1,2,3]`、完了を ID `4` と決め打ちし、`issue_list` の `status_id=not-closed` も `[1,2,3]` だった(logvalet どおり)。
しかし状態 ID はプロジェクト・スペースで可変で、カスタム状態(例「レビュー待ち」、ID 5 以上)の課題がどちらにも出ない。ほかの分析ツールは名前の完了集合(完了 / 対応済み / Closed / Done / Resolved)で判定しており、定義が食い違っていた。

## 決定

未完了 = **完了集合に入らない名前の状態**。ID は固定せず、プロジェクトの状態一覧(`GET /projects/{key}/statuses`)から集める。状態 ID はスペース内で重複しうるので集合(挿入順)にする。

- `my_tasks`: 参加プロジェクト(`GET /projects?archived=false`)の状態一覧を 1 件ずつ引き、完了集合以外の ID を overdue / upcoming の `statusId[]` に渡す。watching は状態名が完了集合のものを除く。
  - プロジェクトは先頭 `MAX_STATUS_PROJECTS`(20)件まで。超えたら `truncated: true` と warning `status_projects_truncated`。
  - 一覧の取得失敗は warning(`projects_fetch_failed` / `statuses_fetch_failed`)で続ける。ID が 1 つも決まらなければ `statusId` を送らず、応答側で完了集合の課題を除いて補う(overdue / upcoming は常に応答側でも除く)。
  - `maxApiCalls` = GetMyself 1 + プロジェクト一覧 1 + 状態一覧 20 + overdue / upcoming / watching 各 10 ページ = **52**。
- `issue_list` の `status_id=not-closed`:
  - `project_key` / `project_keys` があればそのプロジェクトの状態一覧だけを引く(プロジェクト数は 20 まで。超えたら Backlog を呼ぶ前に `argument_error`)。
  - **プロジェクト指定なし**は参加プロジェクトすべて。20 を超えたら `argument_error`(`project_key` で絞るか数値の `status_id` を使うよう促す)。`issue_list` は Backlog の生の配列を返すので `truncated` / warning を載せる場所がなく、黙って一部の状態だけで絞るより、明示的に失敗させる。
  - 未完了の状態が 1 つもなければ(参加プロジェクトなし・全状態が完了集合)課題一覧を呼ばず空配列を返す。
  - 状態一覧の取得失敗はツールエラー(ID を決め打ちに戻さない)。
  - 最悪ケースの呼び出し: 指定ありは GetProject 20 + (assignee `me` の GetMyself 1)+ 状態一覧 20 + 課題 1 = 42、指定なしは 1 + 20 + 1(+1)= 23。いずれもクライアントの既定(50)以内なので `maxApiCalls` は明示しない。
  - 数値の `status_id`(CSV)はこれまでどおりそのまま渡す(状態一覧は引かない)。`exclude_status` を持つ他の分析ツールは変更なし。
- `status_id` の説明文を実態に合わせて変更した(logvalet の baseline との差分は `test/helpers/baseline.ts` の `ALLOWED_CHANGES`)。

## 却下した案

- ID `[1,2,3]` の決め打ちを残して「カスタム状態は数値で指定する」: 利用者(AI)が状態 ID を知る手間が増え、`my_tasks` には指定手段がない。
- 状態名の完了集合を使い、課題を全件取ってクライアント側で除く: 完了課題が大半を占めると 1,000 件の上限(ADR 0003)に先に達して未完了が漏れる。
