# ADR 0007: 応答サイズの上限(最後の安全網)

> ダウンロード 20 MiB の実機確認は [docs/manual-verification.md](../manual-verification.md) の V10。

- 状態: 採用(M06、2026-10-28)
- 関連: ADR 0004(出力とエラー)、ADR 0006(上限つき取得)、ADR 0008(フラグのクライアント制御)

## 背景

一覧系のツールは、条件によっては非常に大きな JSON を返す。AI のコンテキストを溢れさせると、以降のやり取りが壊れる。
M05 の上限つき取得(ページ数の上限と `truncated`)が一次の対策で、これはその外側の最後の安全網である。

## 決定

- 読み取りツール(ReadOnly)にツール引数 `max_response_tokens`(任意の整数)を付ける。省略時はコード内の定数
  `DEFAULT_MAX_RESPONSE_TOKENS` = 50000、`0` で無効、負の値は `argument_error`(Backlog を呼ぶ前に検証する)。
  環境変数にはしない(フラグはクライアントが決める。ADR 0008)。
- **切り詰めない**。応答 JSON の推定サイズが上限を超えたら、`isError: true` で `response_too_large`(`retryable: false`)の
  エンベロープを返す。message に推定サイズ・上限・絞り込みの手がかり(`count` / `offset` / 期間 / `project_key`、`max_response_tokens`)を入れる。
- 数え方は近似: 応答 JSON 文字列について、ASCII は 4 文字 1 トークン(切り上げ)、ASCII 以外(日本語など)は 1 文字 1 トークン。
  実際のトークナイザの値ではなく桁を外さないための目安である。計画書の例(`文字列の長さ / 4`)だと、日本語の多い Backlog の
  データを 2〜4 倍過小に見積もるため、ASCII 以外を 1 文字 1 トークンにした。
- 対象外:
  - ダウンロード系(`issue_attachment_download` / `shared_file_download`)。ファイルサイズの上限(20 MiB)が別にある。
    `defineTool` の `responseLimit: false` で外す。
  - 書き込み・破壊的ツール(WriteIdempotent / WriteNonIdempotent / Destructive)。引数も付けない。書き込みが成功したあとで
    応答が大きいことをエラーにすると、実行済みの書き込みが失敗に見え、再実行で二重に書き込まれる。
  - エラーエンベロープ。
- 冪等キャッシュ(ADR 0005)との関係は上記のとおり、書き込みの応答には上限をかけないので影響しない。

## 帰結

- 読み取りツール 58 個(logvalet にもある 55 個と、M06 の 3 個)の `inputSchema` に `properties.max_response_tokens` が増える。
  logvalet の baseline との差分としては `ALLOWED_CHANGES` に理由つきで載せ、`tools-list-snapshot.test.ts` が差分を
  この 1 プロパティの追加だけに固定している。
- 上限つき取得の最悪ケース(例: `issue_stale` のプロジェクト 5 つ × 1,000 件)は、既定の 50000 を超えて `response_too_large` になりうる。
  その場合は `project_keys` を減らす、`max_response_tokens` を上げる(0 で無効)。呼び出し回数を調べる既存のテストは `max_response_tokens: 0` を付けている。
- エラーコードに `response_too_large` を加えた(ADR 0004 の表)。
