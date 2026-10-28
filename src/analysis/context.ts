/** issue_context(logvalet `internal/analysis/context.go`)。 */
import { positiveOr, seg } from "../mcp/args";
import type { ToolContext } from "../mcp/registry";
import { wholeDaysBetween } from "./dates";
import { analysisEnvelope, llmHints, type Warning, warningFromError } from "./envelope";
import {
  extractProjectKey,
  fetchAllComments,
  fetchRelatedRefs,
  idName,
  idNames,
} from "./issue-detail";
import type { BacklogIssue } from "./issues";
import { DEFAULT_STALE_DAYS, isOverdue, userRef } from "./stale";

export const DEFAULT_MAX_COMMENTS = 10;

export interface ContextArgs {
  issue_key: string;
  comments?: number;
  compact?: boolean;
  include_related_issues?: boolean;
}

interface BacklogStatus {
  id: number;
  projectId?: number;
  name: string;
  color?: string;
  displayOrder?: number;
}

export async function buildIssueContext(ctx: ToolContext, args: ContextArgs) {
  const issueKey = args.issue_key.trim();
  const maxComments = positiveOr(args.comments, DEFAULT_MAX_COMMENTS);
  const compact = args.compact === true;
  const now = ctx.now();
  const warnings: Warning[] = [];

  // 課題本体は必須(失敗したらツールエラー)。残りは直列に取り、失敗は warning にする。
  const issue = await ctx.client.request<BacklogIssue>("GET", `/issues/${seg(issueKey)}`);

  const fetchedComments = await fetchAllComments(ctx.client, issueKey, "recent_comments");
  warnings.push(...fetchedComments.warnings);

  let statuses: BacklogStatus[] = [];
  try {
    statuses =
      (await ctx.client.request<BacklogStatus[]>(
        "GET",
        `/projects/${seg(extractProjectKey(issueKey))}/statuses`,
      )) ?? [];
  } catch (e) {
    warnings.push(
      warningFromError(e, "statuses_fetch_failed", "failed to list statuses", "meta.statuses"),
    );
  }

  let related: Awaited<ReturnType<typeof fetchRelatedRefs>>["refs"] = [];
  if (args.include_related_issues !== false) {
    const r = await fetchRelatedRefs(ctx.client, issueKey);
    related = r.refs;
    warnings.push(...r.warnings);
  }

  const days = issue.updated ? wholeDaysBetween(issue.updated, now) : 0;
  const signals = {
    is_overdue: isOverdue(issue.dueDate, now),
    days_since_update: days,
    is_stale: issue.updated ? days >= DEFAULT_STALE_DAYS : false,
    has_assignee: !!issue.assignee,
    comment_count: fetchedComments.comments.length,
  };

  const open: string[] = [];
  if (signals.is_overdue) open.push("期限超過 — 対応状況を確認してください");
  if (signals.is_stale) {
    open.push(`${signals.days_since_update}日間更新なし — 停滞の原因を確認してください`);
  }
  const next = signals.has_assignee ? [] : ["担当者を設定してください"];

  return analysisEnvelope(
    ctx,
    "issue_context",
    {
      issue: {
        issue_key: issue.issueKey,
        summary: issue.summary,
        ...(!compact && issue.description ? { description: issue.description } : {}),
        ...(issue.status ? { status: idName(issue.status) } : {}),
        ...(issue.priority ? { priority: idName(issue.priority) } : {}),
        ...(issue.issueType ? { issue_type: idName(issue.issueType) } : {}),
        ...(issue.assignee ? { assignee: userRef(issue.assignee) } : {}),
        ...(issue.createdUser ? { reporter: userRef(issue.createdUser) } : {}),
        categories: idNames(issue.category),
        milestones: idNames(issue.milestone),
        ...(issue.dueDate ? { due_date: issue.dueDate } : {}),
        ...(issue.startDate ? { start_date: issue.startDate } : {}),
        ...(issue.created ? { created: issue.created } : {}),
        ...(issue.updated ? { updated: issue.updated } : {}),
      },
      meta: {
        statuses: statuses.map((s) => ({
          id: s.id,
          projectId: s.projectId,
          name: s.name,
          ...(s.color ? { color: s.color } : {}),
          displayOrder: s.displayOrder,
        })),
      },
      // 新しい順の先頭 N 件。コメントの総数はページングで数えた件数(上限つき)。
      recent_comments: fetchedComments.comments.slice(0, maxComments).map((c) => ({
        id: c.id,
        content: compact ? "" : (c.content ?? ""),
        ...(c.createdUser ? { author: userRef(c.createdUser) } : {}),
        ...(c.created ? { created: c.created } : {}),
      })),
      signals,
      truncated: fetchedComments.truncated,
      llm_hints: llmHints([`issue:${issueKey}`], open, next),
      related_issues: related,
    },
    warnings,
  );
}
