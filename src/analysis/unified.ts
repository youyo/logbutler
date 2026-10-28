/**
 * digest_unified(logvalet `internal/digest/unified.go`、`internal/mcp/tools_analysis.go`)。
 * プロジェクト・ユーザー・チーム・課題キーを合成した digest。logvalet から次を変えた(docs/tool-diff-from-logvalet.md):
 * - アクティビティは `maxId` のカーソルを必ず進める(logvalet は同じページを繰り返し、`until` 指定で止まらなかった)
 * - ページ数・入力の個数に上限を付け、最悪の API 呼び出し数を式で閉じる(ADR 0006)。並列呼び出しはしない
 * - `GetProject` は 1 回(logvalet は呼び出し側と Builder で 2 回)、`projectId[]` の重複なし
 * - `due_date` / `start_date` を `issue_list` と同じ解釈で課題一覧に渡す(logvalet はスキーマにあるのに未使用)
 * - `summary.by_user` を実際に集計する(logvalet は常に空)
 */
import { dateRangeFor, parseCsvInts, parseCsvStrings, seg } from "../mcp/args";
import type { ToolContext } from "../mcp/registry";
import { type BacklogActivity, fetchActivityRange } from "./activity-range";
import {
  MAX_PROJECT_KEYS,
  UNIFIED_ACTIVITY_PAGES,
  UNIFIED_MAX_ISSUE_KEYS,
  UNIFIED_MAX_TEAMS,
  UNIFIED_MAX_USERS,
} from "./budget";
import { optionalRange, ymdIn } from "./dates";
import { capList } from "./digest-args";
import { digestEnvelope, llmHints, type Warning, warningFromError } from "./envelope";
import { extractProjectKey } from "./issue-detail";
import { type BacklogIssue, fetchIssuePages, ISSUE_CAP } from "./issues";
import { fetchProject } from "./projects";
import { statusName } from "./statuses";

export interface UnifiedArgs {
  since: string;
  until?: string;
  project_keys?: string;
  user_ids?: string;
  team_ids?: string;
  issue_keys?: string;
  due_date?: string;
  start_date?: string;
}

interface BacklogTeam {
  id: number;
  name: string;
  members?: { id: number; name: string }[] | null;
}
interface BacklogUserLite {
  id: number;
  name: string;
}

interface ActivitySource {
  label: string;
  path: string;
}

