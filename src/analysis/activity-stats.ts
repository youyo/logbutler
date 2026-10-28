/** activity_stats(logvalet `internal/analysis/activity_stats.go`)。 */
import { fetchByCursor } from "../backlog/paging";
import { ArgumentError } from "../errors";
import { formatYmd, positiveOr, resolveUserId, seg } from "../mcp/args";
import type { ToolContext } from "../mcp/registry";
import { activityTypeName } from "./activity-types";
import { formatInZone, hourIn, resolveRange, weekdayIn, ymdIn } from "./dates";
import { analysisEnvelope, type Warning, warningFromError } from "./envelope";
import { ISSUE_CAP } from "./issues";

export const DEFAULT_TOP_N = 5;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

interface BacklogActivity {
  id: number;
  type: number;
  created?: string | null;
  createdUser?: { id: number; name: string } | null;
}

export interface ActivityStatsArgs {
  scope?: string;
  project_key?: string;
  user_id?: string;
  since?: string;
  until?: string;
  top_n?: number;
}

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

/** キーを昇順に並べた新しいオブジェクト(Go の map の JSON 出力と同じ並び)。 */
const sortedKeys = (m: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** 上位 3 件の合計 / 全体(0.0〜1.0)。 */
function concentration(counts: Record<string, number>, total: number): number {
  if (total === 0) return 0;
  const top3 = Object.values(counts)
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((s, n) => s + n, 0);
  return top3 / total;
}

/** count 降順 → 名前昇順で上位 topN 件。 */
function top<K extends string>(
  counts: Record<string, number>,
  total: number,
  topN: number,
  key: K,
): ({ [P in K]: string } & { count: number; ratio: number })[] {
  return Object.entries(counts)
    .sort(([an, ac], [bn, bc]) => bc - ac || (an < bn ? -1 : an > bn ? 1 : 0))
    .slice(0, topN)
    .map(
      ([name, count]) => ({ [key]: name, count, ratio: total > 0 ? count / total : 0 }) as never,
    );
}

export function aggregate(activities: readonly BacklogActivity[], timezone: string, topN: number) {
  const total = activities.length;
  const byType: Record<string, number> = {};
  const byActor: Record<string, number> = {};
  const byDate: Record<string, number> = {};
  const byHour: Record<string, number> = {};
  const byWeekday: number[] = [0, 0, 0, 0, 0, 0, 0];
  for (const a of activities) {
    bump(byType, activityTypeName(a.type));
    bump(byActor, a.createdUser?.name ? a.createdUser.name : "unknown");
    if (a.created) {
      const t = new Date(a.created);
      bump(byDate, formatYmd(ymdIn(t, timezone)));
      bump(byHour, String(hourIn(t, timezone)));
      byWeekday[weekdayIn(t, timezone)] = (byWeekday[weekdayIn(t, timezone)] ?? 0) + 1;
    }
  }

  // 最多の時間帯・曜日。同数なら小さい方(時間は 0 時側、曜日は日曜側)。
  let peakHour = 0;
  let peakHourCount = -1;
  for (const [h, c] of Object.entries(byHour)) {
    if (c > peakHourCount || (c === peakHourCount && Number(h) < peakHour)) {
      peakHour = Number(h);
      peakHourCount = c;
    }
  }
  let peakDow = -1;
  byWeekday.forEach((c, dow) => {
    if (c > 0 && c > (byWeekday[peakDow] ?? 0)) peakDow = dow;
  });

  return {
    total_count: total,
    by_type: sortedKeys(byType),
    by_actor: sortedKeys(byActor),
    by_date: sortedKeys(byDate),
    by_hour: byHour,
    top_active_actors: top(byActor, total, topN, "name"),
    top_active_types: top(byType, total, topN, "type"),
    patterns:
      total === 0
        ? { peak_hour: 0, peak_day_of_week: "", actor_concentration: 0, type_concentration: 0 }
        : {
            peak_hour: peakHour,
            peak_day_of_week: peakDow < 0 ? "" : WEEKDAYS[peakDow],
            actor_concentration: concentration(byActor, total),
            type_concentration: concentration(byType, total),
          },
  };
}

export async function buildActivityStats(ctx: ToolContext, args: ActivityStatsArgs) {
  const scope = args.scope || "space";
  if (scope !== "space" && scope !== "project" && scope !== "user") {
    throw new ArgumentError(`scope must be one of: project, user, space, got "${scope}"`);
  }
  const scopeKey =
    scope === "project"
      ? args.project_key?.trim()
      : scope === "user"
        ? args.user_id?.trim()
        : undefined;
  if (scope !== "space" && !scopeKey) {
    throw new ArgumentError(
      `${scope === "project" ? "project_key" : "user_id"} is required when scope=${scope}`,
    );
  }
  const topN = positiveOr(args.top_n, DEFAULT_TOP_N);
  const tz = ctx.timezone;
  const { since, until } = resolveRange({
    since: args.since || undefined,
    until: args.until || undefined,
    now: ctx.now(),
    timezone: tz,
    defaultDays: 7,
  });

  // スコープごとのパス。user の "me" は GetMyself で解決する(数値以外は argument_error)。
  const path =
    scope === "project"
      ? `/projects/${seg(scopeKey as string)}/activities`
      : scope === "user"
        ? `/users/${seg(await resolveUserId(ctx.client, scopeKey as string))}/activities`
        : "/space/activities";

  const warnings: Warning[] = [];
  let truncated = false;
  let activities: BacklogActivity[] = [];
  try {
    const r = await fetchByCursor<BacklogActivity>(
      async ({ maxId, count }) => {
        const batch =
          (await ctx.client.request<BacklogActivity[]>("GET", path, { query: { count, maxId } })) ??
          [];
        // 新しい順。since より古いものに届いたらそこで切る(短いページになるのでページングが終わる)。
        const at = batch.findIndex((a) => a.created && Date.parse(a.created) < since.getTime());
        return at < 0 ? batch : batch.slice(0, at);
      },
      (a) => a.id,
    );
    truncated = r.truncated;
    // until より新しいものは数えない。
    activities = r.items.filter((a) => !a.created || Date.parse(a.created) <= until.getTime());
    if (truncated) {
      warnings.push({
        code: "activities_truncated",
        message: `Only the latest ${ISSUE_CAP} activities were aggregated (page limit reached). The statistics may be incomplete.`,
        component: "activities",
        retryable: false,
      });
    }
  } catch (e) {
    warnings.push(
      warningFromError(
        e,
        "activities_fetch_failed",
        scope === "space"
          ? "failed to list space activities"
          : `failed to list ${scope} activities for ${scopeKey}`,
        "activities",
      ),
    );
  }

  const sinceText = formatInZone(since, tz);
  const untilText = formatInZone(until, tz);
  return analysisEnvelope(
    ctx,
    "activity_stats",
    {
      scope,
      ...(scopeKey ? { scope_key: scopeKey } : {}),
      since: sinceText,
      until: untilText,
      ...aggregate(activities, tz, topN),
      date_range: { since: sinceText, until: untilText },
      truncated,
    },
    warnings,
  );
}
