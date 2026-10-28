/** document_search / search の snippet(logvalet `internal/digest/document_search_test.go` の ES1〜ES6 から書き起こし)。 */
import { describe, expect, it } from "vitest";
import { extractSnippet, SNIPPET_RADIUS } from "../../src/analysis/snippet";

const cps = (s: string) => [...s].length;
const pad = (n: number, ch = "x") => ch.repeat(n);

describe("extractSnippet", () => {
  it("ES1: keyword の前後 ±100 コードポイントを切り出す(中央ヒット)", () => {
    const plain = `${pad(120)}hello${pad(120)}`;
    const got = extractSnippet(plain, "hello");
    expect(got).toContain("hello");
    // アンカー位置 120 から start=20、end=220(Go と同じく end は anchor + radius で keyword の長さを足さない)
    expect(got).toBe(plain.slice(20, 220));
    expect(cps(got)).toBe(SNIPPET_RADIUS * 2);
  });

  it("ES2: 日本語 keyword をコードポイント単位で切り出す(plain 222 コードポイント → 200 以内)", () => {
    const prefix = Array.from({ length: 110 }, (_, i) =>
      String.fromCodePoint(0x3042 + (i % 46)),
    ).join("");
    const plain = `${prefix}認証${prefix}`;
    const got = extractSnippet(plain, "認証");
    expect(got).toContain("認証");
    expect(cps(got)).toBeLessThan(cps(plain));
    expect(cps(got)).toBeLessThanOrEqual(SNIPPET_RADIUS * 2);
  });

  it("サロゲートペア(𠮷 や絵文字)を途中で割らない", () => {
    // UTF-16 の長さでは 300 だが、コードポイントでは 150 → 全体が 200 以下なので全文を返す
    const plain = "𠮷".repeat(150);
    expect(extractSnippet(plain, "𠮷")).toBe(plain);
    // 250 コードポイント。先頭 200 コードポイントをそのまま返す(UTF-16 で 400 単位)
    const long = "𠮷".repeat(250);
    const got = extractSnippet(long, "zzz");
    expect(cps(got)).toBe(200);
    expect(got).toBe("𠮷".repeat(200));
    // アンカーが絵文字の直後にあっても、切り出しの境界でペアを割らない
    const mixed = `${"😀".repeat(150)}KEY${"😀".repeat(150)}`;
    const snip = extractSnippet(mixed, "key");
    expect(snip).toContain("KEY");
    expect(snip).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it("ES3: 大文字小文字を区別しない('oauth' で 'OAuth' にマッチ)", () => {
    const plain = `${pad(150)}ここで OAuth トークンを使います${pad(150)}`;
    expect(extractSnippet(plain, "oauth")).toContain("OAuth");
  });

  it("小文字化で長さが変わる文字(İ)があっても、アンカーの位置がずれない", () => {
    // 'İ'.toLowerCase() は 2 コードポイント('i' + 結合ドット)。1:1 を保つため元のまま比べる
    const plain = `${"İ".repeat(150)}target${pad(150)}`;
    const got = extractSnippet(plain, "TARGET");
    expect(got).toContain("target");
    const at = 150; // target の開始コードポイント
    expect([...plain].slice(at - SNIPPET_RADIUS, at + SNIPPET_RADIUS).join("")).toBe(got);
  });

  it("ES4: keyword が空なら先頭 200 コードポイントのリード抜粋", () => {
    expect(cps(extractSnippet(pad(300), ""))).toBe(200);
  });

  it("ES4b: keyword がヒットしなければ先頭 200 コードポイントのリード抜粋", () => {
    const plain = `${pad(300)}`;
    expect(extractSnippet(plain, "zzz")).toBe(plain.slice(0, 200));
  });

  it("ES5: 複数語はキーワード文字列の先頭語から順に探し、最初にヒットした語をアンカーにする(テキストの出現順ではない)", () => {
    const plain = `${pad(110)}beta${pad(110)}alpha${pad(10)}`;
    const got = extractSnippet(plain, "alpha beta");
    expect(got).toContain("alpha");
    expect(got).not.toContain("beta");
    // 先頭語がヒットしなければ次の語
    expect(extractSnippet(plain, "zzz beta")).toContain("beta");
  });

  it("ES6: plain が 200 コードポイント以下なら全文", () => {
    expect(extractSnippet("短い本文", "本文")).toBe("短い本文");
    const exactly200 = pad(200);
    expect(extractSnippet(exactly200, "nope")).toBe(exactly200);
  });

  it("アンカーが先頭・末尾に近いときは範囲を端で止める", () => {
    const head = `key${pad(300)}`;
    expect(extractSnippet(head, "key")).toBe(head.slice(0, 100));
    const tail = `${pad(300)}key`;
    expect(extractSnippet(tail, "key")).toBe(tail.slice(200));
  });

  it("タブ区切りの複数語、空の語は無視する", () => {
    const plain = `${pad(150)}needle${pad(150)}`;
    expect(extractSnippet(plain, "  \t needle ")).toContain("needle");
  });
});
