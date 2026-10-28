import { z } from "zod";
import { buildActivityStats } from "../../analysis/activity-stats";
import type { BlockerSignal } from "../../analysis/blockers";
import {
  buildBlockers,
  checkLatestComments,
  DEFAULT_IN_PROGRESS_DAYS,
} from "../../analysis/blockers";
import { API_BUDGET } from "../../analysis/budget";
import { buildIssueContext } from "../../analysis/context";
import { analysisEnvelope } from "../../analysis/envelope";
import { analyzeProjectHealth } from "../../analysis/health";
import { collectProjectIssues, fetchProjectIssues } from "../../analysis/issues";
import { buildMyTasks } from "../../analysis/my-tasks";
import { buildPeriodicDigest } from "../../analysis/periodic";
import { parseProjectKeys } from "../../analysis/projects";
import { buildStale, DEFAULT_STALE_DAYS } from "../../analysis/stale";
import { excludeSetFrom } from "../../analysis/statuses";
import { buildTimeline } from "../../analysis/timeline";
import { buildTriageMaterials } from "../../analysis/triage";
import { buildWorkload } from "../../analysis/workload";
import { optBool, optInt, optStr, positiveOr, reqStr, timezoneArg } from "../args";
import { defineTool } from "../registry";

export const issueContext = defineTool({
  name: "logbutler_issue_context",
  title: "課題コンテキスト取得",
  description: "Get structured issue context with signals and LLM hints for analysis",
  category: "ReadOnly",
  toolset: "analysis",
  inputSchema: z.object({
    issue_key: reqStr("Issue key (e.g. PROJ-123)"),
    comments: optInt("Max number of recent comments to include (default 10)"),
    compact: optBool("Omit description and comment bodies (default false)"),
    include_related_issues: optBool("Include related issues (default true)"),
  }),
  maxApiCalls: API_BUDGET.issueContext,
  handler: (a, ctx) => buildIssueContext(ctx, a),
});

export const projectBlockers = defineTool({
  name: "logbutler_project_blockers",
  title: "プロジェクトブロッカー一覧取得",
  description:
    "Detect project blocker issues (high priority unassigned, long in-progress, overdue)",
  category: "ReadOnly",
  toolset: "analysis",
  inputSchema: z.object({
    project_keys: reqStr("Comma-separated project keys (e.g. 'PROJ1,PROJ2')"),
    days: optInt("Days threshold for in-progress stagnation (default 14)"),
    include_comments: optBool(
      "Enable blocked-by-keyword detection via latest comment (default false)",
    ),
    exclude_status: optStr("Comma-separated status names to exclude (e.g. '完了,対応済み')"),
  }),
  maxApiCalls: API_BUDGET.projectBlockers,
  handler: async (a, ctx) => {
    const keys = parseProjectKeys(a.project_keys);
    const days = positiveOr(a.days, DEFAULT_IN_PROGRESS_DAYS);
    const excluded = excludeSetFrom(a.exclude_status);
    const fetched = await collectProjectIssues(ctx.client, keys);
    const warnings = [...fetched.warnings];
    let truncated = fetched.truncated;
    let keywordSignals: Map<string, BlockerSignal> | undefined;
    if (a.include_comments) {
      const check = await checkLatestComments(ctx.client, fetched.issues, excluded);
      keywordSignals = check.signals;
      warnings.push(...check.warnings);
      truncated ||= check.truncated;
    }
    const result = buildBlockers({
      issues: fetched.issues,
      projectKeys: keys,
      now: ctx.now(),
      days,
      excluded,
      keywordSignals,
      truncated,
    });
    return analysisEnvelope(ctx, "project_blockers", result, warnings);
  },
});

export const issueStale = defineTool({
  name: "logbutler_issue_stale",
  title: "停滞課題一覧取得",
  description: "Detect stale issues in specified projects",
  category: "ReadOnly",
  toolset: "analysis",
  inputSchema: z.object({
    project_keys: reqStr("Comma-separated project keys (e.g. 'PROJ1,PROJ2')"),
    days: optInt("Days threshold for stale detection (default 7)"),
    exclude_status: optStr("Comma-separated status names to exclude (e.g. '完了,対応済み')"),
  }),
  maxApiCalls: API_BUDGET.issueStale,
  handler: async (a, ctx) => {
    const keys = parseProjectKeys(a.project_keys);
    const days = positiveOr(a.days, DEFAULT_STALE_DAYS);
    // 更新の古い順に取る。1,000 件で打ち切られても、落ちるのは最近更新された(=停滞していない)側。
    const fetched = await collectProjectIssues(ctx.client, keys, { sort: "updated", order: "asc" });
    const result = buildStale({
      issues: fetched.issues,
      projectKeys: keys,
      now: ctx.now(),
      days,
      excluded: excludeSetFrom(a.exclude_status),
      truncated: fetched.truncated,
    });
    return analysisEnvelope(ctx, "stale_issues", result, fetched.warnings);
  },
});

export const projectHealth = defineTool({
  name: "logbutler_project_health",
  title: "プロジェクトヘルス取得",
  description: "Get project health summary (stale, blockers, workload, score)",
  category: "ReadOnly",
  toolset: "analysis",
  inputSchema: z.object({
    project_key: reqStr("Project key (e.g. PROJ)"),
    days: optInt("Days threshold for stale/blocker detection (default 7)"),
    include_comments: optBool("Enable blocked-by-keyword detection via comments (default false)"),
    exclude_status: optStr("Comma-separated status names to exclude (e.g. '完了,対応済み')"),
  }),
  maxApiCalls: API_BUDGET.projectHealth,
  handler: (a, ctx) => analyzeProjectHealth(ctx, a),
});

