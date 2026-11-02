/**
 * 課題 1 件の要約(snake_case)。`issue_list` の `detail=summary`(ADR 0016)と
 * `issue_get` の `detail=summary`(ADR 0017)が共有する。
 */
import { extractProjectKey } from "./issue-detail";

/** 要約の元になる、Backlog の課題の必要な項目だけ。 */
export interface SummarizableIssue {
  id: number;
  issueKey: string;
  summary: string;
  description?: string | null;
  issueType?: { name?: string } | null;
  status?: { name?: string } | null;
  priority?: { name?: string } | null;
  assignee?: { name?: string } | null;
  startDate?: string | null;
  dueDate?: string | null;
  parentIssueId?: number | null;
  created?: string;
  updated?: string;
}

/** 13 項目(description なし。`issue_list` 用)。ユーザーは名前だけ。 */
export function summarizeIssue(i: SummarizableIssue) {
  return {
    id: i.id,
    issue_key: i.issueKey,
    project_key: extractProjectKey(i.issueKey ?? ""),
    summary: i.summary,
    issue_type: i.issueType?.name ?? "",
    status: i.status?.name ?? "",
    priority: i.priority?.name ?? "",
    assignee: i.assignee?.name ?? null,
    start_date: i.startDate ?? null,
    due_date: i.dueDate ?? null,
    parent_issue_id: i.parentIssueId ?? null,
    created: i.created ?? "",
    updated: i.updated ?? "",
  };
}

/** 13 項目 + description 全文(`issue_get` 用)。 */
export function summarizeIssueWithDescription(i: SummarizableIssue) {
  return { ...summarizeIssue(i), description: i.description ?? "" };
}
