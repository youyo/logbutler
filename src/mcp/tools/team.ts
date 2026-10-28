import { z } from "zod";
import { boundedCount, optBool, optInt, positiveOrUndefined, reqInt, reqStr, seg } from "../args";
import { defineTool } from "../registry";

interface TeamWithMembers {
  id: number;
  name: string;
}

export const teamList = defineTool({
  name: "logbutler_team_list",
  title: "チーム一覧取得",
  description: "List all teams in the space",
  category: "ReadOnly",
  toolset: "team",
  inputSchema: z.object({
    count: optInt("Max number of teams (max 100)"),
    offset: optInt("Offset for pagination"),
    no_members: optBool("If true, exclude member information from response"),
  }),
  handler: async ({ count, offset, no_members }, { client }) => {
    const teams = await client.request<TeamWithMembers[]>("GET", "/teams", {
      query: { count: boundedCount("count", count), offset: positiveOrUndefined(offset) },
    });
    // 加工ではなく絞り込みなので、残すキーは Backlog のまま。
    return no_members ? teams.map((t) => ({ id: t.id, name: t.name })) : teams;
  },
});

export const teamGet = defineTool({
  name: "logbutler_team_get",
  title: "チーム詳細取得",
  description: "Get team details by team ID",
  category: "ReadOnly",
  toolset: "team",
  inputSchema: z.object({ team_id: reqInt("Team ID (numeric)") }),
  handler: ({ team_id }, { client }) => client.request("GET", `/teams/${seg(team_id)}`),
});

export const teamProject = defineTool({
  name: "logbutler_team_project",
  title: "プロジェクトチーム一覧取得",
  description: "List teams for a specific project",
  category: "ReadOnly",
  toolset: "team",
  inputSchema: z.object({ project_key: reqStr("Project key") }),
  handler: ({ project_key }, { client }) =>
    client.request("GET", `/projects/${seg(project_key)}/teams`),
});
