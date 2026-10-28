/** user_workload(logvalet `internal/analysis/workload.go`)。 */
import { wholeDaysBetween } from "./dates";
import { type LlmHints, llmHints } from "./envelope";
import type { BacklogIssue } from "./issues";
import { isOverdue } from "./stale";
import { isExcluded, statusName } from "./statuses";

export const OVERLOADED_THRESHOLD = 20;
export const HIGH_THRESHOLD = 10;
export const MEDIUM_THRESHOLD = 5;

export type LoadLevel = "low" | "medium" | "high" | "overloaded";

export interface MemberWorkload {
  user_id: number;
  name: string;
  total: number;
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
  overdue: number;
  stale: number;
  load_level: LoadLevel;
}

export interface WorkloadResult {
  project_key: string;
  total_issues: number;
  unassigned_count: number;
  stale_threshold_days: number;
  members: MemberWorkload[];
  truncated: boolean;
  llm_hints: LlmHints;
}

export const loadLevelOf = (total: number): LoadLevel =>
  total >= OVERLOADED_THRESHOLD
    ? "overloaded"
    : total >= HIGH_THRESHOLD
      ? "high"
      : total >= MEDIUM_THRESHOLD
        ? "medium"
        : "low";

const bump = (m: Record<string, number>, key: string) => {
  m[key] = (m[key] ?? 0) + 1;
};

export function buildWorkload(input: {
  projectKey: string;
  issues: readonly BacklogIssue[];
  now: Date;
  staleDays: number;
  excluded: ReadonlySet<string>;
  truncated: boolean;
}): WorkloadResult {
  const members = new Map<number, MemberWorkload>();
  let total = 0;
  let unassigned = 0;
  for (const issue of input.issues) {
    if (isExcluded(issue, input.excluded)) continue;
    total++;
    if (!issue.assignee) {
      unassigned++;
      continue;
    }
    let m = members.get(issue.assignee.id);
    if (!m) {
      m = {
        user_id: issue.assignee.id,
        name: issue.assignee.name,
        total: 0,
        by_status: {},
        by_priority: {},
        overdue: 0,
        stale: 0,
        load_level: "low",
      };
      members.set(issue.assignee.id, m);
    }
    m.total++;
    const status = statusName(issue);
    if (status !== "") bump(m.by_status, status);
    if (issue.priority) bump(m.by_priority, issue.priority.name);
    if (isOverdue(issue.dueDate, input.now)) m.overdue++;
    if (issue.updated && wholeDaysBetween(issue.updated, input.now) >= input.staleDays) m.stale++;
  }
  const list = [...members.values()].sort((a, b) => a.user_id - b.user_id);
  for (const m of list) m.load_level = loadLevelOf(m.total);
  return {
    project_key: input.projectKey,
    total_issues: total,
    unassigned_count: unassigned,
    stale_threshold_days: input.staleDays,
    members: list,
    truncated: input.truncated,
    llm_hints: workloadHints(input.projectKey, list),
  };
}

export function workloadHints(projectKey: string, members: readonly MemberWorkload[]): LlmHints {
  const open: string[] = [];
  const over = members.filter((m) => m.load_level === "overloaded").length;
  const high = members.filter((m) => m.load_level === "high").length;
  if (over > 0) open.push(`${over}人のメンバーがoverloadedです。タスクの再配分を検討してください`);
  if (high > 0) open.push(`${high}人のメンバーが高負荷（high）です`);
  return llmHints([`project:${projectKey}`], open);
}
