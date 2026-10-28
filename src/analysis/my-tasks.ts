/** my_tasks(logvalet `internal/analysis/my_tasks.go`)。 */
import { fetchByOffset } from "../backlog/paging";
import { ArgumentError } from "../errors";
import { addDays, formatYmd, positiveOr, seg, type Ymd } from "../mcp/args";
import type { ToolContext } from "../mcp/registry";
import { formatInZone, startOfDay, wholeDaysBetween, ymdIn } from "./dates";
import { analysisEnvelope, type Warning, warningFromError } from "./envelope";
import { extractProjectKey } from "./issue-detail";
import { type BacklogIssue, fetchIssuePages, ISSUE_CAP } from "./issues";
import { collectOpenStatusIds } from "./open-statuses";
import { DEFAULT_STALE_DAYS, isOverdue } from "./stale";
import { DONE_STATUSES, isExcluded } from "./statuses";

/** next モードの日数オフセット: 月 +4 / 火〜金 +6 / 土 +5 / 日 +4。 */
export function nextModeOffset(weekday: number): number {
  switch (weekday) {
    case 1:
      return 4;
    case 6:
      return 5;
    case 0:
      return 4;
    default:
      return 6;
  }
}

const dayOfWeek = ({ y, m, d }: Ymd): number => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** week: 今週の月曜〜日曜。next: 今日から営業日 4〜6 日先まで。 */
export function dateRangeFor(mode: "week" | "next", today: Ymd): { since: Ymd; until: Ymd } {
  if (mode === "next")
    return { since: today, until: addDays(today, nextModeOffset(dayOfWeek(today))) };
  const dow = dayOfWeek(today);
  const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
  return { since: monday, until: addDays(monday, 6) };
}

interface TaskItem {
  issue_key: string;
  summary: string;
  status: string;
  priority: string;
  due_date: string | null;
  project_key: string;
}

const toItem = (i: BacklogIssue): TaskItem => ({
  issue_key: i.issueKey,
  summary: i.summary,
  status: i.status?.name ?? "",
  priority: i.priority?.name ?? "",
  due_date: i.dueDate ?? null,
  project_key: extractProjectKey(i.issueKey),
});

interface BacklogWatching {
  issue?: BacklogIssue | null;
  lastContentUpdated?: string | null;
}

export async function buildMyTasks(ctx: ToolContext, args: { mode?: string; stale_days?: number }) {
  const mode = args.mode || "week";
  if (mode !== "week" && mode !== "next") {
    throw new ArgumentError(`mode must be "week" or "next", got "${mode}"`);
  }
  const staleDays = positiveOr(args.stale_days, DEFAULT_STALE_DAYS);
  const tz = ctx.timezone;
  const now = ctx.now();
  const warnings: Warning[] = [];
  let truncated = false;

  const myself = await ctx.client.getMyself();
  const today = ymdIn(now, tz);
  const range = dateRangeFor(mode, today);
  // 未完了 = 完了集合以外の状態(カスタム状態を含む)。ID は参加プロジェクトの状態一覧から決める(ADR 0012)。
  const open = await collectOpenStatusIds(ctx.client);
  warnings.push(...open.warnings);
  if (open.truncated) truncated = true;
  const assignee = { assigneeId: [myself.id], statusId: open.ids };
  const done: ReadonlySet<string> = new Set(DONE_STATUSES);

  const collect = async (
    name: "overdue" | "upcoming",
    query: Record<string, string | number | number[]>,
  ): Promise<BacklogIssue[]> => {
    try {
      const r = await fetchIssuePages(ctx.client, { ...assignee, ...query });
      if (r.truncated) {
        truncated = true;
        warnings.push({
          code: `${name}_truncated`,
          message: `Only the first ${ISSUE_CAP} ${name} issues were returned (page limit reached). The result may be incomplete.`,
          component: name,
          retryable: false,
        });
      }
      // 状態 ID を決められなかったとき(statusId を送らない)も、完了集合の課題は出さない。
      return r.issues.filter((i) => !isExcluded(i, done));
    } catch (e) {
      warnings.push(
        warningFromError(e, `${name}_fetch_failed`, `${name} issues fetch failed`, name),
      );
      return [];
    }
  };

  const overdue = await collect("overdue", { dueDateUntil: formatYmd(addDays(today, -1)) });
  const upcoming = await collect("upcoming", {
    dueDateSince: formatYmd(range.since),
    dueDateUntil: formatYmd(range.until),
  });

  let watchings: BacklogWatching[] = [];
  try {
    const r = await fetchByOffset<BacklogWatching>(
      async ({ offset, count }) =>
        (await ctx.client.request<BacklogWatching[]>("GET", `/users/${seg(myself.id)}/watchings`, {
          query: { count, offset: offset > 0 ? offset : undefined },
        })) ?? [],
    );
    watchings = r.items;
    if (r.truncated) {
      truncated = true;
      warnings.push({
        code: "watching_truncated",
        message: `Only the first ${ISSUE_CAP} watched issues were returned (page limit reached). The result may be incomplete.`,
        component: "watching",
        retryable: false,
      });
    }
  } catch (e) {
    warnings.push(
      warningFromError(e, "watching_fetch_failed", "watchings fetch failed", "watching"),
    );
  }

  // overdue と upcoming は期間が重なりうる(今日が週の途中なら、週の頭〜昨日)。overdue を優先して重複を除く。
  const overdueKeys = new Set(overdue.map((i) => i.issueKey));
  const upcomingOnly = upcoming.filter((i) => !overdueKeys.has(i.issueKey));
  const assigned = new Set([...overdueKeys, ...upcomingOnly.map((i) => i.issueKey)]);

  const watching = [];
  for (const w of watchings) {
    const issue = w.issue;
    if (!issue || assigned.has(issue.issueKey)) continue;
    if (isExcluded(issue, done)) continue;
    const updated = w.lastContentUpdated || issue.updated;
    const days = updated ? wholeDaysBetween(updated, now) : 0;
    watching.push({
      ...toItem(issue),
      assignee: issue.assignee?.name ?? "",
      is_overdue: isOverdue(issue.dueDate, now),
      is_stale: updated ? days >= staleDays : false,
      days_since_update: days,
    });
  }

  const overdueItems = overdue.map(toItem);
  const upcomingItems = upcomingOnly.map(toItem);
  return analysisEnvelope(
    ctx,
    "my_tasks",
    {
      user: { id: myself.id, name: myself.name },
      mode,
      date_range: {
        since: formatInZone(startOfDay(range.since, tz), tz),
        until: formatInZone(startOfDay(range.until, tz), tz),
      },
      overdue: overdueItems,
      upcoming: upcomingItems,
      watching,
      summary: {
        overdue_count: overdueItems.length,
        upcoming_count: upcomingItems.length,
        watching_count: watching.length,
        total_count: overdueItems.length + upcomingItems.length + watching.length,
      },
      truncated,
    },
    warnings,
  );
}
