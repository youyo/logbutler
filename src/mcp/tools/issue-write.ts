/** 課題の書き込み系ツール（作成・更新・コメント・関連課題・添付）。 */
import { z } from "zod";
import type { BacklogClient } from "../../backlog/client";
import { resolveEngagement } from "../../conventions/engagement";
import { ArgumentError } from "../../errors";
import {
  nonEmpty,
  optInt,
  optStr,
  parseCsvInts,
  parseDate,
  positiveOrUndefined,
  reqInt,
  reqStr,
  requireId,
  resolveProjectId,
  seg,
} from "../args";
import { defineTool } from "../registry";

// --- issue_create / issue_update 共通 ---

/** CSV・日付の引数。Backlog を呼ぶ前に、すべて検証する。 */
function parseListsAndDates(a: {
  category_ids?: string;
  version_ids?: string;
  milestone_ids?: string;
  notified_user_ids?: string;
  due_date?: string;
  start_date?: string;
}) {
  return {
    categoryIds: parseCsvInts("category_ids", a.category_ids),
    versionIds: parseCsvInts("version_ids", a.version_ids),
    milestoneIds: parseCsvInts("milestone_ids", a.milestone_ids),
    notifiedUserIds: parseCsvInts("notified_user_ids", a.notified_user_ids),
    dueDate: a.due_date ? parseDate("due_date", a.due_date) : undefined,
    startDate: a.start_date ? parseDate("start_date", a.start_date) : undefined,
  };
}

/** 課題キー（PROJ-123）から、プロジェクトキー（PROJ）を取る。数値の課題 ID なら課題を引いて決める。 */
async function projectKeyOfIssue(client: BacklogClient, issueIdOrKey: string): Promise<string> {
  let key = issueIdOrKey;
  if (/^\d+$/.test(issueIdOrKey)) {
    const issue = await client.request<{ issueKey?: string }>(
      "GET",
      `/issues/${seg(issueIdOrKey)}`,
    );
    if (!issue?.issueKey) {
      throw new ArgumentError(`failed to resolve issue ID "${issueIdOrKey}": issue key is missing`);
    }
    key = issue.issueKey;
  }
  const at = key.lastIndexOf("-");
  return at <= 0 ? key : key.slice(0, at);
}

const SHARED_FIELDS = {
  description: "Issue description",
  priority: "Priority ID",
  assignee: "Assignee user ID",
  categories: 'Comma-separated category IDs (e.g. "10,20")',
  engagement: "Engagement name; sets both the engagement category and the parent issue",
  versions: "Comma-separated version IDs",
  milestones: "Comma-separated milestone IDs",
  notified: "Comma-separated user IDs to notify",
  due: "Due date in YYYY-MM-DD format",
  start: "Start date in YYYY-MM-DD format",
} as const;

