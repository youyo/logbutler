import { describe, expect, it } from "vitest";
import { DEFAULT_STATE_FILE, parseArgs } from "../../scripts/verify-oauth/args";

describe("verify:oauth の引数", () => {
  it("URL だけ渡すと、フル検証・既定の状態ファイル", () => {
    expect(parseArgs(["https://logbutler.example.com/mcp"])).toEqual({
      mcpUrl: "https://logbutler.example.com/mcp",
      refreshOnly: false,
      stateFile: DEFAULT_STATE_FILE,
    });
  });

  it("クエリ付き URL を受け取る", () => {
    expect(parseArgs(["https://h.example.com/mcp?toolsets=issue&read_only=true"]).mcpUrl).toBe(
      "https://h.example.com/mcp?toolsets=issue&read_only=true",
    );
  });

  it("--refresh-only と --state-file", () => {
    const args = parseArgs([
      "https://h.example.com/mcp",
      "--refresh-only",
      "--state-file",
      "x.json",
    ]);
    expect(args.refreshOnly).toBe(true);
    expect(args.stateFile).toBe("x.json");
  });

  it("既定の状態ファイルは .local.json(gitignore 済みの名前)", () => {
    expect(DEFAULT_STATE_FILE).toBe(".verify-oauth.local.json");
  });

  it.each([
    [[], /URL/],
    [["not a url"], /URL/],
    [["http://logbutler.example.com/mcp"], /https/],
    [["https://h.example.com/"], /\/mcp/],
    [["https://h.example.com/mcp", "--unknown"], /--unknown/],
    [["https://h.example.com/mcp", "--state-file"], /--state-file/],
  ])("不正な引数 %j はエラー", (argv, message) => {
    expect(() => parseArgs(argv as string[])).toThrow(message);
  });

  it("開発用に http://localhost の URL は許可する", () => {
    expect(parseArgs(["http://localhost:8787/mcp"]).mcpUrl).toBe("http://localhost:8787/mcp");
  });
});
