/** document_digest(logvalet `internal/digest/document.go`)。 */
import { seg } from "../mcp/args";
import type { ToolContext } from "../mcp/registry";
import { digestEnvelope, llmHints, type Warning, warningFromError } from "./envelope";
import { type UserRef, userRef } from "./stale";

export interface BacklogDocument {
  id: string;
  projectId?: number;
  title?: string;
  plain?: string | null;
  json?: unknown;
  created?: string | null;
  updated?: string | null;
  createdUser?: { id: number; name: string } | null;
  updatedUser?: { id: number; name: string } | null;
}

interface BacklogProject {
  id: number;
  projectKey: string;
  name: string;
}

interface DigestProject {
  id: number;
  key: string;
  name: string;
}

/** logvalet はこの 3 項目だけを載せる(添付ファイルのほかの項目は載せない)。 */
interface DigestAttachment {
  id: number;
  name: string;
  size: number;
}

export async function buildDocumentDigest(ctx: ToolContext, args: { document_id: string }) {
  const documentId = args.document_id;
  // ドキュメントは必須(失敗はツールエラー)。プロジェクトと添付ファイルは任意(失敗は warning)。
  const doc = await ctx.client.request<BacklogDocument>("GET", `/documents/${seg(documentId)}`);
  const warnings: Warning[] = [];

  // Document には projectId(数値)しかなく、GetProject はキーを要るので、ListProjects で ID を照合する。
  let project: DigestProject = { id: 0, key: "", name: "" };
  try {
    const projects = (await ctx.client.request<BacklogProject[]>("GET", "/projects")) ?? [];
    const matched = projects.find((p) => p.id === doc.projectId);
    if (matched) project = { id: matched.id, key: matched.projectKey, name: matched.name };
    else {
      warnings.push({
        code: "project_not_matched",
        message: `project not found for project ID ${doc.projectId ?? 0}`,
        component: "project",
        retryable: false,
      });
    }
  } catch (e) {
    warnings.push(
      warningFromError(e, "project_fetch_failed", "failed to list projects", "project"),
    );
  }

  let attachments: DigestAttachment[] = [];
  try {
    const atts =
      (await ctx.client.request<DigestAttachment[]>(
        "GET",
        `/documents/${seg(documentId)}/attachments`,
      )) ?? [];
    attachments = atts.map((a) => ({ id: a.id, name: a.name, size: a.size }));
  } catch (e) {
    warnings.push(
      warningFromError(e, "attachments_fetch_failed", "failed to list attachments", "attachments"),
    );
  }

  const plain = doc.plain ?? "";
  const title = doc.title ?? "";
  const created_user: UserRef | undefined = userRef(doc.createdUser);
  const updated_user: UserRef | undefined = userRef(doc.updatedUser);
  return digestEnvelope(
    ctx,
    "document",
    {
      document: {
        id: doc.id,
        project_id: doc.projectId ?? 0,
        title,
        // Go の omitempty: 空なら出さない
        ...(plain ? { plain } : {}),
        ...(doc.json === undefined || doc.json === null ? {} : { json: doc.json }),
        ...(doc.created ? { created: doc.created } : {}),
        ...(doc.updated ? { updated: doc.updated } : {}),
        ...(created_user ? { created_user } : {}),
        ...(updated_user ? { updated_user } : {}),
      },
      project,
      attachments,
      summary: {
        headline: `ドキュメント「${title}」（ID: ${doc.id}）`,
        attachment_count: attachments.length,
        has_content: plain !== "",
        content_length: [...plain].length,
      },
      llm_hints: llmHints([
        `document:${doc.id}`,
        title,
        ...(project.key !== "" ? [project.key] : []),
      ]),
    },
    warnings,
  );
}
