// ADR 0018 の前提: R2 の条件付き put(「存在しなければ」と etagMatches)が、同時に走っても 1 本だけ通ること。
// 添付アップロードの状態(claim)は削除せず、すべての遷移を条件付き put で行うため、ここが崩れると二重実行を防げない。
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

function bucket(): R2Bucket {
  const b = (env as unknown as { UPLOAD_BUCKET?: R2Bucket }).UPLOAD_BUCKET;
  if (!b) throw new Error("UPLOAD_BUCKET の binding がない(wrangler.jsonc の r2_buckets)");
  return b;
}

/** 条件なしの put(型の上は null になりうるので、null なら失敗にする)。 */
async function putPlain(key: string, value: string): Promise<R2Object> {
  const obj = await bucket().put(key, value);
  if (!obj) throw new Error("条件なしの put が null を返した");
  return obj;
}

const ifAbsent = () => new Headers({ "If-None-Match": "*" });
const uniqueKey = (prefix: string) => `${prefix}/${crypto.randomUUID()}`;

describe("R2 の条件付き put(miniflare)", () => {
  it("If-None-Match: * は、無いときだけ書ける(2 回目は null)", async () => {
    const key = uniqueKey("test-absent");
    const first = await bucket().put(key, "a", { onlyIf: ifAbsent() });
    expect(first).not.toBeNull();
    const second = await bucket().put(key, "b", { onlyIf: ifAbsent() });
    expect(second).toBeNull();
    expect(await (await bucket().get(key))?.text()).toBe("a");
  });

  it("If-None-Match: * を同時に 10 本送ると、通るのは 1 本だけ", async () => {
    const key = uniqueKey("test-absent-race");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => bucket().put(key, `v${i}`, { onlyIf: ifAbsent() })),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("etagMatches は一致するときだけ書け、書いた後は古い etag では書けない", async () => {
    const key = uniqueKey("test-etag");
    const created = await putPlain(key, "v1");
    const updated = await bucket().put(key, "v2", { onlyIf: { etagMatches: created.etag } });
    expect(updated).not.toBeNull();
    const stale = await bucket().put(key, "v3", { onlyIf: { etagMatches: created.etag } });
    expect(stale).toBeNull();
    expect(await (await bucket().get(key))?.text()).toBe("v2");
  });

  it("同じ etag を前提にした put を同時に 10 本送ると、通るのは 1 本だけ", async () => {
    const key = uniqueKey("test-etag-race");
    const created = await putPlain(key, "v0");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        bucket().put(key, `next-${i}`, { onlyIf: { etagMatches: created.etag } }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("同じ本文を書き直すと etag が同じになる(claim の本文に試行ごとの乱数を入れる理由)", async () => {
    // etag は内容のハッシュ(単発の put)。時刻が同じだと claimed → released → claimed で etag が元に戻り、
    // 古い処理の etagMatches が通ってしまう。claim の本文の nonce で防ぐ(ADR 0018)。
    const key = uniqueKey("test-etag-same");
    const a = await putPlain(key, "same");
    const b = await putPlain(key, "same");
    expect(b.etag).toBe(a.etag);
    const c = await putPlain(key, "different");
    expect(c.etag).not.toBe(a.etag);
  });
});
