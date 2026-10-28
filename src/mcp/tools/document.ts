import { z } from "zod";
import {
  nonEmpty,
  optInt,
  optStr,
  positiveOrUndefined,
  reqInt,
  reqStr,
  requireId,
  resolveProjectId,
  seg,
} from "../args";
import { defineTool } from "../registry";

export const documentGet = defineTool({
  name: "logbutler_document_get",
  title: "ドキュメント取得",
  description: "Get document by document ID",
  category: "ReadOnly",
  toolset: "document",
  inputSchema: z.object({ document_id: reqStr("Document ID") }),
  handler: ({ document_id }, { client }) => client.request("GET", `/documents/${seg(document_id)}`),
});

export const documentList = defineTool({
  name: "logbutler_document_list",
  title: "ドキュメント一覧取得",
  description: "List documents in a project",
  category: "ReadOnly",
  toolset: "document",
  inputSchema: z.object({
    project_key: reqStr("Project key (e.g. PROJ)"),
    count: optInt("Max number of documents"),
    offset: optInt("Offset for pagination"),
  }),
  handler: async ({ project_key, count, offset }, { client }) => {
    const projectId = await resolveProjectId(client, project_key);
    return client.request("GET", "/documents", {
      // offset は 0 でも送る(logvalet と同じ。ドキュメント API は offset を要求する)。
      query: {
        projectId: [projectId],
        offset: offset !== undefined && offset > 0 ? offset : 0,
        count: positiveOrUndefined(count),
      },
    });
  },
});

export const documentTree = defineTool({
  name: "logbutler_document_tree",
  title: "ドキュメントツリー取得",
  description: "Get the document tree for a project",
  category: "ReadOnly",
  toolset: "document",
  inputSchema: z.object({ project_key: reqStr("Project key") }),
  handler: ({ project_key }, { client }) =>
    client.request("GET", "/documents/tree", { query: { projectIdOrKey: project_key } }),
});

export const documentCreate = defineTool({
  name: "logbutler_document_create",
  title: "ドキュメント作成",
  description: "Create a new document in a project",
  category: "WriteNonIdempotent",
  toolset: "document",
  inputSchema: z.object({
    project_id: reqInt("Project ID (numeric)"),
    title: reqStr("Document title"),
    content: reqStr("Document content (markdown)"),
    parent_id: optStr("Parent document ID (optional)"),
  }),
  handler: ({ project_id, title, content, parent_id }, { client }) => {
    requireId("project_id", project_id);
    return client.request("POST", "/documents", {
      form: { projectId: project_id, title, content, parentId: nonEmpty(parent_id) },
    });
  },
});