export const issueCreate = defineTool({
  name: "logbutler_issue_create",
  title: "課題作成",
  description: "Create a new issue",
  category: "WriteNonIdempotent",
  toolset: "issue",
  inputSchema: z.object({
    project_key: reqStr("Project key"),
    summary: reqStr("Issue summary"),
    issue_type_id: reqInt("Issue type ID"),
    description: optStr(SHARED_FIELDS.description),
    priority_id: optInt(SHARED_FIELDS.priority),
    assignee_id: optInt(SHARED_FIELDS.assignee),
    parent_issue_id: optInt("Parent issue ID for creating a child issue"),
    category_ids: optStr(SHARED_FIELDS.categories),
    engagement: optStr(SHARED_FIELDS.engagement),
    version_ids: optStr(SHARED_FIELDS.versions),
    milestone_ids: optStr(SHARED_FIELDS.milestones),
    notified_user_ids: optStr(SHARED_FIELDS.notified),
    due_date: optStr(SHARED_FIELDS.due),
    start_date: optStr(SHARED_FIELDS.start),
  }),
  handler: async (a, { client }) => {
    requireId("issue_type_id", a.issue_type_id);
    const v = parseListsAndDates(a);
    const projectId = await resolveProjectId(client, a.project_key);

    let categoryIds = v.categoryIds;
    let parentIssueId = positiveOrUndefined(a.parent_issue_id);
    if (a.engagement !== undefined) {
      const ref = await resolveEngagement(client, a.project_key, a.engagement);
      // 明示指定（category_ids は空文字も明示）があれば上書きしない。
      if (a.category_ids === undefined) categoryIds = [ref.categoryId];
      if (a.parent_issue_id === undefined && ref.parentIssueId !== 0) {
        parentIssueId = ref.parentIssueId;
      }
    }

    return client.request("POST", "/issues", {
      form: {
        projectId,
        summary: a.summary,
        issueTypeId: a.issue_type_id,
        // 未指定なら送らない（logvalet は priorityId=0 を送っていた。ADR 0005 と tool-diff を参照）。
        priorityId: positiveOrUndefined(a.priority_id),
        description: nonEmpty(a.description),
        assigneeId: positiveOrUndefined(a.assignee_id),
        parentIssueId,
        categoryId: categoryIds ?? [],
        versionId: v.versionIds ?? [],
        milestoneId: v.milestoneIds ?? [],
        notifiedUserId: v.notifiedUserIds ?? [],
        dueDate: v.dueDate,
        startDate: v.startDate,
      },
    });
  },
});

export const issueUpdate = defineTool({
  name: "logbutler_issue_update",
  title: "課題更新",
  description: "Update an existing issue",
  category: "WriteIdempotent",
  toolset: "issue",
  inputSchema: z.object({
    issue_key: reqStr("Issue key (e.g. PROJECT-123)"),
    summary: optStr("New summary"),
    description: optStr("New description"),
    status_id: optInt("Status ID"),
    priority_id: optInt(SHARED_FIELDS.priority),
    assignee_id: optInt(SHARED_FIELDS.assignee),
    issue_type_id: optInt("Issue type ID"),
    parent_issue_id: optInt("Parent issue ID (0 to remove parent)"),
    category_ids: optStr(SHARED_FIELDS.categories),
    engagement: optStr(SHARED_FIELDS.engagement),
    version_ids: optStr(SHARED_FIELDS.versions),
    milestone_ids: optStr(SHARED_FIELDS.milestones),
    notified_user_ids: optStr(SHARED_FIELDS.notified),
    due_date: optStr(SHARED_FIELDS.due),
    start_date: optStr(SHARED_FIELDS.start),
    comment: optStr("Comment to add with the update"),
  }),
  handler: async (a, { client }) => {
    const v = parseListsAndDates(a);
    let categoryIds = v.categoryIds;
    let parentIssueId = a.parent_issue_id;
    if (a.engagement !== undefined) {
      const projectKey = await projectKeyOfIssue(client, a.issue_key);
      const ref = await resolveEngagement(client, projectKey, a.engagement);
      if (a.category_ids === undefined) categoryIds = [ref.categoryId];
      if (a.parent_issue_id === undefined && ref.parentIssueId !== 0) {
        parentIssueId = ref.parentIssueId;
      }
    }

    const hasField =
      a.summary !== undefined ||
      a.description !== undefined ||
      a.status_id !== undefined ||
      a.priority_id !== undefined ||
      a.assignee_id !== undefined ||
      a.issue_type_id !== undefined ||
      parentIssueId !== undefined ||
      categoryIds !== undefined ||
      v.versionIds !== undefined ||
      v.milestoneIds !== undefined ||
      v.notifiedUserIds !== undefined ||
      v.dueDate !== undefined ||
      v.startDate !== undefined ||
      a.comment !== undefined;
    if (!hasField) throw new ArgumentError("at least one field to update must be specified");

    return client.request("PATCH", `/issues/${seg(a.issue_key)}`, {
      form: {
        summary: a.summary,
        description: a.description,
        statusId: a.status_id,
        priorityId: a.priority_id,
        assigneeId: a.assignee_id,
        issueTypeId: a.issue_type_id,
        // 0 は親の解除。Backlog には空文字で送る（backlog4j と同じ。公式ドキュメントに記載なし）。
        parentIssueId: parentIssueId === 0 ? "" : parentIssueId,
        categoryId: categoryIds ?? [],
        versionId: v.versionIds ?? [],
        milestoneId: v.milestoneIds ?? [],
        notifiedUserId: v.notifiedUserIds ?? [],
        dueDate: v.dueDate,
        startDate: v.startDate,
        comment: a.comment,
      },
    });
  },
});

