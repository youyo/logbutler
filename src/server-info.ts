/**
 * サーバー名とバージョン(1 か所。ADR 0019)。MCP の serverInfo(src/mcp/server.ts)と、feedback ツールの
 * 案内(src/feedback/)の両方がこれを読む。package.json の name / version と一致することはテストで確かめる。
 */
export const SERVER_NAME = "logbutler";
export const SERVER_VERSION = "0.1.0";
