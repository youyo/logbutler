/** project_health(logvalet `internal/analysis/health.go`)。課題一覧は 1 回だけ取得して共有する。 */
import { BacklogApiError, BacklogUnauthorizedError } from "../backlog/errors";
import { ConventionsError } from "../conventions/load";
import { loadProjectConventions } from "../conventions/show";
import type { ToolContext } from "../mcp/registry";
import { type AmbiguityResult, detectAmbiguities, emptyAmbiguity } from "./ambiguity";
import {
  type BlockerSignal,
  buildBlockers,
  checkLatestComments,
  DEFAULT_IN_PROGRESS_DAYS,
} from "./blockers";
import { analysisEnvelope, type LlmHints, llmHints, type Warning } from "./envelope";
import { fetchProjectIssues } from "./issues";
import { buildStale, DEFAULT_STALE_DAYS } from "./stale";
import { excludeSetFrom } from "./statuses";
import { buildWorkload } from "./workload";

const PENALTY = {
  stale: 5,
  blockerHigh: 10,
  blockerMedium: 5,
  overloaded: 8,
  unassignedRatio: 10,
  ambiguity: 2,
  maxAmbiguity: 20,
} as const;

export interface ScoreInput {
  stale: number;
  blockerHigh: number;
  blockerMedium: number;
  overloaded: number;
  unassigned: number;
  total: number;
  ambiguity: number;
}

/** 減点方式(下限 0)。未割当率は実数で 20% を超えたら減点(logvalet は整数除算だった)。 */
export function calcHealthScore(i: ScoreInput): number {
  let score = 100;
  score -= i.stale * PENALTY.stale;
  score -= i.blockerHigh * PENALTY.blockerHigh;
  score -= i.blockerMedium * PENALTY.blockerMedium;
  score -= i.overloaded * PENALTY.overloaded;
  // unassigned / total > 20%  ⇔  unassigned * 5 > total
  if (i.total > 0 && i.unassigned * 5 > i.total) score -= PENALTY.unassignedRatio;
  score -= Math.min(i.ambiguity * PENALTY.ambiguity, PENALTY.maxAmbiguity);
  return Math.max(score, 0);
}

export const calcHealthLevel = (score: number): "healthy" | "warning" | "critical" =>
  score >= 80 ? "healthy" : score >= 60 ? "warning" : "critical";

export interface HealthArgs {
  project_key: string;
  days?: number;
  include_comments?: boolean;
  exclude_status?: string;
}

interface Summaries {
  stale: { total_count: number; threshold_days: number; overdue_count: number };
  blocker: { total_count: number; high_count: number; medium_count: number };
  workload: {
    total_issues: number;
    unassigned_count: number;
    overloaded_count: number;
    high_load_count: number;
  };
  ambiguities: AmbiguityResult;
}

const zero = (): Summaries => ({
  stale: { total_count: 0, threshold_days: 0, overdue_count: 0 },
  blocker: { total_count: 0, high_count: 0, medium_count: 0 },
  workload: { total_issues: 0, unassigned_count: 0, overloaded_count: 0, high_load_count: 0 },
  ambiguities: emptyAmbiguity(),
});

function hints(projectKey: string, s: Summaries): LlmHints {
  const open: string[] = [];
  if (s.stale.total_count > 0) open.push(`${s.stale.total_count}件の停滞課題があります`);
  if (s.blocker.high_count > 0) open.push(`${s.blocker.high_count}件の HIGH ブロッカーがあります`);
  if (s.workload.overloaded_count > 0)
    open.push(`${s.workload.overloaded_count}人のメンバーが過負荷状態です`);
  if (s.ambiguities.total_count > 0) open.push(`${s.ambiguities.total_count}件の曖昧さがあります`);
  return llmHints([`project:${projectKey}`], open);
}

