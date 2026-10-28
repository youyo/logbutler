/** issue_triage_materials(logvalet `internal/analysis/triage.go`)。 */
import { seg } from "../mcp/args";
import type { ToolContext } from "../mcp/registry";
import { wholeDaysBetween } from "./dates";
import { analysisEnvelope, type Warning } from "./envelope";
import {
  extractProjectKey,
  fetchAllComments,
  fetchRelatedRefs,
  idName,
  idNames,
} from "./issue-detail";
import { type BacklogIssue, fetchProjectIssues } from "./issues";
import { DEFAULT_STALE_DAYS, isOverdue, userRef } from "./stale";
import { DONE_STATUSES } from "./statuses";

const UNASSIGNED = "未割当";
const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

export function projectStats(issues: readonly BacklogIssue[]) {
  const done = new Set(DONE_STATUSES);
  const by_status: Record<string, number> = {};
  const by_priority: Record<string, number> = {};
  const by_assignee: Record<string, number> = {};
  let closeDays = 0;
  let closed = 0;
  for (const i of issues) {
    const status = i.status?.name ?? "";
    if (status !== "") bump(by_status, status);
    if (i.priority?.name) bump(by_priority, i.priority.name);
    bump(by_assignee, i.assignee ? i.assignee.name : UNASSIGNED);
    // Backlog に完了日の項目はないので、updated を完了日の近似として使う(logvalet と同じ)。
    if (status !== "" && done.has(status) && i.created && i.updated) {
      const days = (Date.parse(i.updated) - Date.parse(i.created)) / 86_400_000;
      if (days >= 0) {
        closeDays += days;
        closed++;
      }
    }
  }
  return {
    total_issues: issues.length,
    by_status,
    by_priority,
    by_assignee,
    avg_close_days: closed > 0 ? closeDays / closed : 0,
  };
}

/** 対象自身を除いた、同カテゴリ・同マイルストーンの課題の分布。 */
export function similarIssues(target: BacklogIssue, issues: readonly BacklogIssue[]) {
  const categoryIds = new Set((target.category ?? []).map((c) => c.id));
  const milestoneIds = new Set((target.milestone ?? []).map((m) => m.id));
  const priority_distribution: Record<string, number> = {};
  const assignee_distribution: Record<string, number> = {};
  let same_category_count = 0;
  let same_milestone_count = 0;
  for (const i of issues) {
    if (i.issueKey === target.issueKey) continue;
    if ((i.category ?? []).some((c) => categoryIds.has(c.id))) {
      same_category_count++;
      if (i.priority?.name) bump(priority_distribution, i.priority.name);
      if (i.assignee) bump(assignee_distribution, i.assignee.name);
    }
    if ((i.milestone ?? []).some((m) => milestoneIds.has(m.id))) same_milestone_count++;
  }
  return {
    same_category_count,
    same_milestone_count,
    priority_distribution,
    assignee_distribution,
  };
}

export async function buildTriageMaterials(
  ctx: ToolContext,
  args: { issue_key: string; include_related_issues?: boolean },
) {
  const issueKey = args.issue_key.trim();
  const now = ctx.now();
  const warnings: Warning[] = [];

  const issue = await ctx.client.request<BacklogIssue>("GET", `/issues/${seg(issueKey)}`);

  // 統計用にプロジェクトの課題を全件(上限つき)取る。失敗は warning にして統計を空にする。
  const project = await fetchProjectIssues(ctx.client, extractProjectKey(issueKey), {
    projectComponent: "project_stats",
    issuesComponent: "project_stats",
  });
  warnings.push(...project.warnings);

  const comments = await fetchAllComments(ctx.client, issueKey, "history.comment_count");
  warnings.push(...comments.warnings);

  let related: Awaited<ReturnType<typeof fetchRelatedRefs>>["refs"] = [];
  if (args.include_related_issues !== false) {
    const r = await fetchRelatedRefs(ctx.client, issueKey);
    related = r.refs;
    warnings.push(...r.warnings);
  }

  const daysUpdated = issue.updated ? wholeDaysBetween(issue.updated, now) : 0;
  return analysisEnvelope(
    ctx,
    "issue_triage_materials",
    {
      issue: {
        issue_key: issue.issueKey,
        summary: issue.summary,
        ...(issue.status ? { status: idName(issue.status) } : {}),
        ...(issue.priority ? { priority: idName(issue.priority) } : {}),
        ...(issue.issueType ? { issue_type: idName(issue.issueType) } : {}),
        ...(issue.assignee ? { assignee: userRef(issue.assignee) } : {}),
        ...(issue.createdUser ? { reporter: userRef(issue.createdUser) } : {}),
        categories: idNames(issue.category),
        milestones: idNames(issue.milestone),
        ...(issue.dueDate ? { due_date: issue.dueDate } : {}),
        ...(issue.created ? { created: issue.created } : {}),
        ...(issue.updated ? { updated: issue.updated } : {}),
      },
      history: {
        comment_count: comments.comments.length,
        days_since_created: issue.created ? wholeDaysBetween(issue.created, now) : 0,
        days_since_updated: daysUpdated,
        is_overdue: isOverdue(issue.dueDate, now),
        is_stale: issue.updated ? daysUpdated >= DEFAULT_STALE_DAYS : false,
      },
      project_stats: projectStats(project.issues),
      similar_issues: similarIssues(issue, project.issues),
      related_issues: related,
      truncated: project.truncated || comments.truncated,
    },
    warnings,
  );
}
