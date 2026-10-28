import { z } from "zod";
import { ArgumentError } from "../../errors";
import { optInt } from "../args";
import { defineTool } from "../registry";

const STAR_TARGETS = [
  ["issue_id", "issueId"],
  ["comment_id", "commentId"],
  ["wiki_id", "wikiId"],
  ["pull_request_id", "pullRequestId"],
  ["pull_request_comment_id", "pullRequestCommentId"],
] as const;

export const starAdd = defineTool({
  name: "logbutler_star_add",
  title: "スター追加",
  description:
    "Add a star to an issue, comment, wiki, pull request, or pull request comment. Specify exactly one of: issue_id, comment_id, wiki_id, pull_request_id, pull_request_comment_id",
  category: "WriteIdempotent",
  // 実 Backlog は同じ対象に 2 回付けるとスターが 2 個になる。冪等ではないので注釈だけ false にする
  // (冪等キャッシュは付けない。logvalet との差分は docs/tool-diff-from-logvalet.md)。
  idempotentHint: false,
  toolset: "star",
  inputSchema: z.object({
    issue_id: optInt("Issue ID to star"),
    comment_id: optInt("Comment ID to star"),
    wiki_id: optInt("Wiki ID to star"),
    pull_request_id: optInt("Pull request ID to star"),
    pull_request_comment_id: optInt("Pull request comment ID to star"),
  }),
  handler: async (a, { client }) => {
    // 0 は未指定とみなす（logvalet と同じ）。
    const given = STAR_TARGETS.filter(([arg]) => (a[arg] ?? 0) !== 0);
    const names = STAR_TARGETS.map(([arg]) => arg).join(", ");
    if (given.length === 0) throw new ArgumentError(`one of ${names} is required`);
    if (given.length > 1) throw new ArgumentError(`only one of ${names} can be specified`);
    const [arg, field] = given[0] as (typeof STAR_TARGETS)[number];
    await client.request("POST", "/stars", { form: { [field]: a[arg] } });
    return { result: "ok" };
  },
});
