import { z } from "zod";
import {
  boundedCount,
  dateRangeFor,
  optInt,
  optStr,
  parseCsvInts,
  parseCsvStrings,
  parseDate,
  positiveOrUndefined,
  reqInt,
  reqStr,
  resolveProjectId,
  resolveStatusIds,
  resolveUserId,
  seg,
  timezoneArg,
  todayIn,
} from "../args";
import { defineTool } from "../registry";
import { downloadResult } from "./download";

export const issueGet = defineTool({
  name: "logbutler_issue_get",
  title: "課題詳細取得",
  description: "Get issue details by issue key",
  category: "ReadOnly",
  toolset: "issue",
  inputSchema: z.object({ issue_key: reqStr("Issue key (e.g. PROJECT-123)") }),
  handler: ({ issue_key }, { client }) => client.request("GET", `/issues/${seg(issue_key)}`),
});

export const issueList = defineTool({
  name: "logbutler_issue_list",
  title: "課題一覧取得",
  description: "List issues with optional filters, including parent issue filtering",
  category: "ReadOnly",
  toolset: "issue",
  inputSchema: z.object({
    project_key: optStr("Filter by single project key (legacy; use project_keys for multiple)"),
    project_keys: optStr("Comma-separated project keys (e.g. PROJ1,PROJ2)"),
    count: optInt("Max number of issues (default 20, max 100)"),
    offset: optInt("Offset for pagination"),
    sort: optStr("Sort field (e.g. updated, created)"),
    order: optStr("Sort order (asc/desc)"),
    assignee_id: optStr("Assignee filter: me (resolved via GetMyself) or numeric user ID"),
    status_id: optStr("Status filter: not-closed (IDs 1,2,3) or comma-separated numeric IDs"),
    keyword: optStr("Keyword search against Backlog issues"),
    due_date: optStr(
      "Due date filter: overdue, this-week, today, this-month, YYYY-MM-DD, or YYYY-MM-DD:YYYY-MM-DD",
    ),
    start_date: optStr(
      "Start date filter: today, this-week, this-month, YYYY-MM-DD, or YYYY-MM-DD:YYYY-MM-DD",
    ),
    updated_since: optStr("Updated since (YYYY-MM-DD)"),
    updated_until: optStr("Updated until (YYYY-MM-DD)"),
    parent_issue_ids: optStr(
      'Comma-separated parent issue IDs to filter child issues (e.g. "100,200")',
    ),
    timezone: timezoneArg(),
  }),
  handler: async (a, { client, now, timezone }) => {
    // 入力の検証は、Backlog を呼ぶ前にすべて済ませる。
    const count = boundedCount("count", a.count);
    const status = a.status_id ? resolveStatusIds(a.status_id) : undefined;
    const parents = parseCsvInts("parent_issue_ids", a.parent_issue_ids);
    const today = a.due_date || a.start_date ? todayIn(now(), timezone) : undefined;
    const due = a.due_date && today ? dateRangeFor("due_date", a.due_date, today) : undefined;
    const start =
      a.start_date && today ? dateRangeFor("start_date", a.start_date, today) : undefined;
    const updatedSince = a.updated_since ? parseDate("updated_since", a.updated_since) : undefined;
    const updatedUntil = a.updated_until ? parseDate("updated_until", a.updated_until) : undefined;

    // project_key → projectId、assignee "me" → userId。直列に解決する(並列にしない)。
    const keys = [...(a.project_key ? [a.project_key] : []), ...parseCsvStrings(a.project_keys)];
    const projectIds: number[] = [];
    for (const key of keys) {
      const id = await resolveProjectId(client, key);
      if (!projectIds.includes(id)) projectIds.push(id);
    }
    const assignee = a.assignee_id
      ? await resolveUserId(client, a.assignee_id, "assignee_id")
      : undefined;

    return client.request("GET", "/issues", {
      query: {
        projectId: projectIds,
        assigneeId: assignee === undefined ? [] : [assignee],
        parentIssueId: parents ?? [],
        statusId: status ?? [],
        keyword: a.keyword || undefined,
        dueDateSince: due?.since,
        dueDateUntil: due?.until,
        startDateSince: start?.since,
        startDateUntil: start?.until,
        updatedSince,
        updatedUntil,
        sort: a.sort || undefined,
        order: a.order || undefined,
        count,
        offset: positiveOrUndefined(a.offset),
      },
    });
  },
});

export const issueCommentList = defineTool({
  name: "logbutler_issue_comment_list",
  title: "課題コメント一覧取得",
  description: "List comments for an issue",
  category: "ReadOnly",
  toolset: "issue",
  inputSchema: z.object({
    issue_key: reqStr("Issue key (e.g. PROJECT-123)"),
    count: optInt("Max number of comments"),
    offset: optInt("Offset for pagination"),
  }),
  handler: ({ issue_key, count, offset }, { client }) =>
    client.request("GET", `/issues/${seg(issue_key)}/comments`, {
      query: { count: positiveOrUndefined(count), offset: positiveOrUndefined(offset) },
    }),
});

export const issueAttachmentList = defineTool({
  name: "logbutler_issue_attachment_list",
  title: "課題添付ファイル一覧取得",
  description: "List attachments for an issue",
  category: "ReadOnly",
  toolset: "issue",
  inputSchema: z.object({ issue_key: reqStr("Issue key (e.g. PROJECT-123)") }),
  handler: ({ issue_key }, { client }) =>
    client.request("GET", `/issues/${seg(issue_key)}/attachments`),
});

export const issueAttachmentDownload = defineTool({
  name: "logbutler_issue_attachment_download",
  title: "添付ファイルダウンロード",
  description: "Download an attachment from an issue (max 20MB, returned as base64)",
  category: "ReadOnly",
  toolset: "issue",
  inputSchema: z.object({
    issue_key: reqStr("Issue key (e.g. PROJECT-123)"),
    attachment_id: reqInt("Attachment ID"),
  }),
  handler: ({ issue_key, attachment_id }, { client }) =>
    downloadResult(client, `/issues/${seg(issue_key)}/attachments/${seg(attachment_id)}`),
});

export const issueRelatedList = defineTool({
  name: "logbutler_issue_related_list",
  title: "関連課題一覧取得",
  description: "List related issues for an issue",
  category: "ReadOnly",
  toolset: "issue",
  inputSchema: z.object({ issue_key: reqStr("Issue key (e.g. PROJECT-123)") }),
  // Backlog の公式 API ドキュメントにない API(logvalet の issue_related.go と同じパス)。
  handler: ({ issue_key }, { client }) =>
    client.request("GET", `/issues/${seg(issue_key)}/relatedIssues`),
});
