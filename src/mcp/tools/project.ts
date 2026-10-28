import { z } from "zod";
import { reqStr, seg } from "../args";
import { defineTool } from "../registry";

export const projectGet = defineTool({
  name: "logbutler_project_get",
  title: "プロジェクト詳細取得",
  description: "Get project details by project key",
  category: "ReadOnly",
  toolset: "project",
  inputSchema: z.object({ project_key: reqStr("Project key (e.g. PROJECT)") }),
  handler: ({ project_key }, { client }) => client.request("GET", `/projects/${seg(project_key)}`),
});

export const projectList = defineTool({
  name: "logbutler_project_list",
  title: "プロジェクト一覧取得",
  description: "List all projects in the space",
  category: "ReadOnly",
  toolset: "project",
  inputSchema: z.object({}),
  handler: (_args, { client }) => client.request("GET", "/projects"),
});
