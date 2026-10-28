import { z } from "zod";
import {
  boundedCount,
  optInt,
  optStr,
  positiveOrUndefined,
  reqInt,
  reqStr,
  resolveUserId,
  seg,
} from "../args";
import { defineTool } from "../registry";

export const watchingList = defineTool({
  name: "logbutler_watching_list",
  title: "ウォッチ一覧取得",
  description: "List watchings for a user. Returns issues being watched by the specified user.",
  category: "ReadOnly",
  toolset: "watching",
  inputSchema: z.object({
    user_id: reqStr('User ID: "me" (resolved via GetMyself) or numeric user ID (e.g. "12345")'),
    count: optInt("Max number of items (default: 20, max: 100)"),
    offset: optInt("Offset for pagination (default: 0)"),
    order: optStr("Sort order: asc or desc (default: desc)"),
    sort: optStr("Sort key: created, updated, or issueUpdated"),
  }),
  handler: async ({ user_id, count, offset, order, sort }, { client }) => {
    const id = await resolveUserId(client, user_id);
    return client.request("GET", `/users/${seg(id)}/watchings`, {
      query: {
        count: boundedCount("count", count),
        offset: positiveOrUndefined(offset),
        order: order || undefined,
        sort: sort || undefined,
      },
    });
  },
});

export const watchingGet = defineTool({
  name: "logbutler_watching_get",
  title: "ウォッチ詳細取得",
  description: "Get watching detail by watching ID.",
  category: "ReadOnly",
  toolset: "watching",
  inputSchema: z.object({ watching_id: reqInt("Watching ID (required)") }),
  handler: ({ watching_id }, { client }) => client.request("GET", `/watchings/${seg(watching_id)}`),
});

export const watchingCount = defineTool({
  name: "logbutler_watching_count",
  title: "ウォッチ数取得",
  description: "Get the count of watchings for a user.",
  category: "ReadOnly",
  toolset: "watching",
  inputSchema: z.object({ user_id: reqInt("User ID (required)") }),
  handler: ({ user_id }, { client }) =>
    client.request("GET", `/users/${seg(user_id)}/watchings/count`),
});
