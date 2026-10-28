/** digest_daily / digest_weekly(logvalet `internal/analysis/periodic.go`)。 */
import { formatYmd, resolveProjectId } from "../mcp/args";
import type { ToolContext } from "../mcp/registry";
import { formatInZone, resolveRange, ymdIn } from "./dates";
import { analysisEnvelope, llmHints, type Warning, warningFromError } from "./envelope";
import { type BacklogIssue, compareKeys, fetchIssuePages, ISSUE_CAP } from "./issues";
import { type UserRef, userRef } from "./stale";
import { DONE_STATUSES, statusName } from "./statuses";

export type Period = "daily" | "weekly";

/** ブロッカー判定のキーワード(ステータス名の一致、またはタイトルに含む)。 */
const BLOCKED_KEYWORDS: readonly string[] = ["対応中断", "保留", "ブロック", "blocked", "on hold"];

interface IssueRef {
  issue_key: string;
  summary: string;
  assignee: UserRef | null;
}
export interface PeriodicIssueRef extends IssueRef {
  completed_at?: string;
  started_at?: string;
}
export interface PeriodicBlockedIssue extends IssueRef {
  block_signals: string[];
}

const ref = (i: BacklogIssue): IssueRef => ({
  issue_key: i.issueKey,
  summary: i.summary,
  assignee: userRef(i.assignee) ?? null,
});

const inPeriod = (iso: string, since: Date, until: Date): boolean => {
  const t = Date.parse(iso);
  return t >= since.getTime() && t <= until.getTime();
};

function blockedSignals(issue: BacklogIssue): string[] {
  const status = statusName(issue).toLowerCase();
  const summary = issue.summary.toLowerCase();
  const signals: string[] = [];
  for (const kw of BLOCKED_KEYWORDS) {
    const lower = kw.toLowerCase();
    if (status === lower) {
      signals.push(`ステータス名がブロッカーキーワードに一致: ${JSON.stringify(kw)}`);
    } else if (summary.includes(lower)) {
      signals.push(`課題タイトルにブロッカーキーワードを含む: ${JSON.stringify(kw)}`);
    }
  }
  return signals;
}

/** 優先順位 completed > blocked > started。各リストは issue_key 昇順(API の返す順に依存しない)。 */
export function classifyPeriodic(issues: readonly BacklogIssue[], since: Date, until: Date) {
  const done = new Set(DONE_STATUSES);
  const completed: PeriodicIssueRef[] = [];
  const completedKeys = new Set<string>();
  for (const i of issues) {
    if (!done.has(statusName(i)) || !i.updated || !inPeriod(i.updated, since, until)) continue;
    completedKeys.add(i.issueKey);
    completed.push({ ...ref(i), completed_at: i.updated });
  }
  const blocked: PeriodicBlockedIssue[] = [];
  const blockedKeys = new Set<string>();
  for (const i of issues) {
    if (completedKeys.has(i.issueKey)) continue;
    const signals = blockedSignals(i);
    if (signals.length === 0) continue;
    blockedKeys.add(i.issueKey);
    blocked.push({ ...ref(i), block_signals: signals });
  }
  const started: PeriodicIssueRef[] = [];
  for (const i of issues) {
    if (completedKeys.has(i.issueKey) || blockedKeys.has(i.issueKey)) continue;
    if (done.has(statusName(i)) || !i.created || !inPeriod(i.created, since, until)) continue;
    started.push({ ...ref(i), started_at: i.created });
  }
  const byKey = (a: IssueRef, b: IssueRef) => compareKeys(a.issue_key, b.issue_key);
  return {
    completed: completed.sort(byKey),
    started: started.sort(byKey),
    blocked: blocked.sort(byKey),
  };
}

export async function buildPeriodicDigest(
  ctx: ToolContext,
  period: Period,
  args: { project_key: string; since?: string; until?: string },
) {
  const projectKey = args.project_key.trim();
  const tz = ctx.timezone;
  const { since, until } = resolveRange({
    since: args.since || undefined,
    until: args.until || undefined,
    now: ctx.now(),
    timezone: tz,
    defaultDays: period === "daily" ? 1 : 7,
  });

  // プロジェクトが取れなければ分析できない(ツールエラー)。課題一覧の失敗は warning。
  const projectId = await resolveProjectId(ctx.client, projectKey);
  const warnings: Warning[] = [];
  let issues: BacklogIssue[] = [];
  let truncated = false;
  try {
    const r = await fetchIssuePages(ctx.client, {
      projectId: [projectId],
      updatedSince: formatYmd(ymdIn(since, tz)),
      updatedUntil: formatYmd(ymdIn(until, tz)),
    });
    issues = r.issues;
    truncated = r.truncated;
    if (truncated) {
      warnings.push({
        code: "issues_truncated",
        message: `Only the first ${ISSUE_CAP} issues of project ${projectKey} were analyzed (page limit reached). The result may be incomplete.`,
        component: "periodic_digest",
        retryable: false,
      });
    }
  } catch (e) {
    warnings.push(
      warningFromError(e, "issues_fetch_failed", "failed to list issues", "periodic_digest"),
    );
  }

  const { completed, started, blocked } = classifyPeriodic(issues, since, until);
  return analysisEnvelope(
    ctx,
    "periodic_digest",
    {
      project_key: projectKey,
      period,
      since: formatInZone(since, tz),
      until: formatInZone(until, tz),
      summary: {
        completed_count: completed.length,
        started_count: started.length,
        blocked_count: blocked.length,
        total_active_count: issues.length,
      },
      completed,
      started,
      blocked,
      truncated,
      llm_hints: llmHints(
        [`project:${projectKey}`],
        blocked.length > 0 ? [`${blocked.length}件のブロック課題があります`] : [],
        completed.length > 0 ? [`${completed.length}件の完了課題をレビューしてください`] : [],
      ),
    },
    warnings,
  );
}
