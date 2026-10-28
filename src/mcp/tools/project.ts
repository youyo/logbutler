import { z } from "zod";
import { showConventions } from "../../conventions/show";
import { optBool, reqStr, seg } from "../args";
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

export const projectConventions = defineTool({
  name: "logbutler_project_conventions",
  title: "運用規約取得",
  description: "Show the operating conventions adopted by a project (rule issue), with a glossary",
  category: "ReadOnly",
  toolset: "project",
  inputSchema: z.object({ project_key: reqStr("Project key") }),
  handler: ({ project_key }, { client }) => showConventions(client, project_key),
});

// Nulab 公式 MCP から取り込んだ。課題作成時の担当者・通知先の選定に使う。logvalet には無い。
export const projectUsers = defineTool({
  name: "logbutler_project_users",
  title: "プロジェクトメンバー一覧取得",
  description:
    "List the users who are members of a project (use it to choose an assignee or notification targets)",
  category: "ReadOnly",
  toolset: "project",
  inputSchema: z.object({
    project_key: reqStr("Project key (e.g. PROJECT)"),
    exclude_group_members: optBool("If true, exclude users who belong via a team (group) only"),
  }),
  handler: ({ project_key, exclude_group_members }, { client }) =>
    client.request("GET", `/projects/${seg(project_key)}/users`, {
      query: { excludeGroupMembers: exclude_group_members },
    }),
});
