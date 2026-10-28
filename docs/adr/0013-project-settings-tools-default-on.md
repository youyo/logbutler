# ADR 0013: プロジェクト設定ツールを既定公開で追加する(M06 の判断を覆す)

- 状態: 採用(2026-10-29。ユーザー決定)
- 関連: ADR 0004(出力・エラー形式)、ADR 0008(toolsets / read_only は URL クエリ)、`src/mcp/tools/project-settings.ts`

## 背景

M06 では Nulab 公式 MCP から取り込む機能を絞り、「プロジェクト等の編集」は取り込まなかった。理由は「ツール数が増えると AI のツール選択が鈍る」ことと、管理者権限が要る操作を AI に渡す価値が薄いと見たこと。
その後、ユーザーが **カテゴリー・発生バージョン/マイルストーン・状態(ステータス)・カスタム属性の追加・更新・削除** を MCP から行いたいと決めた。

## 決定

- `project_settings` という新しい toolset に 12 個を追加する: `category_*` / `version_*` / `status_*` / `custom_field_*` の `add` / `update` / `delete`。
- **既定の `toolsets=all` に含めて公開する**。`read_only=true` では隠す(`add` は非冪等の書き込み、`update` は冪等の書き込み、`delete` は破壊的の区分なので、既存の `read_only` の仕組みでそのまま隠れる。呼び出しも「ツールが見つからない」になり実行されない)。
- ツール数は 74 から 86 になる。ツール選択への影響は、必要なら `toolsets` で絞るか `read_only=true` で隠すことで利用者が制御できる(ADR 0008)。M06 の「増やさない」は、この制御手段を前提に覆した。
- 仕様は Backlog API の公式 docs に従う。Logbutler 側でも、必須の欠落・色の範囲・型ごとに無効なカスタム属性の引数の組み合わせは Backlog を呼ぶ前に `argument_error` にする。
- 出力は Backlog の生データ(camelCase)。管理者権限がなければ Backlog の 403 が `permission_error` になる(既存どおり)。
- 状態の追加は `color` が必須で、docs にある 10 色だけを受け付ける。状態の削除は `substitute_status_id` が必須。

## 未確定の点(docs から読み取れず、推測しなかった)

- カスタム属性のリスト型の引数(`items` `allowInput` `allowAddItem`)が、どの typeId に効くか。docs は「List」とだけ書く。Logbutler は 5〜8(単一/複数リスト・チェックボックス・ラジオ)に限って受け付ける。リスト型で `items` が必須かも不明で、強制しない。
- カスタム属性の更新で、型の変更や型に合わない引数の扱い。更新 API は typeId を取らないため、Logbutler は型を知れず、型別の引数が 1 つの型の分(数値 / 日付 / リスト)に収まっていることだけを検証する。
- `applicable_issue_type_ids` を空にして「全課題種別」に戻す操作は、更新で表現できない(配列が空だと何も送られない)ため、空は `argument_error`。追加では省略で全種別。
- 日付型の初期値(`initial_value_type` と `initial_date` / `initial_shift` の対応)は docs の説明(1 今日、2 今日 + 差分、3 指定日)から、対応する引数の必須・不一致を検証する。
- 状態の更新で `name` と `color` のどちらが必須か(docs は明記なし)。Logbutler は少なくとも 1 つを要求し、片方だけでも送る。カテゴリーの更新は `name` を必須にしている。
- 状態の数の上限(標準 4 + カスタム 8)を超えたときのエラー、`name` の長さ・重複の制約。Logbutler は検証せず Backlog の応答に任せる。名前の長さ上限は docs になく変わりうるため src に長さ検証を入れない(2026-10-29 の実測値は docs/manual-verification.md の「名前の長さ上限(実測)」)。
- 削除系の副作用(カテゴリー・バージョン・カスタム属性を使っている課題の扱い)。docs に記述がない。

## 対象外

- カスタム属性のリスト項目の追加・更新・削除(項目単位のエンドポイント)。`custom_field_add` の初期 `items` までにとどめ、`custom_field_update` は `items` を受け付けない。
- 課題種別・優先度・完了理由・プロジェクト自体の編集。

## 却下した案

- 既定では非公開にして `toolsets=project_settings` で明示的に有効にする: ユーザーが「既定で公開」と決めた。
- 破壊的操作に確認引数を足す: MCP クライアント側の annotation(`destructiveHint`)で確認を促す既存の流儀に合わせた。

## 実機確認

実 Backlog での挙動は `test/live/suites/project-settings.ts`(`mise run test:live`)で確かめる。スイート自身が作ったもの(名前に `[live <時刻>]`)だけを対象に add → 読み戻し → update → 読み戻し → delete → 消えたことを確認し、失敗時も後片付けする。管理者権限が必要。
