# ADR 0016: 状態一覧のキャッシュと上限の引き上げ・issue_list の要約形式・課題削除ツール

- 状態: 採用(2026-11-02。GitHub issue #2「動作確認のフィードバック」への対応)
- 関連: ADR 0003(直列・呼び出し回数)、ADR 0004(出力形式)、ADR 0005(KV の冪等キャッシュ)、ADR 0006(`maxApiCalls`)、ADR 0007(応答サイズ)、ADR 0012(未完了の状態を状態一覧から決める。**本 ADR が上限の数値を更新する**)

## 背景

参加プロジェクトが 20 を超えるスペースでの動作確認で、次の 3 点が報告された。

1. `my_tasks` は状態一覧を先頭 20 プロジェクト分しか引かず(`status_projects_truncated`)、`issue_list` の `status_id=not-closed` はプロジェクト指定なしで 20 を超えると `argument_error` になる。参加プロジェクトが多い利用者は `not-closed` を実質使えない。
2. `issue_list` は Backlog の課題オブジェクトをそのまま返すため(ユーザー情報の繰り返し・description 全文)、少ない件数でも応答が大きく `response_too_large`(ADR 0007)になりやすい。
3. 課題を削除するツールがない(logvalet にもない)。

## 決定

### 1. 状態一覧を KV に短時間キャッシュし、上限を 100 プロジェクトに上げる

- `MAX_STATUS_PROJECTS` を **20 → 100**。`my_tasks` の truncated / warning、`issue_list` の `argument_error`(指定あり・なしとも)の意味は変えず、閾値だけ上げる。
- 状態一覧(`GET /projects/:key/statuses` の `{id, name}` だけ)を `OAUTH_KV` の **`statuses:<backlogUserId>`** に 1 ユーザー 1 値の JSON で置く(ADR 0005 と同じ namespace・接頭辞方式)。値はプロジェクトキー → `{ fetched_at, statuses: [{id, name}] }`。
  - **鮮度は 600 秒**。`fetched_at` が 600 秒より古いプロジェクトは未取得として Backlog から引き直す(KV の TTL だけに頼ると、書き足すたびに古い項目の寿命が延びるため)。KV の `expirationTtl` も 600 秒にする。
  - 1 回のツール呼び出しで KV の読み取りは 1 回、書き込みは Backlog から引いたプロジェクトがあったときだけ 1 回。
  - キーに Backlog のユーザー ID を含める。参加していないプロジェクトの状態名が、別ユーザーのキャッシュ経由で見えないようにするため。値に Backlog のトークン・クライアント情報は含めない。
  - KV の読み書きの失敗・壊れた値はツールを止めない(キャッシュなしとして続ける。ADR 0005 と同じ)。
  - 状態の追加・変更直後は最大 600 秒古い一覧で判定しうる。`status_add` / `status_update` / `status_delete`(ADR 0013)が成功したら、そのユーザーのキャッシュ値を削除する(自分の変更はすぐ反映する。他人の変更は 600 秒以内に反映)。
- 呼び出し回数(キャッシュが空の最悪ケース):
  - `my_tasks`: GetMyself 1 + プロジェクト一覧 1 + 状態一覧 100 + overdue / upcoming / watching 各 10 ページ = **132**。
  - `issue_list`: GetProject 100 + GetMyself 1 + 状態一覧 100 + 子の収集 2 + 一覧 1 = **204**(指定なしはプロジェクト一覧 1 + 状態一覧 100 + … でこれより小さい)。
  - Workers の有料プランの subrequest 上限は既定 10,000(2026-02 の Cloudflare changelog。KV も subrequest に数える)なので収まる。無料プラン(50)では超えうるが、分析ツールと同じく有料プランを前提にする(ADR 0006)。
- 実時間: キャッシュが空のとき 100 回の直列呼び出しで数十秒かかりうる。2 回目以降(600 秒以内)はほぼ KV の 1 回で済む。実機の所要時間は [manual-verification](../manual-verification.md) の V17 で確かめる。

### 2. issue_list に `detail`(`full` / `summary`)を足す

- 省略時は **`full`**(これまでどおり Backlog の生の配列。ADR 0004・logvalet 互換)。既定は変えない。
- `summary` は `analysisEnvelope`(`schema_version` 付き。resource `issue_list`)で、`analysis` は `{ count, issues: [...] }`。各課題は snake_case の要約:
  `id`・`issue_key`・`project_key`・`summary`・`issue_type`・`status`・`priority`・`assignee`(名前。なければ null)・`start_date`・`due_date`・`parent_issue_id`・`created`・`updated`。
  description は含めない(本文は `issue_get` で取る)。「先頭 N 文字に切り詰める」引数は足さない(引数を増やすより、要約と全文の 2 段にする方が使い分けが明確)。
- 副次効果として、`summary` ではエンベロープに `warnings` の置き場ができる(ADR 0012 の「issue_list には warning を載せる場所がない」)。今回は使わない。
- 引数の追加は logvalet の baseline との差分なので、`test/helpers/baseline.ts` に理由つきで足す。

### 3. `logbutler_issue_delete` を足す

- `DELETE /api/v2/issues/:issueIdOrKey`。`category: "Destructive"`、toolset `issue`(`read_only=true` で隠れる)。
- **確認用の引数 `confirm_issue_key` を必須**にし、`issue_key` と完全一致しなければ Backlog を呼ぶ前に `argument_error`。ほかの Destructive ツール(添付・関連・カテゴリーなど)には確認引数がないが、課題は復元できずコメント・添付・子課題との関係もまとめて失われるため、課題の削除だけ二重の指定を求める。
- 応答は Backlog の生データ(削除された課題)。
- `test:live` の後片付けへの組み込みは今回はしない(実 Backlog への書き込みはユーザーの許可が要るため)。README の「削除するツールがないため」の文言は事実に合わせて直す。

## 却下した案

- 状態一覧を引かず、課題の状態名を完了集合と照合して除外する: ADR 0012 の却下理由のとおり、完了課題が多いと 1,000 件の上限(ADR 0003)に先に当たり未完了が漏れる。
- プロジェクトごとに KV のキーを分ける: 100 プロジェクトなら KV の読み取りが 100 回になり、キャッシュが外れたときの遅延が Backlog を引くのと大差なくなる。
- キャッシュのキーを grant 単位にする: 同じ利用者が複数クライアントで接続したときに共有できない。参加プロジェクトの範囲はユーザー単位なので、ユーザー ID で十分。
- `issue_list` の既定を `summary` にする: logvalet 互換と既存の利用者の期待を崩す。
