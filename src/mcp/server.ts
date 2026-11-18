import { McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION } from "../server-info";
import { type RegisterDeps, registerTools, type ToolConfig, type ToolDefinition } from "./registry";
import { ALL_TOOLS } from "./tools";

export interface McpServerDeps extends RegisterDeps {
  /** toolset と読み取り専用の設定。省略時はすべて有効。 */
  toolConfig?: ToolConfig;
  /** テスト用。省略時は ALL_TOOLS。 */
  tools?: readonly ToolDefinition[];
}

/** リクエストごとに生成する(createMcpHandler の要件。同時リクエスト間で状態を共有しない)。 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(
    server,
    deps.tools ?? ALL_TOOLS,
    deps.toolConfig ?? { toolsets: "all", readOnly: false },
    deps,
  );
  return server;
}
