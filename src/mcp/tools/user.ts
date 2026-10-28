import { z } from "zod";
import { reqStr, seg } from "../args";
import { defineTool } from "../registry";

export const userList = defineTool({
  name: "logbutler_user_list",
  title: "ユーザー一覧取得",
  description: "List all users in the space",
  category: "ReadOnly",
  toolset: "user",
  inputSchema: z.object({}),
  handler: (_args, { client }) => client.request("GET", "/users"),
});

export const userGet = defineTool({
  name: "logbutler_user_get",
  title: "ユーザー詳細取得",
  description: "Get user details by user ID",
  category: "ReadOnly",
  toolset: "user",
  // 説明文は logvalet のまま。logbutler は "me" も受け付ける(docs/tool-diff-from-logvalet.md)。
  inputSchema: z.object({ user_id: reqStr("User ID") }),
  handler: ({ user_id }, { client }) =>
    // "me" は /users/myself 1 回で引く(ID を引いてからもう一度、はしない)。
    user_id === "me" ? client.getMyself() : client.request("GET", `/users/${seg(user_id)}`),
});
