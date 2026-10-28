/** document_search(logvalet `internal/digest/document_search.go`、`internal/mcp/tools_document.go`)。 */
import { boundedCount, positiveOrUndefined } from "../mcp/args";
import type { ToolContext } from "../mcp/registry";
import { parseDetail, pathPart } from "./digest-args";
import type { BacklogDocument } from "./document-digest";
import { baseUrlOf, digestEnvelope, type Warning, warningFromError } from "./envelope";
import { type BacklogProject, fetchProject, parseOptionalProjectKeys } from "./projects";
import { extractSnippet } from "./snippet";
import { userRef } from "./stale";

const DETAILS = ["snippet", "meta", "full"] as const;
export const DEFAULT_DOCUMENT_COUNT = 100;

export interface DocumentSearchArgs {
  keyword: string;
  project_keys?: string;
  count?: number;
  offset?: number;
  sort?: string;
  order?: string;
  detail?: string;
}

export async function buildDocumentSearch(ctx: ToolContext, a: DocumentSearchArgs) {
  // 入力の検証は、Backlog を呼ぶ前にすべて済ませる。
  const count = boundedCount("count", a.count) ?? DEFAULT_DOCUMENT_COUNT;
  const detail = parseDetail(a.detail, DETAILS, "snippet");
  const keys = parseOptionalProjectKeys(a.project_keys);
  const offset = positiveOrUndefined(a.offset) ?? 0;

  // project_keys → ID(直列)。1 つでも引けなければツールエラー(logvalet と同じ。絞り込みを失って全体検索にしない)。
  const keyById = new Map<number, string>();
  for (const key of keys) {
    const p: BacklogProject = await fetchProject(ctx.client, key);
    keyById.set(p.id, p.projectKey);
  }

  const docs =
    (await ctx.client.request<BacklogDocument[]>("GET", "/documents", {
      // offset は 0 でも送る(logvalet と同じ。ドキュメント API は offset を要求する)。
      query: {
        keyword: a.keyword,
        projectId: [...keyById.keys()],
        sort: a.sort || undefined,
        order: a.order || undefined,
        count,
        offset,
      },
    })) ?? [];

  // URL のためにプロジェクト ID → キーを引く。project_keys で絞ったときは解決済みなので呼ばない。
  const warnings: Warning[] = [];
  const base = baseUrlOf(ctx);
  if (keys.length === 0 && base !== "" && docs.length > 0) {
    try {
      const projects = (await ctx.client.request<BacklogProject[]>("GET", "/projects")) ?? [];
      for (const p of projects) keyById.set(p.id, p.projectKey);
    } catch (e) {
      warnings.push(
        warningFromError(
          e,
          "project_fetch_failed",
          "failed to list projects for URL construction",
          "url",
        ),
      );
    }
  }

  const items = docs.map((doc) => {
    const projectKey = keyById.get(doc.projectId ?? -1);
    const plain = doc.plain ?? "";
    const snippet = detail === "meta" ? "" : extractSnippet(plain, a.keyword);
    const created_user = userRef(doc.createdUser);
    const updated_user = userRef(doc.updatedUser);
    return {
      id: doc.id,
      project_id: doc.projectId ?? 0,
      title: doc.title ?? "",
      ...(base !== "" && projectKey
        ? { url: `${base}/document/${pathPart(projectKey)}/${pathPart(doc.id)}` }
        : {}),
      ...(snippet ? { snippet } : {}),
      ...(detail === "full" && plain ? { plain } : {}),
      ...(doc.created ? { created: doc.created } : {}),
      ...(doc.updated ? { updated: doc.updated } : {}),
      ...(created_user ? { created_user } : {}),
      ...(updated_user ? { updated_user } : {}),
    };
  });

  const possiblyMore = docs.length >= count;
  return digestEnvelope(
    ctx,
    "document_search",
    {
      keyword: a.keyword,
      detail,
      total_returned: docs.length,
      possibly_more: possiblyMore,
      ...(possiblyMore ? { next_offset: offset + docs.length } : {}),
      items,
    },
    warnings,
  );
}
