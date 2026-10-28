import { z } from "zod";
import { defineTool } from "../registry";

export const spaceInfo = defineTool({
  name: "logbutler_space_info",
  title: "スペース情報取得",
  description: "Get information about the Backlog space",
  category: "ReadOnly",
  toolset: "space",
  inputSchema: z.object({}),
  handler: (_args, { client }) => client.request("GET", "/space"),
});

export const spaceDiskUsage = defineTool({
  name: "logbutler_space_disk_usage",
  title: "スペースディスク使用量取得",
  description: "Get disk usage information for the Backlog space",
  category: "ReadOnly",
  toolset: "space",
  inputSchema: z.object({}),
  handler: (_args, { client }) => client.request("GET", "/space/diskUsage"),
});
