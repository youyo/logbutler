import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_DOWNLOAD_BYTES, toBase64 } from "../../src/mcp/tools/download";

afterEach(() => vi.restoreAllMocks());

const bytes = (...b: number[]) => new Uint8Array(b);

describe("toBase64", () => {
  it("既知の値(RFC 4648 のテストベクタ)と同じ出力", () => {
    const enc = new TextEncoder();
    expect(toBase64(new Uint8Array(0))).toBe("");
    expect(toBase64(enc.encode("f"))).toBe("Zg==");
    expect(toBase64(enc.encode("fo"))).toBe("Zm8=");
    expect(toBase64(enc.encode("foo"))).toBe("Zm9v");
    expect(toBase64(enc.encode("foob"))).toBe("Zm9vYg==");
    expect(toBase64(bytes(0, 255, 128, 1, 2))).toBe(btoa("\x00\xff\x80\x01\x02"));
  });

  it("チャンク境界をまたぐ長さでも、1 回で変換した結果と同じ", () => {
    for (const n of [0x8000 - 1, 0x8000, 0x8000 + 1, 100_003, 3 * 40_000 + 2]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      let reference = "";
      for (const b of data) reference += String.fromCharCode(b);
      expect(toBase64(data), `n=${n}`).toBe(btoa(reference));
    }
  });

  it("20 MiB(最大ケース)でも、btoa に渡す文字列は小さな塊だけ(ピークのメモリを抑える)", () => {
    const seen: number[] = [];
    const realBtoa = globalThis.btoa;
    vi.spyOn(globalThis, "btoa").mockImplementation((s: string) => {
      seen.push(s.length);
      return realBtoa(s);
    });
    const data = new Uint8Array(MAX_DOWNLOAD_BYTES).map((_, i) => (i * 131 + 3) & 0xff);
    const out = toBase64(data);
    expect(out).toHaveLength(Math.ceil(MAX_DOWNLOAD_BYTES / 3) * 4);
    // 1 MiB を超える巨大なバイナリ文字列を一度に作らない。
    expect(Math.max(...seen)).toBeLessThanOrEqual(1024 * 1024);
    // 3 バイトの倍数ずつ変換するので、パディングは最後の塊にしか出ない。
    expect(out.slice(0, 8)).toBe(realBtoa(String.fromCharCode(...data.subarray(0, 6))));
    vi.restoreAllMocks();
    const back = atob(out);
    expect(back.length).toBe(MAX_DOWNLOAD_BYTES);
    expect(back.charCodeAt(12345)).toBe(data[12345]);
    expect(back.charCodeAt(MAX_DOWNLOAD_BYTES - 1)).toBe(data[MAX_DOWNLOAD_BYTES - 1]);
  });
});
