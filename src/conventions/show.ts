/**
 * project_conventions 本体(logvalet `internal/conventions/show.go` の移植)。
 *
 * logvalet は ListIssues を count 無指定で 1 回だけ呼び、規約課題が 1 ページ目になければ見落とす疑いがあった。
 * ここでは規約の課題種別(issueTypeId)で絞ったうえで、ページング(ADR 0003 の上限つき)して探す。
 */
import { BacklogApiError, type BacklogClient } from "../backlog/client";
import { fetchByOffset } from "../backlog/paging";
import { ArgumentError } from "../errors";
import { resolveProjectId, seg } from "../mcp/args";
import {
  type Conventions,
  ConventionsError,
  loadFromIssueDescription,
  RULE_ISSUE_TYPE,
} from "./load";

export interface GlossaryEntry {
  term: string;
  meaning: string;
  backlog_form: string;
}

/** 規約の用語集（logvalet `glossary.go`）。 */
export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    term: "conventions",
    meaning:
      "組織の運用規約。Linear の制約を Backlog の語彙に翻訳し、各項目の意味を自分たちの言葉で書いたもの",
    backlog_form: "規約課題（入力は conventions.yaml）",
  },
  {
    term: "Initiative",
    meaning: "数か月規模の重点テーマ。並び順が優先度。案件は必ずいずれかに属する",
    backlog_form: "なし（conventions 内のリスト）",
  },
  {
    term: "案件",
    meaning: "数週間規模の取り組み。Linear の Project に相当",
    backlog_form: "カテゴリ + 種別「案件」の親課題",
  },
  { term: "Lead", meaning: "案件の責任者。1 人だけ", backlog_form: "案件親課題の担当者" },
  {
    term: "案件親課題",
    meaning: "案件のヘッダーとなる課題。Lead・期間・状態・Context & Goals を持つ",
    backlog_form: "種別「案件」の課題",
  },
  {
    term: "規約課題",
    meaning: "規約の正本。説明欄に運用ガイドと YAML を持ち、変更履歴とコメントで規約の議論を残す",
    backlog_form: "種別「規約」の課題（プロジェクトに 1 件）",
  },
  {
    term: "曖昧さ",
    meaning: "規約に照らして決まっていないこと。案件不明の課題、Lead 不在の案件など",
    backlog_form: "health の ambiguities",
  },
];

export interface ShowResult {
  project_key: string;
  issue_key: string;
  adopted: boolean;
  conventions?: Conventions;
  glossary: readonly GlossaryEntry[];
}

export interface BacklogIssueTypeRef {
  id: number;
  name: string;
}
export interface BacklogIssueLite {
  id: number;
  issueKey?: string;
  summary?: string;
  description?: string;
  issueType?: { name?: string } | null;
}

export const sameName = (a: string | undefined, b: string | undefined) =>
  (a ?? "").trim() === (b ?? "").trim();

/** 404（プロジェクトに該当なし）は「なし」として扱う。logvalet の ErrNotFound と同じ。 */
async function orEmptyOnNotFound<T>(run: () => Promise<T[] | undefined>): Promise<T[]> {
  try {
    return (await run()) ?? [];
  } catch (e) {
    if (e instanceof BacklogApiError && e.status === 404) return [];
    throw e;
  }
}

/** 課題種別で絞った課題を、ページ数の上限つきで順に取る。 */
export async function listIssuesOfType(
  client: BacklogClient,
  projectId: number,
  issueTypeId: number,
): Promise<BacklogIssueLite[]> {
  return orEmptyOnNotFound(async () => {
    const { items } = await fetchByOffset<BacklogIssueLite>(async ({ offset, count }) => {
      const page = await client.request<BacklogIssueLite[]>("GET", "/issues", {
        query: {
          projectId: [projectId],
          issueTypeId: [issueTypeId],
          count,
          offset: offset > 0 ? offset : undefined,
        },
      });
      return page ?? [];
    });
    return items;
  });
}

export function listProjectIssueTypes(
  client: BacklogClient,
  projectKey: string,
): Promise<BacklogIssueTypeRef[]> {
  return orEmptyOnNotFound(() =>
    client.request<BacklogIssueTypeRef[]>("GET", `/projects/${seg(projectKey)}/issueTypes`),
  );
}

export interface LoadedConventions {
  result: ShowResult;
  projectId: number;
  issueTypes: BacklogIssueTypeRef[];
}

/** 規約を読む。engagement の解決と共有するため、解決済みのプロジェクト ID と課題種別も返す。 */
export async function loadProjectConventions(
  client: BacklogClient,
  rawProjectKey: string,
): Promise<LoadedConventions> {
  const projectKey = rawProjectKey.trim();
  if (projectKey === "") throw new ArgumentError("project key is required");

  const projectId = await resolveProjectId(client, projectKey);
  const issueTypes = await listProjectIssueTypes(client, projectKey);
  const ruleType = issueTypes.find((t) => sameName(t.name, RULE_ISSUE_TYPE));
  const candidates = ruleType ? await listIssuesOfType(client, projectId, ruleType.id) : [];
  const ruleIssues = candidates.filter((i) => sameName(i.issueType?.name, RULE_ISSUE_TYPE));

  const result: ShowResult = {
    project_key: projectKey,
    issue_key: "",
    adopted: false,
    glossary: GLOSSARY,
  };
  if (ruleIssues.length > 1) {
    throw new ConventionsError(
      `issue "${RULE_ISSUE_TYPE}"（規約課題）が複数あります（${ruleIssues.length} 件）`,
    );
  }
  const rule = ruleIssues[0];
  if (!rule) return { result, projectId, issueTypes };

  let conventions: Conventions;
  try {
    conventions = loadFromIssueDescription(rule.description ?? "");
  } catch (e) {
    const detail = e instanceof Error ? e.message : "読み込めません";
    throw new ConventionsError(
      `規約課題 "${rule.issueKey ?? ""}" の説明欄の読み込みに失敗しました: ${detail}`,
    );
  }
  return {
    result: {
      project_key: projectKey,
      issue_key: rule.issueKey ?? "",
      adopted: true,
      conventions,
      glossary: GLOSSARY,
    },
    projectId,
    issueTypes,
  };
}

export async function showConventions(
  client: BacklogClient,
  projectKey: string,
): Promise<ShowResult> {
  return (await loadProjectConventions(client, projectKey)).result;
}
