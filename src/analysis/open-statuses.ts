/**
 * 「未完了」の状態 ID を、固定値([1,2,3])ではなくプロジェクトの状態一覧から決める(ADR 0012)。
 * 未完了 = 完了集合(`statuses.ts` の名前集合)に入らない状態。カスタム状態もここに入る。
 * 状態 ID はスペース内で重複しうるので集合にする(挿入順を保つ)。
 */
import type { BacklogClient } from "../backlog/client";
import { ArgumentError } from "../errors";
import { MAX_STATUS_PROJECTS } from "./budget";
import { type Warning, warningFromError } from "./envelope";
import { type BacklogStatus, createStatusLookup, type StatusCacheDeps } from "./status-cache";
import { DONE_STATUSES } from "./statuses";

export type { BacklogStatus } from "./status-cache";

/** 状態一覧の取得に要るもの。`statusCache` が無ければ毎回 Backlog から引く(ADR 0016)。 */
export interface StatusLookupContext {
  client: BacklogClient;
  now: () => Date;
  statusCache?: StatusCacheDeps;
}

export interface JoinedProject {
  id: number;
  projectKey: string;
}

const DONE: ReadonlySet<string> = new Set(DONE_STATUSES);

/** GET /projects(アーカイブ済みを除く。管理者でも参加しているものだけ)。 */
export async function listActiveProjects(client: BacklogClient): Promise<JoinedProject[]> {
  return (
    (await client.request<JoinedProject[]>("GET", "/projects", { query: { archived: false } })) ??
    []
  );
}

function addOpenIds(into: Set<number>, statuses: readonly BacklogStatus[]): void {
  for (const s of statuses) if (!DONE.has(s.name)) into.add(s.id);
}

/**
 * issue_list の `status_id=not-closed` 用。`projectKeys` があればそのプロジェクト、なければ
 * 参加プロジェクトすべて(MAX_STATUS_PROJECTS = 200 超は argument_error。ADR 0017)。取得の失敗はそのまま投げる。
 */
export async function resolveNotClosedStatusIds(
  ctx: StatusLookupContext,
  projectKeys: readonly string[],
): Promise<number[]> {
  const { client } = ctx;
  let keys = projectKeys;
  if (keys.length === 0) {
    keys = (await listActiveProjects(client)).map((p) => p.projectKey);
    if (keys.length > MAX_STATUS_PROJECTS) {
      throw new ArgumentError(
        `status_id=not-closed without project_key looks up the statuses of every project, but you have ${keys.length} projects (limit ${MAX_STATUS_PROJECTS}). Specify project_key or project_keys, or pass numeric status IDs`,
      );
    }
  }
  const ids = new Set<number>();
  const lookup = createStatusLookup(client, ctx.statusCache, ctx.now);
  try {
    for (const key of keys) addOpenIds(ids, await lookup.get(key));
  } finally {
    await lookup.flush(); // 途中で失敗しても、ここまでに引いた分は残す
  }
  return [...ids];
}

export interface OpenStatusIds {
  ids: number[];
  truncated: boolean;
  warnings: Warning[];
}

/**
 * my_tasks 用。参加プロジェクトすべての状態一覧から未完了の状態 ID を集める。失敗は warning にして続け
 * (取れなければ ids は空。呼び出し側は statusId を送らず、応答側の完了集合の除外で補う)、
 * プロジェクトが MAX_STATUS_PROJECTS を超えたら先頭の分だけ使い truncated と warning を返す。
 */
export async function collectOpenStatusIds(ctx: StatusLookupContext): Promise<OpenStatusIds> {
  const { client } = ctx;
  const warnings: Warning[] = [];
  let projects: JoinedProject[];
  try {
    projects = await listActiveProjects(client);
  } catch (e) {
    warnings.push(
      warningFromError(e, "projects_fetch_failed", "project list fetch failed", "statuses"),
    );
    return { ids: [], truncated: false, warnings };
  }
  let truncated = false;
  if (projects.length > MAX_STATUS_PROJECTS) {
    truncated = true;
    warnings.push({
      code: "status_projects_truncated",
      message: `Only the statuses of the first ${MAX_STATUS_PROJECTS} of ${projects.length} projects were used to decide which issues are open. Issues in other projects that use a status unknown here may be missing.`,
      component: "statuses",
      retryable: false,
    });
    projects = projects.slice(0, MAX_STATUS_PROJECTS);
  }
  const ids = new Set<number>();
  const lookup = createStatusLookup(client, ctx.statusCache, ctx.now);
  try {
    for (const p of projects) {
      try {
        addOpenIds(ids, await lookup.get(p.projectKey));
      } catch (e) {
        warnings.push(
          warningFromError(
            e,
            "statuses_fetch_failed",
            `statuses fetch failed for project ${p.projectKey}`,
            "statuses",
          ),
        );
      }
    }
  } finally {
    await lookup.flush(); // 想定外の失敗でも、ここまでに引いた分は残す
  }
  return { ids: [...ids], truncated, warnings };
}
