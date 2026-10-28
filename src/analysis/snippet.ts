/**
 * document_search / search の snippet(logvalet `internal/digest/document_search.go` の `extractSnippet`)。
 * Go の rune に合わせ、文字数は UTF-16 の長さではなく**コードポイント**で数える(サロゲートペアを割らない)。
 */

export const SNIPPET_RADIUS = 100;

/**
 * 1 コードポイントずつ小文字にする。Go の `unicode.ToLower` は 1:1 だが、JS の `toLowerCase` は
 * `İ` のように 2 コードポイントになる文字がある。その文字は元のままにして、位置が 1:1 のままずれないようにする。
 */
const lowerCodePoint = (ch: string): string => {
  const lower = ch.toLowerCase();
  return [...lower].length === 1 ? lower : ch;
};
const lowerAll = (text: string): string => [...text].map(lowerCodePoint).join("");

/** keyword を空白(半角スペースとタブ)で分け、空の語を除く。 */
const splitKeyword = (keyword: string): string[] => keyword.split(/[ \t]+/).filter((w) => w !== "");

/**
 * plain から keyword 周辺 ±100 コードポイントを切り出す。
 * - plain が 200 コードポイント以下なら全文
 * - keyword が空、またはどの語もヒットしなければ先頭 200 コードポイント
 * - 複数語は keyword の先頭の語から順に探し、最初にヒットした語をアンカーにする
 */
export function extractSnippet(plain: string, keyword: string): string {
  const points = [...plain];
  const total = points.length;
  const window = SNIPPET_RADIUS * 2;
  if (total <= window) return plain;
  if (keyword === "") return points.slice(0, window).join("");

  const haystack = lowerAll(plain);
  let anchor = -1;
  for (const word of splitKeyword(keyword)) {
    const at = haystack.indexOf(lowerAll(word));
    if (at >= 0) {
      // UTF-16 の位置をコードポイントの位置にする
      anchor = [...haystack.slice(0, at)].length;
      break;
    }
  }
  if (anchor < 0) return points.slice(0, window).join("");

  const start = Math.max(0, anchor - SNIPPET_RADIUS);
  const end = Math.min(total, anchor + SNIPPET_RADIUS);
  return points.slice(start, end).join("");
}
