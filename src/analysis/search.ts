/** search: issues / documents / wikis の横断検索(logvalet `internal/digest/search.go`)。 */
import { boundedCount, positiveOrUndefined } from "../mcp/args";
import type { ToolContext } from "../mcp/registry";
import { MAX_SEARCH_WIKI_PROJECTS } from "./budget";
import { parseDetail, pathPart } from "./digest-args";
import type { BacklogDocument } from "./document-digest";
import { baseUrlOf, digestEnvelope, type Warning, warningFromError } from "./envelope";
import { extractProjectKey } from "./issue-detail";
import type { BacklogIssue } from "./issues";
import { type BacklogProject, fetchProject, parseOptionalProjectKeys } from "./projects";
import { extractSnippet } from "./snippet";
import { type UserRef, userRef } from "./stale";

const DEFAULT_SEARCH_COUNT = 20;
const DETAILS = ["snippet", "meta"] as const;

export interface SearchArgs {
  keyword: string;
  project_keys?: string;
  count?: number;
  offset?: number;
  detail?: string;
}

interface BacklogWiki {
  id: number;
  projectId?: number;
  name?: string;
  content?: string | null;
  created?: string | null;
  updated?: string | null;
  createdUser?: UserRef | null;
  updatedUser?: UserRef | null;
}

interface SearchItem {
  resource_type: "issue" | "document" | "wiki";
  id?: string;
  key?: string;
  project_id?: number;
  project_key?: string;
  title: string;
  url?: string;
  snippet?: string;
  created?: string;
  updated?: string;
  assignee?: UserRef;
  reporter?: UserRef;
  created_user?: UserRef;
  updated_user?: UserRef;
}

const orUndefined = <T>(v: T | null | undefined | "" | 0): T | undefined =>
  v ? (v as T) : undefined;

/** 失敗を warning にして undefined を返す(401 などは warningFromError が投げ直す)。 */
async function soft<T>(
  warnings: Warning[],
  code: string,
  message: string,
  component: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (e) {
    warnings.push(warningFromError(e, code, message, component));
    return undefined;
  }
}

