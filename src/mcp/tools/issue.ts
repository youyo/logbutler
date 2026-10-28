import { z } from "zod";
import { MAX_STATUS_PROJECTS } from "../../analysis/budget";
import { resolveNotClosedStatusIds } from "../../analysis/open-statuses";
import { ArgumentError } from "../../errors";
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
    status_id: optStr(
      "Status filter: not-closed (every status of the target projects except the completed ones, including custom statuses; with no project_key it looks up all your projects) or comma-separated numeric IDs",
    ),
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
    const keys = [...(a.project_key ? [a.project_key] : []), ...parseCsvStrings(a.project_keys)];
    if (status === "not-closed" && new Set(keys).size > MAX_STATUS_PROJECTS) {
      throw new ArgumentError(
        `status_id=not-closed looks up the statuses of each project, so at most ${MAX_STATUS_PROJECTS} projects can be given, got ${new Set(keys).size}`,
      );
    }
    const today = a.due_date || a.start_date ? todayIn(now(), timezone) : undefined;
    const due = a.due_date && today ? dateRangeFor("due_date", a.due_date, today) : undefined;
    const start =
      a.start_date && today ? dateRangeFor("start_date", a.start_date, today) : undefined;
    const updatedSince = a.updated_since ? parseDate("updated_since", a.updated_since) : undefined;
    const updatedUntil = a.updated_until ? parseDate("updated_until", a.updated_until) : undefined;

    // project_key → projectId、assignee "me" → userId。直列に解決する(並列にしない)。
    const projectIds: number[] = [];
    for (const key of keys) {
      const id = await resolveProjectId(client, key);
      if (!projectIds.includes(id)) projectIds.push(id);
    }
    const assignee = a.assignee_id
      ? await resolveUserId(client, a.assignee_id, "assignee_id")
      : undefined;

    // not-closed は ID を決め打ちせず、対象プロジェクトの状態一覧から完了集合以外の ID を決める(ADR 0012)。
    let statusIds: number[] | undefined;
    if (status === "not-closed") {
      statusIds = await resolveNotClosedStatusIds(client, [...new Set(keys)]);
      if (statusIds.length === 0) return []; // 未完了の状態が 1 つもなければ、該当する課題もない
    } else {
      statusIds = status;
    }

    return client.request("GET", "/issues", {
      query: {
        projectId: projectIds,
        assigneeId: assignee === undefined ? [] : [assignee],
        parentIssueId: parents ?? [],
        statusId: statusIds ?? [],
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

/** コメント一覧 API の count の既定値と上限(Backlog)。 */
const COMMENT_DEFAULT_COUNT = 20;
const COMMENT_MAX_COUNT = 100;

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
  // コメント一覧 API は minId / maxId / count / order だけで offset を受け付けない(送ると 400 unknownParameter)。
  // offset は logvalet 互換のスキーマとして残し、count + offset 件を取って先頭 offset 件を読み飛ばす。
  // order は送らない(Backlog の既定の降順 = 新しい順のまま)。
  handler: async ({ issue_key, count, offset }, { client }) => {
    const path = `/issues/${seg(issue_key)}/comments`;
    const want = positiveOrUndefined(count);
    const skip = positiveOrUndefined(offset);
    if (skip === undefined) return client.request("GET", path, { query: { count: want } });
    const take = (want ?? COMMENT_DEFAULT_COUNT) + skip;
    if (take > COMMENT_MAX_COUNT) {
      throw new ArgumentError(
        `count + offset must be at most ${COMMENT_MAX_COUNT} (Backlog returns at most ${COMMENT_MAX_COUNT} comments per request and has no offset), got ${take}${want === undefined ? ` (count defaults to ${COMMENT_DEFAULT_COUNT})` : ""}`,
      );
    }
    const page = (await client.request<unknown[]>("GET", path, { query: { count: take } })) ?? [];
    return page.slice(skip);
  },
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
  responseLimit: false, // ファイルサイズの上限は別にある(MAX_DOWNLOAD_BYTES)
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