export async function buildUnifiedDigest(ctx: ToolContext, args: UnifiedArgs) {
  // --- 入力の検証(Backlog を呼ぶ前にすべて済ませる) ---
  const tz = ctx.timezone;
  const { since, until } = optionalRange({
    since: args.since,
    until: args.until || undefined,
    timezone: tz,
  });
  const today = ymdIn(ctx.now(), tz);
  const due = args.due_date ? dateRangeFor("due_date", args.due_date, today) : undefined;
  const start = args.start_date ? dateRangeFor("start_date", args.start_date, today) : undefined;
  const projectKeys = capList("project_keys", parseCsvStrings(args.project_keys), MAX_PROJECT_KEYS);
  const explicitUserIds = capList(
    "user_ids",
    parseCsvInts("user_ids", args.user_ids) ?? [],
    UNIFIED_MAX_USERS,
  );
  const teamIds = capList(
    "team_ids",
    parseCsvInts("team_ids", args.team_ids) ?? [],
    UNIFIED_MAX_TEAMS,
  );
  const issueKeys = capList("issue_keys", parseCsvStrings(args.issue_keys), UNIFIED_MAX_ISSUE_KEYS);

  const client = ctx.client;
  const warnings: Warning[] = [];
  let truncated = false;

  // --- 1. チーム → メンバー ---
  const names = new Map<number, string>(); // チームのメンバーから分かる名前(GetUser を省く)
  const teamRefs: { id: number; name: string }[] = [];
  const memberIds: number[] = [];
  for (const id of teamIds) {
    try {
      const team = await client.request<BacklogTeam>("GET", `/teams/${seg(id)}`);
      teamRefs.push({ id: team.id, name: team.name });
      if ((team.members ?? []).length === 0) {
        // 取得の失敗ではないので、理由が分かるように伝える(メンバー 0 人では絞り込める相手がいない)
        warnings.push({
          code: "team_has_no_members",
          message: `team ${team.name} (ID=${id}) has no members`,
          component: `scope.teams.${id}`,
          retryable: false,
        });
      }
      for (const m of team.members ?? []) {
        memberIds.push(m.id);
        names.set(m.id, m.name);
      }
    } catch (e) {
      warnings.push(
        warningFromError(
          e,
          "team_fetch_failed",
          `failed to get team (ID=${id})`,
          `scope.teams.${id}`,
        ),
      );
    }
  }

  // --- 2. プロジェクトキー → ID(1 キー 1 回) ---
  const projectRefs: { id: number; key: string; name: string }[] = [];
  const projectIds: number[] = [];
  const resolvedProjectKeys: string[] = [];
  for (const key of projectKeys) {
    try {
      const p = await fetchProject(client, key);
      projectRefs.push({ id: p.id, key: p.projectKey, name: p.name });
      if (!projectIds.includes(p.id)) projectIds.push(p.id);
      resolvedProjectKeys.push(key);
    } catch (e) {
      warnings.push(
        warningFromError(
          e,
          "project_fetch_failed",
          `failed to resolve project "${key}"`,
          `scope.projects.${key}`,
        ),
      );
    }
  }

  // --- 3. ユーザー(明示 + チームのメンバー。重複なし、上限あり)→ 名前 ---
  let userIds = [...new Set([...explicitUserIds, ...memberIds])];
  if (userIds.length > UNIFIED_MAX_USERS) {
    warnings.push({
      code: "users_truncated",
      message: `Only the first ${UNIFIED_MAX_USERS} of ${userIds.length} users (user_ids plus team members) were used. Narrow the scope.`,
      component: "scope.users",
      retryable: false,
    });
    userIds = userIds.slice(0, UNIFIED_MAX_USERS);
    truncated = true;
  }
  const userRefs: { id: number; name: string }[] = [];
  for (const id of userIds) {
    const known = names.get(id);
    if (known !== undefined) {
      userRefs.push({ id, name: known });
      continue;
    }
    try {
      const u = await client.request<BacklogUserLite>("GET", `/users/${seg(id)}`);
      userRefs.push({ id: u.id, name: u.name });
    } catch (e) {
      // 名前が引けないだけなので、ID は分かっているものとして続行する
      warnings.push(
        warningFromError(
          e,
          "user_fetch_failed",
          `failed to get user (ID=${id})`,
          `scope.users.${id}`,
        ),
      );
      userRefs.push({ id, name: `user:${id}` });
    }
  }

  const scope = {
    projects: projectRefs,
    users: userRefs,
    teams: teamRefs,
    issues: issueKeys,
    since: args.since,
    ...(args.until ? { until: args.until } : {}),
  };

  // 指定した絞り込みが 1 つでも引けなかったら、その絞り込みを失って範囲が広がる(スペース全体や、
  // プロジェクト全員の課題になる)。広げずに、取れたことと警告だけを返す。
  const lostFilter =
    (projectKeys.length > 0 && projectIds.length === 0) ||
    ((explicitUserIds.length > 0 || teamIds.length > 0) && userIds.length === 0);
  const finish = (issues: BacklogIssue[], activities: BacklogActivity[]) => {
    const byStatus = new Map<string, number>();
    for (const i of issues) {
      const name = statusName(i);
      if (i.status) byStatus.set(name, (byStatus.get(name) ?? 0) + 1);
    }
    // 課題の担当者と活動の実行者を ID ごとに数える。scope のユーザーは 0 件でも載せる。
    const byUser = new Map<number, { issues: number; activities: number }>();
    const stat = (id: number) => {
      let s = byUser.get(id);
      if (!s) {
        s = { issues: 0, activities: 0 };
        byUser.set(id, s);
      }
      return s;
    };
    for (const u of userRefs) stat(u.id);
    for (const i of issues) if (i.assignee) stat(i.assignee.id).issues++;
    for (const a of activities) if (a.createdUser) stat(a.createdUser.id).activities++;
    return digestEnvelope(
      ctx,
      "digest",
      {
        scope,
        issues,
        activities,
        summary: {
          issue_count: issues.length,
          activity_count: activities.length,
          by_status: Object.fromEntries(
            [...byStatus.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ),
          // キーはユーザー ID(数値の文字列。昇順)。同じ名前のユーザーがいても混ざらない。
          by_user: Object.fromEntries(
            [...byUser.entries()].sort(([a], [b]) => a - b).map(([id, s]) => [String(id), s]),
          ),
          period: { since: args.since, until: args.until || "" },
        },
        llm_hints: llmHints([...projectRefs.map((p) => p.key), ...userRefs.map((u) => u.name)]),
        truncated,
      },
      warnings,
    );
  };
  if (lostFilter) return finish([], []);

  // --- 4. 課題 ---
  let issues: BacklogIssue[] = [];
  if (issueKeys.length > 0) {
    // 課題キー指定は 1 件ずつ取る(期間などでは絞らない。logvalet と同じ)
    for (const key of issueKeys) {
      try {
        issues.push(await client.request<BacklogIssue>("GET", `/issues/${seg(key)}`));
      } catch (e) {
        warnings.push(
          warningFromError(
            e,
            "issue_fetch_failed",
            `failed to get issue "${key}"`,
            `issues.${key}`,
          ),
        );
      }
    }
  } else {
    try {
      const r = await fetchIssuePages(client, {
        projectId: projectIds,
        assigneeId: userIds,
        updatedSince: args.since,
        updatedUntil: args.until || undefined,
        dueDateSince: due?.since,
        dueDateUntil: due?.until,
        startDateSince: start?.since,
        startDateUntil: start?.until,
      });
      issues = r.issues;
      if (r.truncated) {
        truncated = true;
        warnings.push({
          code: "issues_truncated",
          message: `Only the first ${ISSUE_CAP} issues were fetched (page limit reached). The digest may be incomplete.`,
          component: "issues",
          retryable: false,
        });
      }
    } catch (e) {
      warnings.push(warningFromError(e, "issues_fetch_failed", "failed to list issues", "issues"));
    }
  }

  // --- 5. アクティビティ(優先順位: ユーザー > 課題キー > プロジェクト > スペース。logvalet と同じ) ---
  const sources: ActivitySource[] = [];
  if (userIds.length > 0) {
    for (const id of userIds)
      sources.push({ label: `user ${id}`, path: `/users/${seg(id)}/activities` });
  } else if (issueKeys.length > 0) {
    const keys = [...new Set(issueKeys.map(extractProjectKey).filter((k) => k !== ""))];
    if (keys.length > MAX_PROJECT_KEYS) {
      truncated = true;
      warnings.push({
        code: "projects_truncated",
        message: `Activities were fetched for only the first ${MAX_PROJECT_KEYS} of ${keys.length} projects derived from issue_keys.`,
        component: "activities",
        retryable: false,
      });
    }
    for (const k of keys.slice(0, MAX_PROJECT_KEYS)) {
      sources.push({ label: `project ${k}`, path: `/projects/${seg(k)}/activities` });
    }
  } else if (resolvedProjectKeys.length > 0) {
    for (const k of resolvedProjectKeys) {
      sources.push({ label: `project ${k}`, path: `/projects/${seg(k)}/activities` });
    }
  } else {
    sources.push({ label: "space", path: "/space/activities" });
  }

  const activities: BacklogActivity[] = [];
  for (const source of sources) {
    try {
      const r = await fetchActivityRange(client, source.path, {
        since,
        until,
        maxPages: UNIFIED_ACTIVITY_PAGES,
      });
      activities.push(...r.activities);
      if (r.truncated) {
        truncated = true;
        warnings.push({
          code: "activities_truncated",
          message: `Only the latest ${UNIFIED_ACTIVITY_PAGES * 100} activities of ${source.label} were fetched (page limit reached). The digest may be incomplete.`,
          component: "activities",
          retryable: false,
        });
      }
    } catch (e) {
      warnings.push(
        warningFromError(
          e,
          "activities_fetch_failed",
          `failed to fetch activities for ${source.label}`,
          "activities",
        ),
      );
    }
  }
  // 複数のソースを新しい順(id の降順)にまとめる
  activities.sort((a, b) => b.id - a.id);

  return finish(issues, activities);
}
