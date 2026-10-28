import { McpServer } from "@modelcontextprotocol/server";
import { registerUserMe, type UserMeDeps } from "./tools/user-me";

export type McpServerDeps = UserMeDeps;

/** リクエストごとに生成する(createMcpHandler の要件。同時リクエスト間で状態を共有しない)。 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: "logbutler", version: "0.1.0" });
  registerUserMe(server, deps);
  return server;
}
