import type { McpServer } from "@modelcontextprotocol/server";
import { type BacklogClient, BacklogUnauthorizedError } from "../../backlog/client";
import { toErrorEnvelope } from "../../errors";

export const USER_ME_TOOL = "logbutler_user_me";

export interface UserMeDeps {
  getClient: () => BacklogClient;
  /** Backlog が 401 を返したとき(HTTP 401 に変換するための合図)。 */
  onBacklogUnauthorized: () => void;
}

export function registerUserMe(server: McpServer, deps: UserMeDeps): void {
  server.registerTool(
    USER_ME_TOOL,
    {
      title: "認証ユーザー情報取得",
      description: "Get the authenticated Backlog user's information",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const me = await deps.getClient().getMyself();
        // JSON のキーは snake_case に変換して返す。
        const body = {
          id: me.id,
          user_id: me.userId,
          name: me.name,
          mail_address: me.mailAddress,
          role_type: me.roleType,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
      } catch (e) {
        if (e instanceof BacklogUnauthorizedError) deps.onBacklogUnauthorized();
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify(toErrorEnvelope(e)) }],
        };
      }
    },
  );
}