export const issueTriageMaterials = defineTool({
  name: "logbutler_issue_triage_materials",
  title: "課題トリアージ材料取得",
  description: "Get triage materials for an issue (stats, similar issues, history)",
  category: "ReadOnly",
  toolset: "analysis",
  inputSchema: z.object({
    issue_key: reqStr("Issue key (e.g. PROJ-123)"),
    include_related_issues: optBool("Include related issues (default true)"),
  }),
  maxApiCalls: API_BUDGET.issueTriageMaterials,
  handler: (a, ctx) => buildTriageMaterials(ctx, a),
});

export const digestWeekly = defineTool({
  name: "logbutler_digest_weekly",
  title: "週次ダイジェスト取得",
  description: "Generate weekly periodic digest for a project (completed/started/blocked)",
  category: "ReadOnly",
  toolset: "analysis",
  inputSchema: z.object({
    project_key: reqStr("Project key (e.g. PROJ)"),
    since: optStr("Start date in YYYY-MM-DD format (default: 7 days ago)"),
    until: optStr("End date in YYYY-MM-DD format (default: now)"),
    timezone: timezoneArg(),
  }),
  maxApiCalls: API_BUDGET.digestPeriodic,
  handler: (a, ctx) => buildPeriodicDigest(ctx, "weekly", a),
});

export const digestDaily = defineTool({
  name: "logbutler_digest_daily",
  title: "日次ダイジェスト取得",
  description: "Generate daily periodic digest for a project (completed/started/blocked)",
  category: "ReadOnly",
  toolset: "analysis",
  inputSchema: z.object({
    project_key: reqStr("Project key (e.g. PROJ)"),
    since: optStr("Start date in YYYY-MM-DD format (default: 1 day ago)"),
    until: optStr("End date in YYYY-MM-DD format (default: now)"),
    timezone: timezoneArg(),
  }),
  maxApiCalls: API_BUDGET.digestPeriodic,
  handler: (a, ctx) => buildPeriodicDigest(ctx, "daily", a),
});

export const activityStats = defineTool({
  name: "logbutler_activity_stats",
  title: "アクティビティ統計取得",
  description: "Get activity statistics (by type, actor, date, hour, patterns)",
  category: "ReadOnly",
  toolset: "analysis",
  inputSchema: z.object({
    scope: optStr("Activity scope: project, user, or space (default: space)"),
    project_key: optStr("Project key (required when scope=project)"),
    user_id: optStr("User ID (required when scope=user)"),
    since: optStr("Start date in YYYY-MM-DD format (default: 7 days ago)"),
    until: optStr("End date in YYYY-MM-DD format (default: now)"),
    top_n: optInt("Number of top actors/types to include (default: 5)"),
    timezone: timezoneArg(),
  }),
  maxApiCalls: API_BUDGET.activityStats,
  handler: (a, ctx) => buildActivityStats(ctx, a),
});

export const issueTimeline = defineTool({
  name: "logbutler_issue_timeline",
  title: "課題タイムライン取得",
  description: "Get comment and update timeline for an issue (structured chronological events)",
  category: "ReadOnly",
  toolset: "analysis",
  inputSchema: z.object({
    issue_key: reqStr("Issue key (e.g. PROJ-123)"),
    max_comments: optInt("Max number of comments to include (0 = all, default 0)"),
    include_updates: optBool("Include update history events (default true)"),
    max_activity_pages: optInt("Max pages for activity pagination (default 5)"),
    since: optStr("Filter events since date (YYYY-MM-DD)"),
    until: optStr("Filter events until date (YYYY-MM-DD)"),
    timezone: timezoneArg(),
  }),
  maxApiCalls: API_BUDGET.issueTimeline,
  handler: (a, ctx) => buildTimeline(ctx, a),
});

export const userWorkload = defineTool({
  name: "logbutler_user_workload",
  title: "ユーザー稼働状況取得",
  description: "Calculate user workload distribution for a project",
  category: "ReadOnly",
  toolset: "analysis",
  inputSchema: z.object({
    project_key: reqStr("Project key (e.g. PROJ)"),
    days: optInt("Days threshold for stale detection (default 7)"),
    exclude_status: optStr("Comma-separated status names to exclude (e.g. '完了,対応済み')"),
  }),
  maxApiCalls: API_BUDGET.userWorkload,
  handler: async (a, ctx) => {
    const projectKey = a.project_key.trim();
    const fetched = await fetchProjectIssues(ctx.client, projectKey);
    const result = buildWorkload({
      projectKey,
      issues: fetched.issues,
      now: ctx.now(),
      staleDays: positiveOr(a.days, DEFAULT_STALE_DAYS),
      excluded: excludeSetFrom(a.exclude_status),
      truncated: fetched.truncated,
    });
    return analysisEnvelope(ctx, "user_workload", result, fetched.warnings);
  },
});

export const myTasks = defineTool({
  name: "logbutler_my_tasks",
  title: "自分のタスク一覧取得",
  description:
    "Get your personal task dashboard: overdue, upcoming, and watched issues with stale/overdue signals",
  category: "ReadOnly",
  toolset: "analysis",
  inputSchema: z.object({
    mode: optStr(
      "View mode: 'week' (this week Mon-Sun, default) or 'next' (next 4-6 business days)",
    ),
    stale_days: optInt("Days threshold for stale detection on watched issues (default 7)"),
    timezone: timezoneArg(),
  }),
  maxApiCalls: API_BUDGET.myTasks,
  handler: (a, ctx) => buildMyTasks(ctx, a),
});