export async function buildSearch(ctx: ToolContext, a: SearchArgs) {
  // 入力の検証は、Backlog を呼ぶ前にすべて済ませる。
  const count = boundedCount("count", a.count) ?? DEFAULT_SEARCH_COUNT;
  const offset = positiveOrUndefined(a.offset) ?? 0;
  const detail = parseDetail(a.detail, DETAILS, "snippet");
  const requestedKeys = parseOptionalProjectKeys(a.project_keys);
  const base = baseUrlOf(ctx);
  const client = ctx.client;
  const warnings: Warning[] = [];
  const counts = { issues: 0, documents: 0, wikis: 0 };
  const more = { issues: 0, documents: 0, wikis: 0 };
  const items: SearchItem[] = [];

  // 検索対象のプロジェクト。キー指定があれば GetProject で解決し、引けなかったキーは warning にする
  // (logvalet は全体エラー)。指定したのに 1 つも引けなければ、絞り込みを失って全体を検索しない。
  const keyById = new Map<number, string>();
  let projects: BacklogProject[] = [];
  const filterIds: number[] = [];
  if (requestedKeys.length > 0) {
    for (const key of requestedKeys) {
      const p = await soft(
        warnings,
        "project_fetch_failed",
        `failed to resolve project "${key}"`,
        `scope.projects.${key}`,
        () => fetchProject(client, key),
      );
      if (p) {
        projects.push(p);
        filterIds.push(p.id);
      }
    }
    if (projects.length === 0) return finish([], false);
  } else {
    projects =
      (await soft(
        warnings,
        "project_list_failed",
        "failed to list projects for wiki search and URL construction",
        "projects",
        async () => (await client.request<BacklogProject[]>("GET", "/projects")) ?? [],
      )) ?? [];
  }
  for (const p of projects) keyById.set(p.id, p.projectKey);

  const issues = await soft(
    warnings,
    "issue_search_failed",
    "failed to search issues",
    "issues",
    async () =>
      (await client.request<BacklogIssue[]>("GET", "/issues", {
        query: {
          projectId: filterIds,
          keyword: a.keyword,
          count,
          offset: positiveOrUndefined(offset),
          sort: "updated",
          order: "desc",
        },
      })) ?? [],
  );
  if (issues) {
    counts.issues = issues.length;
    if (issues.length >= count) more.issues = 1;
    for (const issue of issues) {
      const projectKey =
        keyById.get(issue.projectId ?? -1) || extractProjectKey(issue.issueKey ?? "");
      const snippet = detail === "meta" ? "" : extractSnippet(issue.description ?? "", a.keyword);
      items.push({
        resource_type: "issue",
        id: String(issue.id),
        key: issue.issueKey,
        project_id: orUndefined(issue.projectId),
        project_key: orUndefined(projectKey),
        title: issue.summary,
        url: base !== "" && issue.issueKey ? `${base}/view/${pathPart(issue.issueKey)}` : undefined,
        snippet: orUndefined(snippet),
        created: orUndefined(issue.created),
        updated: orUndefined(issue.updated),
        assignee: userRef(issue.assignee),
        reporter: userRef(issue.createdUser),
      });
    }
  }

  const docs = await soft(
    warnings,
    "document_search_failed",
    "failed to search documents",
    "documents",
    async () =>
      (await client.request<BacklogDocument[]>("GET", "/documents", {
        query: {
          keyword: a.keyword,
          projectId: filterIds,
          count,
          offset,
          sort: "updated",
          order: "desc",
        },
      })) ?? [],
  );
  if (docs) {
    counts.documents = docs.length;
    if (docs.length >= count) more.documents = 1;
    for (const doc of docs) {
      const projectKey = keyById.get(doc.projectId ?? -1);
      const snippet = detail === "meta" ? "" : extractSnippet(doc.plain ?? "", a.keyword);
      items.push({
        resource_type: "document",
        id: doc.id,
        project_id: orUndefined(doc.projectId),
        project_key: orUndefined(projectKey),
        title: doc.title ?? "",
        url:
          base !== "" && projectKey && doc.id
            ? `${base}/document/${pathPart(projectKey)}/${pathPart(doc.id)}`
            : undefined,
        snippet: orUndefined(snippet),
        created: orUndefined(doc.created),
        updated: orUndefined(doc.updated),
        created_user: userRef(doc.createdUser),
        updated_user: userRef(doc.updatedUser),
      });
    }
  }

  // Wiki: プロジェクトごとに 1 回ずつ(直列)。offset + count + 1 件集まったら止める。
  // プロジェクトが MAX_SEARCH_WIKI_PROJECTS を超えるときは、先頭の分だけ検索して truncated にする(ADR 0006)。
  const wikiTargets = projects.slice(0, MAX_SEARCH_WIKI_PROJECTS);
  const wikis: SearchItem[] = [];
  const maxNeeded = offset + count + 1;
  let enough = false;
  for (const project of wikiTargets) {
    const pages = await soft(
      warnings,
      "wiki_search_failed",
      `failed to search wikis in project ${project.projectKey}`,
      "wikis",
      async () =>
        (await client.request<BacklogWiki[]>("GET", "/wikis", {
          query: { projectIdOrKey: project.projectKey, keyword: a.keyword },
        })) ?? [],
    );
    for (const page of pages ?? []) {
      const snippet = detail === "meta" ? "" : extractSnippet(page.content ?? "", a.keyword);
      wikis.push({
        resource_type: "wiki",
        id: String(page.id),
        project_id: orUndefined(page.projectId),
        project_key: orUndefined(project.projectKey),
        title: page.name ?? "",
        url:
          base !== "" && project.projectKey && page.name
            ? `${base}/wiki/${pathPart(project.projectKey)}/${pathPart(page.name)}`
            : undefined,
        snippet: orUndefined(snippet),
        created: orUndefined(page.created),
        updated: orUndefined(page.updated),
        created_user: userRef(page.createdUser),
        updated_user: userRef(page.updatedUser),
      });
      if (wikis.length >= maxNeeded) break;
    }
    if (wikis.length >= maxNeeded) {
      enough = true;
      break;
    }
  }
  let truncated = false;
  if (!enough && projects.length > wikiTargets.length) {
    truncated = true;
    warnings.push({
      code: "wiki_search_truncated",
      message: `Wiki pages were searched in only the first ${wikiTargets.length} of ${projects.length} projects (limit reached). Narrow the search with project_keys.`,
      component: "wikis",
      retryable: false,
    });
  }
  // wiki 検索には offset / count がないので、集めた分をここで切り出す(logvalet と同じ)。
  const pageOfWikis = offset >= wikis.length ? [] : wikis.slice(offset, offset + count);
  if (offset < wikis.length && offset + count < wikis.length) more.wikis = 1;
  counts.wikis = pageOfWikis.length;
  items.push(...pageOfWikis);

  return finish(items, truncated);

  function finish(list: SearchItem[], wasTruncated: boolean) {
    const possiblyMore = more.issues > 0 || more.documents > 0 || more.wikis > 0;
    return digestEnvelope(
      ctx,
      "search",
      {
        keyword: a.keyword,
        detail,
        ...(requestedKeys.length > 0 ? { project_keys: requestedKeys } : {}),
        count_per_resource: count,
        offset,
        total_returned: list.length,
        returned_by_type: counts,
        possibly_more: possiblyMore,
        possibly_more_by_type: more,
        ...(possiblyMore ? { next_offset: offset + count } : {}),
        items: list,
        truncated: wasTruncated,
      },
      warnings,
    );
  }
}