// --- コメント ---

/** content が空なら別名 body。どちらも空なら argument_error。 */
function commentContent(a: { content?: string; body?: string }): string {
  const content = nonEmpty(a.content) ?? nonEmpty(a.body);
  if (content === undefined) throw new ArgumentError("content (or body) is required");
  return content;
}

export const issueCommentAdd = defineTool({
  name: "logbutler_issue_comment_add",
  title: "課題コメント追加",
  description: "Add a comment to an issue",
  category: "WriteNonIdempotent",
  toolset: "issue",
  inputSchema: z.object({
    issue_key: reqStr("Issue key (e.g. PROJECT-123)"),
    content: optStr("Comment content (alias: body)"),
    body: optStr("Alias for content"),
    notified_user_ids: optStr("Comma-separated user IDs to notify"),
  }),
  handler: ({ issue_key, ...a }, { client }) => {
    const content = commentContent(a);
    const notified = parseCsvInts("notified_user_ids", a.notified_user_ids);
    return client.request("POST", `/issues/${seg(issue_key)}/comments`, {
      form: { content, notifiedUserId: notified ?? [] },
    });
  },
});

export const issueCommentUpdate = defineTool({
  name: "logbutler_issue_comment_update",
  title: "課題コメント更新",
  description: "Update a comment on an issue",
  category: "WriteIdempotent",
  toolset: "issue",
  inputSchema: z.object({
    issue_key: reqStr("Issue key (e.g. PROJECT-123)"),
    comment_id: reqInt("Comment ID"),
    content: optStr("New comment content (alias: body)"),
    body: optStr("Alias for content"),
  }),
  handler: ({ issue_key, comment_id, ...a }, { client }) => {
    requireId("comment_id", comment_id);
    const content = commentContent(a);
    return client.request("PATCH", `/issues/${seg(issue_key)}/comments/${seg(comment_id)}`, {
      form: { content },
    });
  },
});

// --- 関連課題（Backlog の公式 API ドキュメントにない API。logvalet の issue_related.go と同じパス） ---

export const issueRelatedAdd = defineTool({
  name: "logbutler_issue_related_add",
  title: "関連課題追加",
  description:
    "Add a related issue to an issue. target_issue_id is the numeric issue ID (not the issue key).",
  category: "WriteIdempotent",
  toolset: "issue",
  inputSchema: z.object({
    issue_key: reqStr("Issue key (e.g. PROJECT-123)"),
    target_issue_id: reqInt("Numeric ID of the issue to relate (not the issue key)"),
  }),
  handler: ({ issue_key, target_issue_id }, { client }) => {
    requireId("target_issue_id", target_issue_id);
    return client.request("POST", `/issues/${seg(issue_key)}/relatedIssues`, {
      form: { targetIssueId: target_issue_id },
    });
  },
});

export const issueRelatedDelete = defineTool({
  name: "logbutler_issue_related_delete",
  title: "関連課題削除",
  description:
    "Delete a related issue link from an issue. related_issue_id is the relation ID returned by logvalet_issue_related_list.",
  category: "Destructive",
  toolset: "issue",
  inputSchema: z.object({
    issue_key: reqStr("Issue key (e.g. PROJECT-123)"),
    related_issue_id: reqInt("Relation ID to delete (from logvalet_issue_related_list)"),
  }),
  handler: async ({ issue_key, related_issue_id }, { client }) => {
    requireId("related_issue_id", related_issue_id);
    const deleted = await client.request(
      "DELETE",
      `/issues/${seg(issue_key)}/relatedIssues/${seg(related_issue_id)}`,
    );
    // 未公開 API なので、204・空本文のこともある。その場合は他の書き込みツールと同じ {result: ok}。
    return deleted ?? { result: "ok" };
  },
});

