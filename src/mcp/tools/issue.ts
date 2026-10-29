import { z } from "zod";
import { MAX_STATUS_PROJECTS } from "../../analysis/budget";
import { resolveNotClosedStatusIds } from "../../analysis/open-statuses";
import type { BacklogClient } from "../../backlog/client";
import { fetchByOffset } from "../../backlog/paging";
import { ArgumentError } from "../../errors";
import {
  boundedCount,
  dateRangeFor,
  optBool,
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

/**
 * include_descendants で `parentIssueId[]` に載せる ID(親 + 子)の上限。URL の長さを抑える
 * (1 つ約 30 文字なので 200 個で約 6KB)。超えたら切り詰めずに argument_error(ADR 0015)。
 */
export const MAX_DESCENDANT_QUERY_IDS = 200;

/** 子課題の ID を直列に集める。上限(親を含めて MAX_DESCENDANT_QUERY_IDS)を超えたら argument_error。 */
async function collectChildIds(client: BacklogClient, parents: number[]): Promise<number[]> {
  const capacity = MAX_DESCENDANT_QUERY_IDS - parents.length;
  const { items } = await fetchByOffset<{ id: number }>(
    async ({ offset, count }) =>
      (await client.request<{ id: number }[]>("GET", "/issues", {
        // 並びは作成順の昇順(offset でページを辿っても、追加で動きにくい順序)。利用者の sort は最後の一覧にだけ使う。
        query: {
          parentIssueId: parents,
          sort: "created",
          order: "asc",
          count,
          offset: offset > 0 ? offset : undefined,
        },
      })) ?? [],
    { limit: capacity + 1 },
  );
  if (items.length > capacity) {
    throw new ArgumentError(
      `include_descendants: parent_issue_ids and their child issues exceed ${MAX_DESCENDANT_QUERY_IDS} issue IDs, so the grandchildren cannot be listed in one request. Narrow parent_issue_ids (fewer parents) and retry`,
    );
  }
  return items.map((i) => i.id);
}

export const issueList = defineTool({
  name: "logbutler_issue_list",
  title: "課題一覧取得",
  description: "List issues with optional filters, including parent issue filtering",
  category: "ReadOnly",
  toolset: "issue",
  // 従来の既定 50(プロジェクト・担当者・状態の解決と最後の一覧)+ 子の収集 2 ページ(親 + 子 ≦ 200 ID で打ち切るので 3 ページ目はない。ADR 0015)
  maxApiCalls: 52,
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
    include_descendants: optBool(
      `If true (requires parent_issue_ids), also return the grandchild issues: the children of the given parents and their children. Default false returns only direct children. At most ${MAX_DESCENDANT_QUERY_IDS} issue IDs (parents + children) are supported; beyond that an argument_error is returned. The other filters, count, offset and sort apply to the combined result`,
    ),
    timezone: timezoneArg(),
  }),
  handler: async (a, { client, now, timezone }) => {
    // 入力の検証は、Backlog を呼ぶ前にすべて済ませる。
    const count = boundedCount("count", a.count);
    const status = a.status_id ? resolveStatusIds(a.status_id) : undefined;
    const parents = parseCsvInts("parent_issue_ids", a.parent_issue_ids);
    if (a.include_descendants && !parents?.length) {
      throw new ArgumentError("include_descendants requires parent_issue_ids");
    }
    if (a.include_descendants && (parents?.length ?? 0) > MAX_DESCENDANT_QUERY_IDS) {
      throw new ArgumentError(
        `include_descendants supports at most ${MAX_DESCENDANT_QUERY_IDS} parent_issue_ids, got ${parents?.length}`,
      );
    }
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

    // 子孫まで返すときは、子の ID を集め、最後に「親 ∪ 子」を parentIssueId にして 1 回だけ一覧を取る。
    // フィルタ・count・offset・sort は Backlog が子と孫に一様にかける(ADR 0015)。
    let parentIds = parents ?? [];
    if (a.include_descendants && parents) {
      const childIds = await collectChildIds(client, parents);
      parentIds = [...new Set([...parents, ...childIds])];
    }

    return client.request("GET", "/issues", {
      query: {
        projectId: projectIds,
        assigneeId: assignee === undefined ? [] : [assignee],
        parentIssueId: parentIds,
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
