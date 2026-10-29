import { describe, expect, it } from "vitest";
import { browserCommand } from "../../scripts/verify-oauth/browser";

describe("verify:oauth のブラウザ起動コマンド", () => {
  it("win32 は cmd を使わず、& を含む URL をそのまま 1 引数で渡す", () => {
    const url = "https://example.com/authorize?a=1&client_id=x&calc";
    const [cmd, args] = browserCommand(url, "win32");
    expect(cmd).not.toMatch(/cmd/i);
    expect(args).toEqual(["url.dll,FileProtocolHandler", url]);
  });

  it("darwin は open、それ以外は xdg-open", () => {
    expect(browserCommand("https://example.com/a", "darwin")).toEqual([
      "open",
      ["https://example.com/a"],
    ]);
    expect(browserCommand("http://localhost:1/a", "linux")).toEqual([
      "xdg-open",
      ["http://localhost:1/a"],
    ]);
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/", "not a url"])(
    "http(s) 以外・不正な URL は例外: %s",
    (url) => {
      for (const p of ["darwin", "win32", "linux"] as const) {
        expect(() => browserCommand(url, p)).toThrow();
      }
    },
  );
});
