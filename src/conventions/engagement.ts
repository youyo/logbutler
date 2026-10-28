/**
 * 案件名から案件カテゴリと案件親課題を解決する（logvalet `internal/conventions/engagement.go`）。
 * 課題を案件に紐づけるには「カテゴリ」と「親課題」の 2 つを設定する必要があり、規約上この 2 つは対で決まる。
 */
import { BacklogApiError, type BacklogClient } from "../backlog/client";
import { ArgumentError } from "../errors";
import { seg } from "../mcp/args";
import { ConventionsError, ENGAGEMENT_ISSUE_TYPE } from "./load";
import { listIssuesOfType, loadProjectConventions, sameName } from "./show";

export interface EngagementRef {
  name: string;
  categoryId: number;
  /** 案件親課題が無ければ 0。 */
  parentIssueId: number;
}

const engagementIssueSummary = (name: string) => `[案件] ${name.trim()}`;

export async function resolveEngagement(
  client: BacklogClient,
  rawProjectKey: string,
  rawName: string,
): Promise<EngagementRef> {
  const projectKey = rawProjectKey.trim();
  const name = rawName.trim();
  const { result, projectId, issueTypes } = await loadProjectConventions(client, projectKey);
  if (!result.adopted || !result.conventions) {
    throw new ConventionsError(`プロジェクト "${projectKey}" には運用規約が導入されていません`);
  }

  const available: string[] = [];
  for (const engagement of result.conventions.engagements ?? []) {
    available.push(engagement.name.trim());
    if (!sameName(engagement.name, name)) continue;

    let categories: { id: number; name: string }[] = [];
    try {
      categories =
        (await client.request<{ id: number; name: string }[]>(
          "GET",
          `/projects/${seg(projectKey)}/categories`,
        )) ?? [];
    } catch (e) {
      if (!(e instanceof BacklogApiError && e.status === 404)) throw e;
    }
    const category = categories.find((c) => sameName(c.name, name));
    if (!category) {
      throw new ConventionsError(`案件 "${name}" に対応するカテゴリがプロジェクトにありません`);
    }

    const engagementType = issueTypes.find((t) => sameName(t.name, ENGAGEMENT_ISSUE_TYPE));
    const parents = engagementType
      ? await listIssuesOfType(client, projectId, engagementType.id)
      : [];
    const parent = parents.find(
      (i) =>
        sameName(i.issueType?.name, ENGAGEMENT_ISSUE_TYPE) &&
        sameName(i.summary, engagementIssueSummary(name)),
    );
    return { name, categoryId: category.id, parentIssueId: parent?.id ?? 0 };
  }

  throw new ArgumentError(
    `案件 "${name}" は規約にありません。利用可能な案件: [${available.join(" ")}]`,
  );
}
