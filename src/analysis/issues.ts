/**
 * 分析系の課題取得。logvalet は count を指定せず Backlog 既定の 20 件だけで分析していた。
 * ここでは offset でページングして全件取り(10 ページ × 100 件 = 1,000 件が上限。ADR 0003 / 0006)、
 * 上限で止めたら `truncated` と warning を返す。ページは直列に取る。
 */
import type { BacklogClient, Params } from "../backlog/client";
import { DEFAULT_MAX_PAGES, DEFAULT_PAGE_SIZE, fetchByOffset } from "../backlog/paging";
import { resolveProjectId } from "../mcp/args";
import { type Warning, warningFromError } from "./envelope";

/** 分析に使う Backlog の課題(生データの camelCase のまま、使う項目だけ)。 */
export interface BacklogIssue {
  id: number;
  issueKey: string;
  summary: string;
  description?: string | null;
  status?: { id: number; name: string } | null;
  priority?: { id: number; name: string } | null;
  issueType?: { id: number; name: string } | null;
  assignee?: { id: number; name: string } | null;
  createdUser?: { id: number; name: string } | null;
  category?: { id: number; name: string }[] | null;
  milestone?: { id: number; name: string }[] | null;
  dueDate?: string | null;
  startDate?: string | null;
  created?: string | null;
  updated?: string | null;
}

/** 課題の取得上限(件)。 */
export const ISSUE_CAP = DEFAULT_PAGE_SIZE * DEFAULT_MAX_PAGES;
/** 1 プロジェクト分の課題取得の最悪ケースの API 呼び出し数: GetProject 1 + 課題一覧 10 ページ。 */
export const PROJECT_ISSUE_CALLS = 1 + DEFAULT_MAX_PAGES;

export interface IssuePages {
  issues: BacklogIssue[];
  truncated: boolean;
}

/** `GET /issues` を offset でページングして集める。query に projectId や期間などを渡す。 */
export async function fetchIssuePages(client: BacklogClient, query: Params): Promise<IssuePages> {
  const { items, truncated } = await fetchByOffset<BacklogIssue>(async ({ offset, count }) => {
    const page = await client.request<BacklogIssue[]>("GET", "/issues", {
      query: { ...query, count, offset: offset > 0 ? offset : undefined },
    });
    return page ?? [];
  });
  return { issues: items, truncated };
}

export interface FetchedIssues extends IssuePages {
  /** GetProject か課題一覧の取得に失敗した(warnings に理由がある)。 */
  failed: boolean;
  warnings: Warning[];
}

export interface FetchProjectIssuesOptions {
  sort?: string;
  order?: "asc" | "desc";
  /** 期間などの追加のクエリ。 */
  query?: Params;
  /** warning の component(logvalet は project / issues。triage は project_stats、digest は periodic_digest)。 */
  projectComponent?: string;
  issuesComponent?: string;
}

/**
 * プロジェクトの課題を全件(上限つき)取る。失敗は warning にして空の結果を返す(logvalet の
 * `fetchProjectIssues`)。401 だけは投げ直す。
 */
export async function fetchProjectIssues(
  client: BacklogClient,
  projectKey: string,
  options: FetchProjectIssuesOptions = {},
): Promise<FetchedIssues> {
  const projectComponent = options.projectComponent ?? "project";
  const issuesComponent = options.issuesComponent ?? "issues";
  let projectId: number;
  try {
    projectId = await resolveProjectId(client, projectKey);
  } catch (e) {
    return {
      issues: [],
      truncated: false,
      failed: true,
      warnings: [
        warningFromError(
          e,
          "project_fetch_failed",
          `failed to get project ${projectKey}`,
          projectComponent,
        ),
      ],
    };
  }
  try {
    const { issues, truncated } = await fetchIssuePages(client, {
      ...options.query,
      projectId: [projectId],
      sort: options.sort,
      order: options.order,
    });
    return {
      issues,
      truncated,
      failed: false,
      warnings: truncated
        ? [
            {
              code: "issues_truncated",
              message: `Only the first ${ISSUE_CAP} issues of project ${projectKey} were analyzed (page limit reached). The result may be incomplete.`,
              component: issuesComponent,
              retryable: false,
            },
          ]
        : [],
    };
  } catch (e) {
    return {
      issues: [],
      truncated: false,
      failed: true,
      warnings: [
        warningFromError(
          e,
          "issues_fetch_failed",
          `failed to list issues for project ${projectKey}`,
          issuesComponent,
        ),
      ],
    };
  }
}

/** 昇順の比較(issue_key の辞書順。logvalet の blocker と同じ。同順位の並びを決めるのに使う)。 */
export const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface CollectedIssues {
  /** 取得できたプロジェクトの課題(取得順)。 */
  issues: BacklogIssue[];
  truncated: boolean;
  warnings: Warning[];
}

/** 複数プロジェクトの課題を、プロジェクト順に直列で集める。失敗したプロジェクトは warning にして続ける。 */
export async function collectProjectIssues(
  client: BacklogClient,
  projectKeys: readonly string[],
  options: FetchProjectIssuesOptions = {},
): Promise<CollectedIssues> {
  const out: CollectedIssues = { issues: [], truncated: false, warnings: [] };
  for (const key of projectKeys) {
    const r = await fetchProjectIssues(client, key, options);
    out.issues.push(...r.issues);
    out.truncated ||= r.truncated;
    out.warnings.push(...r.warnings);
  }
  return out;
}
