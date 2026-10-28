/** activity_digest(logvalet `internal/digest/activity.go`)。 */
import { boundedCount, seg } from "../mcp/args";
import type { ToolContext } from "../mcp/registry";
import type { BacklogActivity } from "./activity-range";
import { activityTypeName } from "./activity-types";
import { formatInZone, optionalRange } from "./dates";
import { digestEnvelope, llmHints, type Warning, warningFromError } from "./envelope";
import { extractProjectKey } from "./issue-detail";
import { type UserRef, userRef } from "./stale";

export const DEFAULT_ACTIVITY_LIMIT = 20;
/** issue_commented */
const COMMENTED = 3;

export interface ActivityDigestArgs {
  since?: string;
  until?: string;
  limit?: number;
  project?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** content の課題参照。id も key もなければ undefined(logvalet の `extractIssueRef`)。 */
function issueRef(content: Record<string, unknown>) {
  const id = num(content.id);
  const key = str(content.key);
  if (id === undefined && key === undefined) return undefined;
  const summary = str(content.summary);
  return { id: id ?? 0, key: key ?? "", ...(summary ? { summary } : {}) };
}

/** content のコメント参照(logvalet の `extractCommentRef`)。 */
function commentRef(content: Record<string, unknown>) {
  if (!isRecord(content.comment)) return undefined;
  const id = num(content.comment.id) ?? 0;
  const text = str(content.comment.content);
  return { id, ...(text ? { content: text } : {}) };
}

const byKeyAsc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedObject = <T>(m: Map<string, T>): Record<string, T> =>
  Object.fromEntries([...m.entries()].sort(([a], [b]) => byKeyAsc(a, b)));

export async function buildActivityDigest(ctx: ToolContext, args: ActivityDigestArgs) {
  // 入力の検証は、Backlog を呼ぶ前にすべて済ませる。
  const limit = boundedCount("limit", args.limit) ?? DEFAULT_ACTIVITY_LIMIT;
  const tz = ctx.timezone;
  const { since, until } = optionalRange({
    since: args.since || undefined,
    until: args.until || undefined,
    timezone: tz,
  });
  const project = args.project?.trim() || undefined;
  const path = project ? `/projects/${seg(project)}/activities` : "/space/activities";

  // 取得は 1 回(最新 limit 件)。期間は取得後に絞る。logvalet は since / until をエコーするだけだった。
  const warnings: Warning[] = [];
  let fetched: BacklogActivity[] = [];
  try {
    fetched =
      (await ctx.client.request<BacklogActivity[]>("GET", path, { query: { count: limit } })) ?? [];
  } catch (e) {
    warnings.push(
      warningFromError(e, "activities_fetch_failed", "failed to fetch activities", "activities"),
    );
  }

  const inRange = (a: BacklogActivity): boolean => {
    if (!since && !until) return true;
    if (!a.created) return false; // 期間に入っているか分からないものは含めない
    const t = Date.parse(a.created);
    return (!since || t >= since.getTime()) && (!until || t <= until.getTime());
  };
  const raw = fetched.filter(inRange);

  // limit 件ちょうど取れたら、それより古い活動があるかもしれない。ただし、取れた中で最も古いものが
  // since より前なら、期間の端まで届いているので続きはない。
  const oldest = fetched.at(-1)?.created;
  const reachedSince = !!since && !!oldest && Date.parse(oldest) < since.getTime();
  const truncated = fetched.length >= limit && !reachedSince;

  const activities = raw.map((a) => {
    const content = isRecord(a.content) ? a.content : undefined;
    const actor = userRef(a.createdUser);
    const issue = content ? issueRef(content) : undefined;
    const comment = content ? commentRef(content) : undefined;
    return {
      id: a.id,
      type: activityTypeName(a.type),
      ...(a.created ? { created: a.created } : {}),
      ...(actor ? { actor } : {}),
      ...(issue ? { issue } : {}),
      ...(comment ? { comment } : {}),
    };
  });

  const comments: { id: number; content: string; author?: UserRef; created?: string }[] = [];
  for (const a of raw) {
    if (a.type !== COMMENTED || !isRecord(a.content) || !isRecord(a.content.comment)) continue;
    const author = userRef(a.createdUser);
    comments.push({
      id: num(a.content.comment.id) ?? 0,
      content: str(a.content.comment.content) ?? "",
      ...(author ? { author } : {}),
      ...(a.created ? { created: a.created } : {}),
    });
  }

  // プロジェクト別: content.key(課題キー)の接頭辞で数える。
  const perProject = new Map<string, { activity_count: number; comment_count: number }>();
  for (const a of raw) {
    const key = isRecord(a.content) ? str(a.content.key) : undefined;
    if (!key) continue;
    const projectKey = extractProjectKey(key);
    if (!projectKey) continue;
    const s = perProject.get(projectKey) ?? { activity_count: 0, comment_count: 0 };
    s.activity_count++;
    if (a.type === COMMENTED) s.comment_count++;
    perProject.set(projectKey, s);
  }

  const types = new Map<string, number>();
  const issueKeys = new Set<string>();
  const projectKeys = new Set<string>();
  for (const a of activities) {
    types.set(a.type, (types.get(a.type) ?? 0) + 1);
    if (a.issue?.key) {
      issueKeys.add(a.issue.key);
      const pk = extractProjectKey(a.issue.key);
      if (pk) projectKeys.add(pk);
    }
  }
  // 並びは昇順に固定(logvalet は Go の map の順で非決定的だった)
  const relatedIssueKeys = [...issueKeys].sort(byKeyAsc);
  const relatedProjectKeys = [...projectKeys].sort(byKeyAsc);

  return digestEnvelope(
    ctx,
    "activity",
    {
      scope: {
        ...(project ? { project } : {}),
        ...(since ? { since: formatInZone(since, tz) } : {}),
        ...(until ? { until: formatInZone(until, tz) } : {}),
        limit,
      },
      activities,
      comments,
      projects: sortedObject(perProject),
      summary: {
        headline: project
          ? `activity digest for project ${project} (${activities.length} items)`
          : `activity digest (${activities.length} items)`,
        total_activity: activities.length,
        comment_count: comments.length,
        types: sortedObject(types),
        related_issue_keys: relatedIssueKeys,
        related_project_keys: relatedProjectKeys,
      },
      llm_hints: llmHints([...relatedIssueKeys, ...relatedProjectKeys]),
      truncated,
    },
    warnings,
  );
}
