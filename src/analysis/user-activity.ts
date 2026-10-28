/**
 * user_activity(logvalet `internal/mcp/tools_user.go`、`internal/backlog/fetch_activities.go`)。
 *
 * 出力: logvalet はエンベロープなしの配列(`[]Activity`)だった。ADR 0004 の決定(ページングで集めるツールは
 * `truncated` を出力の最上位に常に載せる)に従うため、DigestEnvelope にして `digest.activities` に生の活動
 * (camelCase のまま)を入れ、`digest.truncated` を付けた。docs/tool-diff-from-logvalet.md に記録。
 */

import { parseCsvInts, positiveOrUndefined, resolveUserId, seg } from "../mcp/args";
import type { ToolContext } from "../mcp/registry";
import { fetchActivityRange } from "./activity-range";
import { formatInZone, optionalRange } from "./dates";
import { digestEnvelope, type Warning } from "./envelope";
import { ISSUE_CAP } from "./issues";

export const DEFAULT_USER_ACTIVITY_LIMIT = 20;

export interface UserActivityArgs {
  user_id: string;
  since?: string;
  until?: string;
  limit?: number;
  project?: string;
  activity_type_ids?: string;
}

export async function buildUserActivity(ctx: ToolContext, args: UserActivityArgs) {
  // 入力の検証は、Backlog を呼ぶ前にすべて済ませる。
  const typeIds = parseCsvInts("activity_type_ids", args.activity_type_ids);
  const tz = ctx.timezone;
  const { since, until } = optionalRange({
    since: args.since || undefined,
    until: args.until || undefined,
    timezone: tz,
  });
  const dated = !!since || !!until;
  // logvalet と同じく、limit は期間がないときだけ使う(期間があれば期間内を上限まで全部)。
  const limit = dated
    ? undefined
    : (positiveOrUndefined(args.limit) ?? DEFAULT_USER_ACTIVITY_LIMIT);

  const userId = await resolveUserId(ctx.client, args.user_id.trim());
  const { activities, truncated, hitPageCap } = await fetchActivityRange(
    ctx.client,
    `/users/${seg(userId)}/activities`,
    {
      since,
      until,
      limit,
      query: { activityTypeId: typeIds ?? [] },
    },
  );

  const warnings: Warning[] = [];
  if (hitPageCap) {
    warnings.push({
      code: "activities_truncated",
      message: `Only the latest ${ISSUE_CAP} activities were fetched (page limit reached). Narrow the period with since/until.`,
      component: "activities",
      retryable: false,
    });
  }
  // project は logvalet でも絞り込みに使われていなかった(説明文は client-side filter)。黙って無視せず知らせる。
  if (args.project?.trim()) {
    warnings.push({
      code: "project_filter_ignored",
      message:
        "The project filter is not applied to user activities (same as logvalet). Filter the returned activities yourself.",
      component: "project",
      retryable: false,
    });
  }

  return digestEnvelope(
    ctx,
    "user_activity",
    {
      user_id: userId,
      ...(since ? { since: formatInZone(since, tz) } : {}),
      ...(until ? { until: formatInZone(until, tz) } : {}),
      ...(limit === undefined ? {} : { limit }),
      total_count: activities.length,
      activities,
      truncated,
    },
    warnings,
  );
}
