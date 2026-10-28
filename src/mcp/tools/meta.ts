import { z } from "zod";
import { reqStr, seg } from "../args";
import { defineTool } from "../registry";

/** プロジェクト配下のマスタ(`/projects/{key}/{segment}`)を一覧するツール。Backlog の生データを返す。 */
function projectMaster(name: string, title: string, description: string, segment: string) {
  return defineTool({
    name,
    title,
    description,
    category: "ReadOnly",
    toolset: "meta",
    inputSchema: z.object({ project_key: reqStr("Project key") }),
    handler: ({ project_key }, { client }) =>
      client.request("GET", `/projects/${seg(project_key)}/${segment}`),
  });
}

export const metaStatuses = projectMaster(
  "logbutler_meta_statuses",
  "ステータス一覧取得",
  "List statuses for a project",
  "statuses",
);
export const metaIssueTypes = projectMaster(
  "logbutler_meta_issue_types",
  "課題種別一覧取得",
  "List issue types for a project",
  "issueTypes",
);
export const metaCategories = projectMaster(
  "logbutler_meta_categories",
  "カテゴリ一覧取得",
  "List categories for a project",
  "categories",
);
export const metaVersion = projectMaster(
  "logbutler_meta_version",
  "バージョン一覧取得",
  "List versions for a project",
  "versions",
);
export const metaCustomField = projectMaster(
  "logbutler_meta_custom_field",
  "カスタムフィールド一覧取得",
  "List custom field definitions for a project",
  "customFields",
);
