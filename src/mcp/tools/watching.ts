import { z } from "zod";
import {
  boundedCount,
  optInt,
  optStr,
  positiveOrUndefined,
  reqInt,
  reqStr,
  reqText,
  requireId,
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

export const watchingAdd = defineTool({
  name: "logbutler_watching_add",
  title: "ウォッチ追加",
  description: "Add a watching for an issue. Returns the created watching.",
  category: "WriteIdempotent",
  toolset: "watching",
  inputSchema: z.object({
    issue_id_or_key: reqStr("Issue ID or key (e.g., PROJ-123) (required)"),
    note: optStr("Optional note for the watching"),
  }),
  handler: ({ issue_id_or_key, note }, { client }) =>
    client.request("POST", "/watchings", {
      form: { issueIdOrKey: issue_id_or_key, note: note || undefined },
    }),
});

export const watchingUpdate = defineTool({
  name: "logbutler_watching_update",
  title: "ウォッチ更新",
  description: "Update the note of a watching.",
  category: "WriteIdempotent",
  toolset: "watching",
  inputSchema: z.object({
    watching_id: reqInt("Watching ID (required)"),
    note: reqText("New note for the watching (required)"),
  }),
  handler: ({ watching_id, note }, { client }) => {
    requireId("watching_id", watching_id);
    return client.request("PATCH", `/watchings/${seg(watching_id)}`, { form: { note } });
  },
});

export const watchingDelete = defineTool({
  name: "logbutler_watching_delete",
  title: "ウォッチ削除",
  description: "Delete a watching by watching ID. Returns the deleted watching.",
  category: "Destructive",
  toolset: "watching",
  inputSchema: z.object({ watching_id: reqInt("Watching ID (required)") }),
  handler: ({ watching_id }, { client }) => {
    requireId("watching_id", watching_id);
    return client.request("DELETE", `/watchings/${seg(watching_id)}`);
  },
});

export const watchingMarkAsRead = defineTool({
  name: "logbutler_watching_mark_as_read",
  title: "ウォッチ既読化",
  description: "Mark a watching as read by watching ID.",
  category: "WriteIdempotent",
  toolset: "watching",
  inputSchema: z.object({ watching_id: reqInt("Watching ID (required)") }),
  handler: async ({ watching_id }, { client }) => {
    requireId("watching_id", watching_id);
    await client.request("POST", `/watchings/${seg(watching_id)}/markAsRead`);
    return { result: "ok" };
  },
});