export async function analyzeProjectHealth(ctx: ToolContext, args: HealthArgs) {
  const projectKey = args.project_key.trim();
  const now = ctx.now();
  const excluded = excludeSetFrom(args.exclude_status);
  const days = args.days !== undefined && args.days > 0 ? args.days : undefined;

  // 課題一覧は 1 回だけ取得し、4 つの分析で共有する。
  const fetched = await fetchProjectIssues(ctx.client, projectKey);
  const warnings: Warning[] = [...fetched.warnings];

  if (fetched.failed) {
    const s = zero();
    return analysisEnvelope(
      ctx,
      "project_health",
      {
        project_key: projectKey,
        stale_summary: s.stale,
        blocker_summary: s.blocker,
        workload_summary: s.workload,
        ambiguities: s.ambiguities,
        health_score: 0,
        health_level: "critical",
        truncated: false,
        llm_hints: hints(projectKey, s),
      },
      warnings,
    );
  }

  let truncated = fetched.truncated;
  const stale = buildStale({
    issues: fetched.issues,
    projectKeys: [projectKey],
    now,
    days: days ?? DEFAULT_STALE_DAYS,
    excluded,
    truncated,
  });

  let keywordSignals: Map<string, BlockerSignal> | undefined;
  if (args.include_comments) {
    const check = await checkLatestComments(ctx.client, fetched.issues, excluded);
    keywordSignals = check.signals;
    warnings.push(...check.warnings);
    truncated ||= check.truncated;
  }
  const blockers = buildBlockers({
    issues: fetched.issues,
    projectKeys: [projectKey],
    now,
    days: days ?? DEFAULT_IN_PROGRESS_DAYS,
    excluded,
    keywordSignals,
    truncated,
  });
  const workload = buildWorkload({
    projectKey,
    issues: fetched.issues,
    now,
    staleDays: days ?? DEFAULT_STALE_DAYS,
    excluded,
    truncated,
  });

  let ambiguities = emptyAmbiguity();
  try {
    const { result } = await loadProjectConventions(ctx.client, projectKey);
    ambiguities = {
      adopted: result.adopted,
      total_count: 0,
      ambiguities:
        result.adopted && result.conventions
          ? detectAmbiguities(result.conventions, fetched.issues, now)
          : [],
    };
    ambiguities.total_count = ambiguities.ambiguities.length;
  } catch (e) {
    if (e instanceof BacklogUnauthorizedError) throw e;
    if (!(e instanceof ConventionsError || e instanceof BacklogApiError)) throw e;
    warnings.push({
      code: "ambiguity_detect_failed",
      message: `ambiguity detection failed: ${e.message}`,
      component: "ambiguity",
      retryable: true,
    });
  }

  const summaries: Summaries = {
    stale: {
      total_count: stale.total_count,
      threshold_days: stale.threshold_days,
      overdue_count: stale.issues.filter((i) => i.is_overdue).length,
    },
    blocker: {
      total_count: blockers.total_count,
      high_count: blockers.by_severity.HIGH,
      medium_count: blockers.by_severity.MEDIUM,
    },
    workload: {
      total_issues: workload.total_issues,
      unassigned_count: workload.unassigned_count,
      overloaded_count: workload.members.filter((m) => m.load_level === "overloaded").length,
      high_load_count: workload.members.filter((m) => m.load_level === "high").length,
    },
    ambiguities,
  };
  const score = calcHealthScore({
    stale: summaries.stale.total_count,
    blockerHigh: summaries.blocker.high_count,
    blockerMedium: summaries.blocker.medium_count,
    overloaded: summaries.workload.overloaded_count,
    unassigned: summaries.workload.unassigned_count,
    total: summaries.workload.total_issues,
    ambiguity: ambiguities.total_count,
  });

  return analysisEnvelope(
    ctx,
    "project_health",
    {
      project_key: projectKey,
      stale_summary: summaries.stale,
      blocker_summary: summaries.blocker,
      workload_summary: summaries.workload,
      ambiguities,
      health_score: score,
      health_level: calcHealthLevel(score),
      truncated,
      llm_hints: hints(projectKey, summaries),
    },
    warnings,
  );
}
