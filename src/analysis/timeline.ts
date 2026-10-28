/** issue_timeline(logvalet `internal/analysis/timeline.go`)。 */
import { fetchByCursor } from "../backlog/paging";
import { ArgumentError } from "../errors";
import { positiveOr, seg } from "../mcp/args";
import type { ToolContext } from "../mcp/registry";
import { activityTypeName } from "./activity-types";
import { MAX_ACTIVITY_PAGES } from "./budget";
import { optionalRange } from "./dates";
import { analysisEnvelope, type Warning, warningFromError } from "./envelope";
import { extractProjectKey, fetchAllComments } from "./issue-detail";
import type { BacklogIssue } from "./issues";
import { type UserRef, userRef } from "./stale";

export const DEFAULT_ACTIVITY_PAGES = 5;
/** 課題の作成(1)・更新(2)・複数更新(14)。 */
const ACTIVITY_TYPES = [1, 2, 14];

export type EventKind = "comment" | "update" | "created";
const KIND_PRIORITY: Record<EventKind, number> = { created: 0, update: 1, comment: 2 };

interface Change {
  field: string;
  old_value?: string;
  new_value?: string;
}
interface TimelineEvent {
  id: number;
  kind: EventKind;
  activity_type?: string;
  timestamp?: string;
  actor?: UserRef;
  content?: string;
  changes?: Change[];
}

interface BacklogActivity {
  id: number;
  type: number;
  created?: string | null;
  createdUser?: { id: number; name: string } | null;
  content?: Record<string, unknown> | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** content.changes → changes。配列でなければ失敗(undefined)。 */
function extractChanges(a: BacklogActivity): { ok: boolean; changes?: Change[] } {
  const raw = a.content?.changes;
  if (raw === undefined || raw === null) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false };
  const changes: Change[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    changes.push({
      field: str(m.field),
      ...(str(m.old_value) ? { old_value: str(m.old_value) } : {}),
      ...(str(m.new_value) ? { new_value: str(m.new_value) } : {}),
    });
  }
  return { ok: true, changes: changes.length > 0 ? changes : undefined };
}

export interface TimelineArgs {
  issue_key: string;
  max_comments?: number;
  include_updates?: boolean;
  max_activity_pages?: number;
  since?: string;
  until?: string;
}

export async function buildTimeline(ctx: ToolContext, args: TimelineArgs) {
  const issueKey = args.issue_key.trim();
  const includeUpdates = args.include_updates !== false;
  const pages = positiveOr(args.max_activity_pages, DEFAULT_ACTIVITY_PAGES);
  if (pages > MAX_ACTIVITY_PAGES) {
    throw new ArgumentError(
      `max_activity_pages must be between 1 and ${MAX_ACTIVITY_PAGES}, got ${pages}`,
    );
  }
  const { since, until } = optionalRange({
    since: args.since || undefined,
    until: args.until || undefined,
    timezone: ctx.timezone,
  });
  const within = (iso: string | null | undefined): boolean => {
    if (!iso) return true; // 時刻のないものは期間で落とさない(logvalet と同じ)
    const t = Date.parse(iso);
    return (
      (since === undefined || t >= since.getTime()) && (until === undefined || t <= until.getTime())
    );
  };

  const issue = await ctx.client.request<BacklogIssue>("GET", `/issues/${seg(issueKey)}`);
  const warnings: Warning[] = [];
  let truncated = false;
  const events: TimelineEvent[] = [];

  // コメント(新しい順)。期間で絞ってから、max_comments があれば新しい方から N 件。
  const fetched = await fetchAllComments(ctx.client, issueKey, "events", {
    olderThan: since,
    truncatedNote: "Older comments are not included.",
  });
  warnings.push(...fetched.warnings);
  truncated ||= fetched.truncated;
  const max =
    args.max_comments !== undefined && args.max_comments > 0 ? args.max_comments : undefined;
  const comments = fetched.comments.filter((c) => within(c.created)).slice(0, max);
  for (const c of comments) {
    events.push({
      id: c.id,
      kind: "comment",
      ...(c.created ? { timestamp: c.created } : {}),
      ...(c.createdUser ? { actor: userRef(c.createdUser) } : {}),
      ...(c.content ? { content: c.content } : {}),
    });
  }

  if (includeUpdates) {
    try {
      const { items, truncated: more } = await fetchByCursor<BacklogActivity>(
        async ({ maxId, count }) => {
          const batch =
            (await ctx.client.request<BacklogActivity[]>(
              "GET",
              `/projects/${seg(extractProjectKey(issueKey))}/activities`,
              { query: { activityTypeId: ACTIVITY_TYPES, count, maxId } },
            )) ?? [];
          if (since === undefined) return batch;
          const at = batch.findIndex((a) => a.created && Date.parse(a.created) < since.getTime());
          return at < 0 ? batch : batch.slice(0, at);
        },
        (a) => a.id,
        { maxPages: pages },
      );
      const inRange = items.filter((a) => within(a.created));
      if (more) {
        truncated = true;
        warnings.push({
          code: "activity_pagination_truncated",
          message: `activity fetch truncated at ${pages} pages (${inRange.length} activities)`,
          component: "events",
          retryable: false,
        });
      }
      for (const a of inRange) {
        if (!ACTIVITY_TYPES.includes(a.type) || Number(a.content?.id) !== issue.id) continue;
        const { ok, changes } = extractChanges(a);
        if (!ok) {
          warnings.push({
            code: "activity_changes_parse_failed",
            message: `failed to parse changes for activity id=${a.id}`,
            component: "events",
            retryable: false,
          });
        }
        events.push({
          id: a.id,
          kind: a.type === 1 ? "created" : "update",
          activity_type: activityTypeName(a.type),
          ...(a.created ? { timestamp: a.created } : {}),
          ...(a.createdUser ? { actor: userRef(a.createdUser) } : {}),
          ...(changes ? { changes } : {}),
        });
      }
    } catch (e) {
      warnings.push(
        warningFromError(
          e,
          "activities_fetch_failed",
          `failed to list project activities for ${extractProjectKey(issueKey)}`,
          "events",
        ),
      );
    }
  }

  // 時系列の昇順。同時刻は created → update → comment、同じ種別は id 昇順。時刻のないものは末尾。
  events.sort((a, b) => {
    if (a.timestamp === undefined || b.timestamp === undefined) {
      if (a.timestamp === b.timestamp) return a.id - b.id;
      return a.timestamp === undefined ? 1 : -1;
    }
    return (
      Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
      KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
      a.id - b.id
    );
  });

  return analysisEnvelope(
    ctx,
    "issue_timeline",
    {
      issue_key: issue.issueKey,
      issue_summary: issue.summary,
      events,
      meta: {
        total_events: events.length,
        comment_count: events.filter((e) => e.kind === "comment").length,
        update_count: events.filter((e) => e.kind !== "comment").length,
        participant_count: new Set(events.flatMap((e) => (e.actor ? [e.actor.id] : []))).size,
      },
      truncated,
    },
    warnings,
  );
}
