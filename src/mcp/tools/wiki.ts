import { z } from "zod";
import { boundedCount, optInt, optStr, positiveOrUndefined, reqInt, reqStr, seg } from "../args";
import { defineTool } from "../registry";

export const wikiList = defineTool({
  name: "logbutler_wiki_list",
  title: "Wiki ページ一覧取得",
  description: "List wiki pages in a project",
  category: "ReadOnly",
  toolset: "wiki",
  inputSchema: z.object({
    project_key: reqStr("Project key (e.g. PROJ)"),
    keyword: optStr("Keyword to search in wiki pages"),
  }),
  handler: ({ project_key, keyword }, { client }) =>
    client.request("GET", "/wikis", {
      query: { projectIdOrKey: project_key, keyword: keyword || undefined },
    }),
});

export const wikiGet = defineTool({
  name: "logbutler_wiki_get",
  title: "Wiki ページ取得",
  description: "Get a wiki page by ID",
  category: "ReadOnly",
  toolset: "wiki",
  inputSchema: z.object({ wiki_id: reqInt("Wiki page ID") }),
  handler: ({ wiki_id }, { client }) => client.request("GET", `/wikis/${seg(wiki_id)}`),
});

export const wikiCount = defineTool({
  name: "logbutler_wiki_count",
  title: "Wiki ページ件数取得",
  description: "Count wiki pages in a project",
  category: "ReadOnly",
  toolset: "wiki",
  inputSchema: z.object({ project_key: reqStr("Project key (e.g. PROJ)") }),
  handler: ({ project_key }, { client }) =>
    client.request("GET", "/wikis/count", { query: { projectIdOrKey: project_key } }),
});

export const wikiTags = defineTool({
  name: "logbutler_wiki_tags",
  title: "Wiki タグ一覧取得",
  description: "List wiki tags in a project",
  category: "ReadOnly",
  toolset: "wiki",
  inputSchema: z.object({ project_key: reqStr("Project key (e.g. PROJ)") }),
  handler: ({ project_key }, { client }) =>
    client.request("GET", "/wikis/tags", { query: { projectIdOrKey: project_key } }),
});

export const wikiHistory = defineTool({
  name: "logbutler_wiki_history",
  title: "Wiki 履歴取得",
  description: "Get wiki page history",
  category: "ReadOnly",
  toolset: "wiki",
  inputSchema: z.object({
    wiki_id: reqInt("Wiki page ID"),
    min_id: optInt("Minimum history ID"),
    max_id: optInt("Maximum history ID"),
    count: optInt("Number of records (1-100, default 20)"),
    order: optStr("Sort order: asc or desc (default desc)"),
  }),
  handler: ({ wiki_id, min_id, max_id, count, order }, { client }) =>
    client.request("GET", `/wikis/${seg(wiki_id)}/history`, {
      query: {
        minId: positiveOrUndefined(min_id),
        maxId: positiveOrUndefined(max_id),
        count: boundedCount("count", count),
        order: order || undefined,
      },
    }),
});

function wikiSubresource(name: string, title: string, description: string, segment: string) {
  return defineTool({
    name,
    title,
    description,
    category: "ReadOnly",
    toolset: "wiki",
    inputSchema: z.object({ wiki_id: reqInt("Wiki page ID") }),
    handler: ({ wiki_id }, { client }) =>
      client.request("GET", `/wikis/${seg(wiki_id)}/${segment}`),
  });
}

export const wikiStars = wikiSubresource(
  "logbutler_wiki_stars",
  "Wiki スター一覧取得",
  "List stars on a wiki page",
  "stars",
);
export const wikiAttachmentList = wikiSubresource(
  "logbutler_wiki_attachment_list",
  "Wiki 添付ファイル一覧取得",
  "List attachments on a wiki page",
  "attachments",
);
export const wikiSharedfileList = wikiSubresource(
  "logbutler_wiki_sharedfile_list",
  "Wiki 共有ファイル一覧取得",
  "List shared files on a wiki page",
  "sharedFiles",
);
