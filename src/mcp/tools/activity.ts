import { z } from "zod";
import { ArgumentError } from "../../errors";
import { boundedCount, optInt, optStr, parseCsvInts, resolveUserId, seg } from "../args";
import { defineTool } from "../registry";

const DEFAULT_COUNT = 20;

export const activityList = defineTool({
  name: "logbutler_activity_list",
  title: "アクティビティ一覧取得",
  description: "List activities by scope (space, project, or user)",
  category: "ReadOnly",
  toolset: "activity",
  inputSchema: z.object({
    user_id: optStr("User ID or 'me' for current user"),
    project_key: optStr("Project key"),
    count: optInt("Max number of activities (default 20, max 100)"),
    activity_type_ids: optStr("Comma-separated activity type IDs to filter"),
    order: optStr("Sort order: asc or desc (default: desc)"),
  }),
  handler: async (a, { client }) => {
    if (a.user_id && a.project_key) {
      throw new ArgumentError("user_id and project_key are mutually exclusive");
    }
    const query = {
      activityTypeId: parseCsvInts("activity_type_ids", a.activity_type_ids) ?? [],
      count: boundedCount("count", a.count) ?? DEFAULT_COUNT,
      order: a.order || undefined,
    };
    if (a.user_id) {
      const userId = await resolveUserId(client, a.user_id);
      return client.request("GET", `/users/${seg(userId)}/activities`, { query });
    }
    if (a.project_key) {
      return client.request("GET", `/projects/${seg(a.project_key)}/activities`, { query });
    }
    return client.request("GET", "/space/activities", { query });
  },
});
