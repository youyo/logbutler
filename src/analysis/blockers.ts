/** project_blockers(logvalet `internal/analysis/blocker.go`)。 */
import type { BacklogClient } from "../backlog/client";
import { COMMENT_LOOKUP_BUDGET } from "./budget";
import { wholeDaysBetween } from "./dates";
import { type LlmHints, llmHints, type Warning, warningFromError } from "./envelope";
import { type BacklogIssue, compareKeys } from "./issues";
import { isOverdue, type UserRef, userRef } from "./stale";
import { isExcluded, statusName } from "./statuses";

export const DEFAULT_IN_PROGRESS_DAYS = 14;

const IN_PROGRESS_STATUS = "処理中";
const HIGH_PRIORITIES: readonly string[] = ["高", "最高"];
/** 最新コメントに含まれていたら阻害とみなす語(小文字。リストの順で最初の一致を使う)。 */
const BLOCKER_KEYWORDS: readonly string[] = [
  "ブロック",
  "待ち",
  "blocked",
  "pending",
  "依存",
  "待機",
  "対応待ち",
];

export type Severity = "HIGH" | "MEDIUM";
export interface BlockerSignal {
  code: "high_priority_unassigned" | "long_in_progress" | "overdue_open" | "blocked_by_keyword";
  message: string;
}

export interface BlockerIssue {
  issue_key: string;
  summary: string;
  status: string;
  priority?: string;
  assignee?: UserRef;
  due_date?: string;
  signals: BlockerSignal[];
  severity: Severity;
}

export interface BlockerResult {
  issues: BlockerIssue[];
  total_count: number;
  by_severity: Record<Severity, number>;
  truncated: boolean;
  llm_hints: LlmHints;
}

/** コメントを見ない 3 つのシグナル。 */
export function staticSignals(issue: BacklogIssue, now: Date, days: number): BlockerSignal[] {
  const signals: BlockerSignal[] = [];
  const priority = issue.priority?.name;
  if (priority && HIGH_PRIORITIES.includes(priority) && !issue.assignee) {
    signals.push({
      code: "high_priority_unassigned",
      message: `優先度「${priority}」で担当者未設定`,
    });
  }
  if (issue.status?.name === IN_PROGRESS_STATUS && issue.updated) {
    const since = wholeDaysBetween(issue.updated, now);
    if (since >= days) {
      signals.push({
        code: "long_in_progress",
        message: `「${issue.status.name}」のまま${since}日経過`,
      });
    }
  }
  if (issue.dueDate && isOverdue(issue.dueDate, now)) {
    signals.push({
      code: "overdue_open",
      message: `期限を${wholeDaysBetween(issue.dueDate, now)}日超過`,
    });
  }
  return signals;
}

/** HIGH: high_priority_unassigned か overdue_open がある。それ以外(long_in_progress など)は MEDIUM。 */
export function severityOf(signals: readonly BlockerSignal[]): Severity {
  return signals.some((s) => s.code === "high_priority_unassigned" || s.code === "overdue_open")
    ? "HIGH"
    : "MEDIUM";
}

export interface KeywordCheck {
  signals: Map<string, BlockerSignal>;
  warnings: Warning[];
  /** 予算を超えて確認しなかった課題がある。 */
  truncated: boolean;
}

/**
 * 最新コメントにキーワードがあるかを、課題ごとに 1 回ずつ調べる(直列)。
 * 1 回の呼び出しで調べる課題は budget 件まで(issue_key 昇順で先頭から)。超過分は調べず warning にする。
 * 失敗は握りつぶさず、まとめて 1 件の warning にする(401 は投げ直す)。
 */
export async function checkLatestComments(
  client: BacklogClient,
  issues: readonly BacklogIssue[],
  excluded: ReadonlySet<string>,
  budget: number = COMMENT_LOOKUP_BUDGET,
): Promise<KeywordCheck> {
  const candidates = issues
    .filter((i) => !isExcluded(i, excluded))
    .sort((a, b) => compareKeys(a.issueKey, b.issueKey));
  const targets = candidates.slice(0, budget);
  const out: KeywordCheck = { signals: new Map(), warnings: [], truncated: false };

  let failures = 0;
  let firstFailure: Warning | undefined;
  for (const issue of targets) {
    try {
      const comments = await client.request<{ content?: string }[]>(
        "GET",
        `/issues/${encodeURIComponent(issue.issueKey)}/comments`,
        { query: { count: 1, order: "desc" } },
      );
      const latest = comments?.[0]?.content?.toLowerCase();
      if (latest === undefined) continue;
      const keyword = BLOCKER_KEYWORDS.find((k) => latest.includes(k.toLowerCase()));
      if (keyword) {
        out.signals.set(issue.issueKey, {
          code: "blocked_by_keyword",
          message: `コメントに阻害キーワード: 「${keyword}」`,
        });
      }
    } catch (e) {
      const w = warningFromError(e, "comments_fetch_failed", "failed to list comments", "comments");
      failures++;
      firstFailure ??= w;
    }
  }
  if (firstFailure) {
    out.warnings.push({
      ...firstFailure,
      message: `failed to get the latest comment of ${failures} issue${failures === 1 ? "" : "s"} (first error: ${firstFailure.message})`,
    });
  }
  if (candidates.length > targets.length) {
    out.truncated = true;
    out.warnings.push({
      code: "comment_check_truncated",
      message: `Checked the latest comment of only the first ${targets.length} of ${candidates.length} open issues (API call budget). blocked_by_keyword may be incomplete.`,
      component: "comments",
      retryable: false,
    });
  }
  return out;
}

export function buildBlockers(input: {
  issues: readonly BacklogIssue[];
  projectKeys: readonly string[];
  now: Date;
  days: number;
  excluded: ReadonlySet<string>;
  keywordSignals?: ReadonlyMap<string, BlockerSignal>;
  truncated: boolean;
}): BlockerResult {
  const blockers: BlockerIssue[] = [];
  for (const issue of input.issues) {
    if (isExcluded(issue, input.excluded)) continue;
    const signals = staticSignals(issue, input.now, input.days);
    const keyword = input.keywordSignals?.get(issue.issueKey);
    if (keyword) signals.push(keyword);
    if (signals.length === 0) continue;
    blockers.push({
      issue_key: issue.issueKey,
      summary: issue.summary,
      status: statusName(issue),
      ...(issue.priority?.name ? { priority: issue.priority.name } : {}),
      ...(issue.assignee ? { assignee: userRef(issue.assignee) } : {}),
      ...(issue.dueDate ? { due_date: issue.dueDate } : {}),
      signals,
      severity: severityOf(signals),
    });
  }
  const order = { HIGH: 0, MEDIUM: 1 } as const;
  blockers.sort(
    (a, b) => order[a.severity] - order[b.severity] || compareKeys(a.issue_key, b.issue_key),
  );

  const bySeverity: Record<Severity, number> = { HIGH: 0, MEDIUM: 0 };
  for (const b of blockers) bySeverity[b.severity]++;

  const open: string[] = [];
  if (blockers.length > 0)
    open.push(`${blockers.length}件のブロッカー課題があります。対応を優先してください`);
  if (bySeverity.HIGH > 0) open.push(`${bySeverity.HIGH}件が HIGH severity です`);

  return {
    issues: blockers,
    total_count: blockers.length,
    by_severity: bySeverity,
    truncated: input.truncated,
    llm_hints: llmHints(
      input.projectKeys.map((k) => `project:${k}`),
      open,
    ),
  };
}