// --- 添付 ---

export const issueAttachmentDelete = defineTool({
  name: "logbutler_issue_attachment_delete",
  title: "添付ファイル削除",
  description: "Delete an attachment from an issue",
  category: "Destructive",
  toolset: "issue",
  inputSchema: z.object({
    issue_key: reqStr("Issue key (e.g. PROJECT-123)"),
    attachment_id: reqInt("Attachment ID"),
  }),
  handler: ({ issue_key, attachment_id }, { client }) => {
    requireId("attachment_id", attachment_id);
    return client.request("DELETE", `/issues/${seg(issue_key)}/attachments/${seg(attachment_id)}`);
  },
});

/** インライン base64 の上限（デコード後）。logvalet と同じ 4 MiB。 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const MAX_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 * 1.25;

/** `/` と `\` の両方を区切りとみなしたベース名。空・`.`・`..` は不可。 */
function attachmentBaseName(fileName: string): string {
  const base = fileName.replaceAll("\\", "/").split("/").pop() ?? "";
  if (base === "" || base === "." || base === "..") {
    throw new ArgumentError(`file_name must name a file (got "${fileName}")`);
  }
  return base;
}

function decodeUpload(base64: string): Uint8Array<ArrayBuffer> {
  // 明らかに大きい入力はデコードしない（メモリを無駄に確保しない）。上限ちょうどの base64 に
  // 改行（MIME 形式の 76 文字ごと）が混ざっても通るよう 25% の余裕を見る。境界は下のデコード後の実サイズで決める。
  if (base64.length > MAX_BASE64_CHARS) {
    throw new ArgumentError(
      `decoded file content would exceed ${MAX_UPLOAD_BYTES} bytes (base64 length ${base64.length})`,
    );
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new ArgumentError("file_content_base64 is not valid base64");
  }
  if (binary.length > MAX_UPLOAD_BYTES) {
    throw new ArgumentError(
      `decoded file content exceeds ${MAX_UPLOAD_BYTES} bytes (got ${binary.length})`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const issueAttachmentUpload = defineTool({
  name: "logbutler_issue_attachment_upload",
  title: "添付ファイルアップロード",
  // logvalet の説明文から file_paths（サーバー上のパス）の記述を除いた。Workers にはファイルシステムがない。
  description:
    "Upload a file and attach it to an issue. Specify file_name + file_content_base64 (inline base64 content, decoded size <= 4MB). mime_type is currently advisory and not forwarded to Backlog.",
  category: "WriteNonIdempotent",
  toolset: "issue",
  inputSchema: z.object({
    issue_key: reqStr("Issue key (e.g. PROJECT-123)"),
    file_name: optStr(
      "File name for inline upload (e.g. asset9.png). Required when file_content_base64 is set.",
    ),
    file_content_base64: optStr(
      "Base64-encoded file content for inline upload. Decoded size must be <= 4MB.",
    ),
    mime_type: optStr(
      "MIME type hint (e.g. image/png). Advisory only; Backlog determines content type from filename.",
    ),
  }),
  handler: async (a, { client }) => {
    // 0 バイトのファイル（空の base64）も有効なので、存在で判定する。
    if (a.file_content_base64 === undefined) {
      throw new ArgumentError("file_content_base64 is required");
    }
    if (!a.file_name)
      throw new ArgumentError("file_name is required when file_content_base64 is set");
    const safeName = attachmentBaseName(a.file_name);
    const bytes = decodeUpload(a.file_content_base64);

    const form = new FormData();
    form.append("file", new Blob([bytes]), safeName);
    const uploaded = await client.request<{ id: number }>("POST", "/space/attachment", {
      multipart: form,
    });
    return client.request("PATCH", `/issues/${seg(a.issue_key)}`, {
      form: { attachmentId: [uploaded.id] },
    });
  },
});
