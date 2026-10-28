import { z } from "zod";
import { defineTool } from "../registry";

export const USER_ME_TOOL = "logbutler_user_me";

export const userMe = defineTool({
  name: USER_ME_TOOL,
  title: "認証ユーザー情報取得",
  // logvalet の tools_list_baseline.json と同じ説明文(スナップショット比較で差分にしない)。
  description: "Get the authenticated user's information",
  category: "ReadOnly",
  toolset: "user",
  inputSchema: z.object({}),
  handler: async (_args, { client }) => {
    const me = await client.getMyself();
    // 加工した出力なので snake_case(Backlog の生データを返すツールは camelCase のまま。ADR 0004)。
    return {
      id: me.id,
      user_id: me.userId,
      name: me.name,
      mail_address: me.mailAddress,
      role_type: me.roleType,
    };
  },
});
