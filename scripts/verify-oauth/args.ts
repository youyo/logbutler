// verify:oauth の引数解析(Web 標準 API だけ。Node でも workerd のテストでも使える)。
export interface CliArgs {
  mcpUrl: string;
  refreshOnly: boolean;
  stateFile: string;
}

/** 保存先の既定。`.gitignore` 済み(`*.local.json`)で、リフレッシュトークンを含む。 */
export const DEFAULT_STATE_FILE = ".verify-oauth.local.json";

export const USAGE =
  "使い方: mise run verify:oauth -- <https://<domain>/mcp[?toolsets=...&read_only=true]> [--refresh-only] [--state-file <path>]";

function fail(message: string): never {
  throw new Error(`${message}\n${USAGE}`);
}

/** https、またはループバックのホストに限り http を許す。 */
export function isAllowedUrl(url: URL): boolean {
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return url.protocol === "https:" || (url.protocol === "http:" && loopback);
}

export function parseArgs(argv: string[]): CliArgs {
  let mcpUrl: string | undefined;
  let refreshOnly = false;
  let stateFile = DEFAULT_STATE_FILE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--refresh-only") {
      refreshOnly = true;
    } else if (arg === "--state-file") {
      const value = argv[++i];
      if (!value) fail("--state-file にはファイルパスが要ります");
      stateFile = value;
    } else if (arg.startsWith("--")) {
      fail(`未知のオプション ${arg}`);
    } else if (mcpUrl === undefined) {
      mcpUrl = arg;
    } else {
      fail(`引数が多すぎます: ${arg}`);
    }
  }
  if (!mcpUrl) fail("対象の MCP サーバーの URL を指定してください");

  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    return fail(`URL として読めません: ${mcpUrl}`);
  }
  if (!isAllowedUrl(url)) {
    fail("URL は https である必要があります(開発用の localhost だけ http 可)");
  }
  if (url.pathname !== "/mcp") fail("URL のパスは /mcp にしてください(例 https://<domain>/mcp)");
  return { mcpUrl, refreshOnly, stateFile };
}
