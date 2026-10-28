/**
 * M05B の digest 系 6 個と user_activity(定義だけ。ロジックは `src/analysis/`)。
 * description / inputSchema / annotations は logvalet の baseline と一致させる(`timezone` の追加だけが差分)。
 */
import { z } from "zod";
import { buildActivityDigest } from "../../analysis/activity-digest";
import { API_BUDGET } from "../../analysis/budget";
import { buildDocumentDigest } from "../../analysis/document-digest";
import { buildDocumentSearch } from "../../analysis/document-search";
import { buildSearch } from "../../analysis/search";
import { buildSpaceDigest } from "../../analysis/space-digest";
import { buildUnifiedDigest } from "../../analysis/unified";
import { buildUserActivity } from "../../analysis/user-activity";
import { optInt, optStr, reqStr, timezoneArg } from "../args";
import { defineTool } from "../registry";

export const spaceDigest = defineTool({
  name: "logbutler_space_digest",
  title: "スペースダイジェスト生成",
  description: "Generate a digest for the entire Backlog space",
  category: "ReadOnly",
  toolset: "digest",
  inputSchema: z.object({}),
  maxApiCalls: API_BUDGET.spaceDigest,
  handler: (_a, ctx) => buildSpaceDigest(ctx),
});

export const documentDigest = defineTool({
  name: "logbutler_document_digest",
  title: "ドキュメントダイジェスト生成",
  description: "Generate a digest for a document",
  category: "ReadOnly",
  toolset: "digest",
  inputSchema: z.object({ document_id: reqStr("Document ID") }),
  maxApiCalls: API_BUDGET.documentDigest,
  handler: (a, ctx) => buildDocumentDigest(ctx, a),
});

export const documentSearch = defineTool({
  name: "logbutler_document_search",
  title: "ドキュメント検索",
  description: "Search documents by keyword within a Backlog space",
  category: "ReadOnly",
  toolset: "search",
  inputSchema: z.object({
    keyword: reqStr("Search keyword"),
    project_keys: optStr("Comma-separated project keys to filter (e.g. PROJ1,PROJ2)"),
    count: optInt("Max results (1-100, default 100)"),
    offset: optInt("Pagination offset (default 0)"),
    sort: optStr("Sort field: created | updated"),
    order: optStr("Sort order: asc | desc"),
    detail: optStr("Verbosity: snippet | meta | full (default: snippet)"),
  }),
  maxApiCalls: API_BUDGET.documentSearch,
  handler: (a, ctx) => buildDocumentSearch(ctx, a),
});

export const search = defineTool({
  name: "logbutler_search",
  title: "横断検索",
  description: "Search issues, documents, and wiki pages by keyword",
  category: "ReadOnly",
  toolset: "search",
  inputSchema: z.object({
    keyword: reqStr("Search keyword"),
    project_keys: optStr("Comma-separated project keys to filter (optional)"),
    count: optInt("Max results per resource (1-100, default 20)"),
    offset: optInt("Pagination offset per resource (default 0)"),
    detail: optStr("Verbosity: snippet | meta (default: snippet)"),
  }),
  maxApiCalls: API_BUDGET.search,
  handler: (a, ctx) => buildSearch(ctx, a),
});

export const activityDigest = defineTool({
  name: "logbutler_activity_digest",
  title: "アクティビティダイジェスト生成",
  description: "Generate an activity digest for a space or project",
  category: "ReadOnly",
  toolset: "digest",
  inputSchema: z.object({
    since: optStr("Start date (YYYY-MM-DD)"),
    until: optStr("End date (YYYY-MM-DD)"),
    limit: optInt("Max number of activities (default 20)"),
    project: optStr("Filter by project key"),
    timezone: timezoneArg(),
  }),
  maxApiCalls: API_BUDGET.activityDigest,
  handler: (a, ctx) => buildActivityDigest(ctx, a),
});

export const userActivity = defineTool({
  name: "logbutler_user_activity",
  title: "ユーザーアクティビティ取得",
  description: "List activities for a specific user",
  category: "ReadOnly",
  toolset: "activity",
  inputSchema: z.object({
    user_id: reqStr("User ID or 'me' for current user"),
    since: optStr("Start date (YYYY-MM-DD)"),
    until: optStr("End date (YYYY-MM-DD)"),
    limit: optInt("Max number of activities (default 20)"),
    project: optStr("Filter by project key (client-side filter)"),
    activity_type_ids: optStr("Comma-separated activity type IDs"),
    timezone: timezoneArg(),
  }),
  maxApiCalls: API_BUDGET.userActivity,
  handler: (a, ctx) => buildUserActivity(ctx, a),
});

export const digestUnified = defineTool({
  name: "logbutler_digest_unified",
  title: "統合ダイジェスト生成",
  description: "Generate a unified digest across projects, users, teams, or issues",
  category: "ReadOnly",
  toolset: "digest",
  inputSchema: z.object({
    since: reqStr("Start date (YYYY-MM-DD)"),
    until: optStr("End date (YYYY-MM-DD)"),
    project_keys: optStr("Comma-separated project keys"),
    user_ids: optStr("Comma-separated user IDs"),
    team_ids: optStr("Comma-separated team IDs"),
    issue_keys: optStr("Comma-separated issue keys"),
    due_date: optStr("Due date filter (YYYY-MM-DD or YYYY-MM-DD:YYYY-MM-DD)"),
    start_date: optStr("Start date filter (YYYY-MM-DD or YYYY-MM-DD:YYYY-MM-DD)"),
    timezone: timezoneArg(),
  }),
  maxApiCalls: API_BUDGET.digestUnified,
  handler: (a, ctx) => buildUnifiedDigest(ctx, a),
});
