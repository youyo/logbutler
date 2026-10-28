# test/fixtures

## logvalet_tools_list_baseline.json

logvalet(`/Users/youyo/src/github.com/youyo/logvalet`)の `internal/mcp/testdata/tools_list_baseline.json` のコピー。
Logbutler のツール定義(description / inputSchema / annotations)が logvalet と食い違っていないかを
`test/helpers/baseline.ts` の `compareWithBaseline` で検証するために使う(実行時に logvalet は参照しない)。

- コピー元のコミット: `d389052f44a9ff7c2ff31f0c4b14a96980a3ad6e`(このファイルを最後に変更したコミット。コピー時の logvalet の HEAD は `97abadbd1ae9f1410cbd49444a54a2d7ef488af3`、作業ツリーに差分なし)
- SHA-256: `44f029e25b69ba4b7cc69d401dce33ba173f78da863c14aa905ca0044a5d1d3e`
- ツール数: 71(名前は `logvalet_` で始まる。比較時に `logbutler_` へ置換する)

更新するときは、コピー元のコミット ID と SHA-256 をここに書き直し、`mise run test` で差分を確認する。
