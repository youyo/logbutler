import { z } from "zod";
import { boundedCount, optBool, optInt, positiveOrUndefined } from "../args";
import { defineTool } from "../registry";

// Nulab 公式 MCP(nulab/backlog-mcp-server v0.23.3)から取り込んだ通知系ツール。logvalet には無い。

export const notificationList = defineTool({
  name: "logbutler_notification_list",
  title: "通知一覧取得",
  description:
    "List notifications for the authenticated user. Read-only: this does not mark notifications as read (check them in the Backlog UI).",
  category: "ReadOnly",
  toolset: "notification",
  inputSchema: z.object({
    min_id: optInt("Return notifications with an ID greater than this value"),
    max_id: optInt("Return notifications with an ID less than this value"),
    count: optInt("Max number of items (1-100, default: Backlog default)"),
    order: z.enum(["asc", "desc"]).describe("Sort order: asc or desc (default: desc)").optional(),
  }),
  handler: ({ min_id, max_id, count, order }, { client }) =>
    client.request("GET", "/notifications", {
      query: {
        minId: positiveOrUndefined(min_id),
        maxId: positiveOrUndefined(max_id),
        count: boundedCount("count", count),
        order,
      },
    }),
});

export const notificationCount = defineTool({
  name: "logbutler_notification_count",
  title: "通知件数取得",
  description:
    'Get the number of notifications for the authenticated user. Returns {"count": n}. Read-only.',
  category: "ReadOnly",
  toolset: "notification",
  inputSchema: z.object({
    already_read: optBool(
      "Count only notifications that are already read (true) or unread (false)",
    ),
    resource_already_read: optBool(
      "Count only notifications whose resource (issue, etc.) is already read (true) or unread (false)",
    ),
  }),
  handler: ({ already_read, resource_already_read }, { client }) =>
    client.request("GET", "/notifications/count", {
      query: { alreadyRead: already_read, resourceAlreadyRead: resource_already_read },
    }),
});
