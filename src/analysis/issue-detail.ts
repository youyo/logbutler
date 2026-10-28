/** issue_context / issue_triage_materials / issue_timeline が共有する、課題 1 件まわりの取得と整形。 */
import type { BacklogClient } from "../backlog/client";
import { fetchByCursor } from "../backlog/paging";
import { seg } from "../mcp/args";
import { type Warning, warningFromError } from "./envelope";
import type { BacklogIssue } from "./issues";
import { type UserRef, userRef } from "./stale";

/** `PROJ-123` → `PROJ`(最初の `-` まで。logvalet の extractProjectKey)。 */
export function extractProjectKey(issueKey: string): string {
  const at = issueKey.indexOf("-");
  return at < 0 ? issueKey : issueKey.slice(0, at);
}

export interface IdName {
  id: number;
  name: string;
}
export const idName = (x: IdName | null | undefined): IdName | undefined =>
  x ? { id: x.id, name: x.name } : undefined;
export const idNames = (xs: readonly IdName[] | null | undefined): IdName[] =>
  (xs ?? []).map((x) => ({ id: x.id, name: x.name }));

export interface BacklogComment {
  id: number;
  content?: string | null;
  createdUser?: { id: number; name: string } | null;
  created?: string | null;
}

export interface CommentFetch {
  /** 新しい順(Backlog の既定)。 */
  comments: BacklogComment[];
  truncated: boolean;
  warnings: Warning[];
}

/**
 * 課題のコメントを新しい順に全件(上限つき)取る。`/comments` は offset ではなく minId / maxId のカーソル。
 * 取得に失敗したら warning にして空を返す。
 */
export async function fetchAllComments(
  client: BacklogClient,
  issueKey: string,
  component: string,
  options: {
    /** これより古いコメントに届いたら、それ以上ページを取らない(新しい順なので以降は全部古い)。 */
    olderThan?: Date;
    /** 上限で止めたときの warning に添える説明。 */
    truncatedNote?: string;
  } = {},
): Promise<CommentFetch> {
  const cutoff = options.olderThan?.getTime();
  try {
    const { items, truncated } = await fetchByCursor<BacklogComment>(
      async ({ maxId, count }) => {
        const batch =
          (await client.request<BacklogComment[]>("GET", `/issues/${seg(issueKey)}/comments`, {
            query: { count, maxId },
          })) ?? [];
        if (cutoff === undefined) return batch;
        // 期間より古いコメントに届いた。そこで切って短いページにすれば、ページングはここで終わる。
        const at = batch.findIndex((c) => c.created && Date.parse(c.created) < cutoff);
        return at < 0 ? batch : batch.slice(0, at);
      },
      (c) => c.id,
    );
    return {
      comments: items,
      truncated,
      warnings: truncated
        ? [
            {
              code: "comments_truncated",
              message: `Fetched only the latest ${items.length} comments of ${issueKey} (page limit reached). ${options.truncatedNote ?? "comment_count is a lower bound."}`,
              component,
              retryable: false,
            },
          ]
        : [],
    };
  } catch (e) {
    return {
      comments: [],
      truncated: false,
      warnings: [
        warningFromError(
          e,
          "comments_fetch_failed",
          `failed to list comments for ${issueKey}`,
          component,
        ),
      ],
    };
  }
}

export interface RelatedIssueRef {
  issue_key: string;
  summary: string;
  status?: IdName;
  priority?: IdName;
  issue_type?: IdName;
  assignee?: UserRef;
  type: string;
  created?: string;
  updated?: string;
}

/**
 * 関連課題(公式ドキュメントにない API)。フラット形状 `{...issue, type}` とネスト形状
 * `{relatedIssue: {...}, type}` の両方を受け付ける(logvalet と同じ)。失敗は warning。
 */
export async function fetchRelatedRefs(
  client: BacklogClient,
  issueKey: string,
): Promise<{ refs: RelatedIssueRef[]; warnings: Warning[] }> {
  try {
    const raw =
      (await client.request<Record<string, unknown>[]>(
        "GET",
        `/issues/${seg(issueKey)}/relatedIssues`,
      )) ?? [];
    const refs = raw.map((r): RelatedIssueRef => {
      const nested = r.relatedIssue;
      const i = (nested && typeof nested === "object" ? nested : r) as BacklogIssue;
      return {
        issue_key: i.issueKey,
        summary: i.summary,
        ...(i.status ? { status: idName(i.status) } : {}),
        ...(i.priority ? { priority: idName(i.priority) } : {}),
        ...(i.issueType ? { issue_type: idName(i.issueType) } : {}),
        ...(i.assignee ? { assignee: userRef(i.assignee) } : {}),
        type: typeof r.type === "string" ? r.type : "",
        ...(i.created ? { created: i.created } : {}),
        ...(i.updated ? { updated: i.updated } : {}),
      };
    });
    return { refs, warnings: [] };
  } catch (e) {
    return {
      refs: [],
      warnings: [
        warningFromError(
          e,
          "related_issues_fetch_failed",
          "failed to list related issues",
          "related_issues",
        ),
      ],
    };
  }
}
