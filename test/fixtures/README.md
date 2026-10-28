# test/fixtures

## logvalet_tools_list_baseline.json

logvalet(`/Users/youyo/src/github.com/youyo/logvalet`)の `internal/mcp/testdata/tools_list_baseline.json` のコピー。
Logbutler のツール定義(description / inputSchema / annotations)が logvalet と食い違っていないかを
`test/helpers/baseline.ts` の `compareWithBaseline` で検証するために使う(実行時に logvalet は参照しない)。

- コピー元のコミット: `d389052f44a9ff7c2ff31f0c4b14a96980a3ad6e`(このファイルを最後に変更したコミット。コピー時の logvalet の HEAD は `97abadbd1ae9f1410cbd49444a54a2d7ef488af3`、作業ツリーに差分なし)
- SHA-256: `44f029e25b69ba4b7cc69d401dce33ba173f78da863c14aa905ca0044a5d1d3e`
- ツール数: 71(名前は `logvalet_` で始まる。比較時に `logbutler_` へ置換する)

更新するときは、コピー元のコミット ID と SHA-256 をここに書き直し、`mise run test` で差分を確認する。

## conventions_skeleton.yaml

logvalet の `internal/conventions/testdata/skeleton.golden.yaml` のコピー(conventions の YAML 見本。`src/conventions/load.ts` のパース結果を固定するテストの入力)。

- コピー元のコミット: `f88a5f19287049446c74d70b88bb0cbf351a52f1`(このファイルを最後に変更したコミット。コピー時の logvalet の HEAD は `97abadbd1ae9f1410cbd49444a54a2d7ef488af3`)
- SHA-256: `b8e1b0d6226048b0d1deecc9d0bb9b2d8500ad061667582a4c8d25fb7163b99b`

他のテスト入力(`{unknown field}` など)は logvalet の `internal/conventions/load_test.go` `show_test.go` `engagement_test.go` の文字列を流用している。
