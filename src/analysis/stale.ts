/** issue_stale(logvalet `internal/analysis/stale.go`)。 */
import { wholeDaysBetween } from "./dates";
import { type LlmHints, llmHints } from "./envelope";
import { type BacklogIssue, compareKeys } from "./issues";
import { isExcluded, statusName } from "./statuses";

export const DEFAULT_STALE_DAYS = 7;

export interface UserRef {
  id: number;
  name: string;
}
export const userRef = (u: { id: number; name: string } | null | undefined): UserRef | undefined =>
  u ? { id: u.id, name: u.name } : undefined;

/** 期限の超過(due_date < now)。logvalet と同じ瞬間比較。 */
export const isOverdue = (dueDate: string | null | undefined, now: Date): boolean =>
  !!dueDate && Date.parse(dueDate) < now.getTime();

export interface StaleIssue {
  issue_key: string;
  summary: string;
  status: string;
  assignee?: UserRef;
  days_since_update: number;
  last_updated: string;
  due_date?: string;
  is_overdue: boolean;
}

export interface StaleResult {
  issues: StaleIssue[];
  total_count: number;
  threshold_days: number;
  truncated: boolean;
  llm_hints: LlmHints;
}

/** updated のない課題・除外状態の課題は対象外。経過日数が days 以上なら停滞。 */
export function classifyStale(
  issue: BacklogIssue,
  now: Date,
  days: number,
  excluded: ReadonlySet<string>,
): StaleIssue | undefined {
  if (!issue.updated) return undefined;
  if (isExcluded(issue, excluded)) return undefined;
  const since = wholeDaysBetween(issue.updated, now);
  if (since < days) return undefined;
  return {
    issue_key: issue.issueKey,
    summary: issue.summary,
    status: statusName(issue),
    ...(issue.assignee ? { assignee: userRef(issue.assignee) } : {}),
    days_since_update: since,
    last_updated: issue.updated,
    ...(issue.dueDate ? { due_date: issue.dueDate } : {}),
    is_overdue: isOverdue(issue.dueDate, now),
  };
}

export function buildStale(input: {
  issues: readonly BacklogIssue[];
  projectKeys: readonly string[];
  now: Date;
  days: number;
  excluded: ReadonlySet<string>;
  truncated: boolean;
}): StaleResult {
  const stale = input.issues
    .map((i) => classifyStale(i, input.now, input.days, input.excluded))
    .filter((s): s is StaleIssue => s !== undefined)
    // 経過日数の降順。同順位は issue_key 昇順(logvalet は非安定ソート)。
    .sort(
      (a, b) => b.days_since_update - a.days_since_update || compareKeys(a.issue_key, b.issue_key),
    );

  const open: string[] = [];
  if (stale.length > 0)
    open.push(`${stale.length}件の停滞課題があります。対応状況を確認してください`);
  const overdue = stale.filter((s) => s.is_overdue).length;
  if (overdue > 0) open.push(`${overdue}件の停滞課題が期限超過しています`);

  return {
    issues: stale,
    total_count: stale.length,
    threshold_days: input.days,
    truncated: input.truncated,
    llm_hints: llmHints(
      input.projectKeys.map((k) => `project:${k}`),
      open,
    ),
  };
}
