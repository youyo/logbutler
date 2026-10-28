/** 規約(conventions)に照らした曖昧さの検出(logvalet `internal/analysis/ambiguity.go`)。 */
import { type Conventions, ENGAGEMENT_ISSUE_TYPE, RULE_ISSUE_TYPE } from "../conventions/load";
import { type BacklogIssue, compareKeys } from "./issues";

export type AmbiguityKind =
  | "no_engagement"
  | "multiple_engagements"
  | "missing_parent_issue"
  | "missing_lead"
  | "missing_due_date"
  | "unknown_initiative"
  | "close_candidate";

export interface Ambiguity {
  kind: AmbiguityKind;
  target: string;
  summary: string;
  detail: string;
}

export interface AmbiguityResult {
  adopted: boolean;
  total_count: number;
  ambiguities: Ambiguity[];
}

export const emptyAmbiguity = (): AmbiguityResult => ({
  adopted: false,
  total_count: 0,
  ambiguities: [],
});

const KIND_ORDER: Record<AmbiguityKind, number> = {
  no_engagement: 0,
  multiple_engagements: 1,
  missing_parent_issue: 2,
  missing_lead: 3,
  missing_due_date: 4,
  unknown_initiative: 5,
  close_candidate: 6,
};

const norm = (s: string | undefined | null) => (s ?? "").trim();

const forIssue = (kind: AmbiguityKind, issue: BacklogIssue, detail: string): Ambiguity => ({
  kind,
  target: issue.issueKey,
  summary: issue.summary,
  detail,
});

/** 低優先度のまま lowUntouchedDays を「超えて」更新されていない(境界は含めない)。 */
function isCloseCandidate(
  issue: BacklogIssue,
  lowUntouchedDays: number | null,
  now: Date,
): boolean {
  if (lowUntouchedDays === null || !issue.updated || !issue.priority) return false;
  if (issue.priority.name !== "低") return false;
  return now.getTime() - Date.parse(issue.updated) > lowUntouchedDays * 24 * 3600 * 1000;
}

export function detectAmbiguities(
  conventions: Conventions,
  issues: readonly BacklogIssue[],
  now: Date,
): Ambiguity[] {
  const out: Ambiguity[] = [];
  const engagements = conventions.engagements ?? [];
  const engagementNames = new Set(engagements.map((e) => norm(e.name)));
  const initiativeNames = new Set((conventions.initiatives ?? []).map((i) => norm(i.name)));

  for (const issue of issues) {
    const type = norm(issue.issueType?.name);
    if (type === RULE_ISSUE_TYPE || type === ENGAGEMENT_ISSUE_TYPE) continue;
    const matched = new Set(
      (issue.category ?? []).map((c) => norm(c.name)).filter((n) => engagementNames.has(n)),
    );
    if (matched.size === 0) {
      out.push(forIssue("no_engagement", issue, "案件カテゴリが付いていません"));
    } else if (matched.size > 1) {
      out.push(
        forIssue("multiple_engagements", issue, `案件カテゴリが ${matched.size} つ付いています`),
      );
    }
    if (isCloseCandidate(issue, conventions.close_policy.low_untouched_days, now)) {
      out.push(forIssue("close_candidate", issue, "低優先度のまま長期間更新されていません"));
    }
  }

  for (const engagement of engagements) {
    const name = norm(engagement.name);
    const parentSummary = `[案件] ${name}`;
    const parents = issues.filter(
      (i) => norm(i.issueType?.name) === ENGAGEMENT_ISSUE_TYPE && i.summary === parentSummary,
    );
    if (parents.length === 0) {
      out.push({
        kind: "missing_parent_issue",
        target: name,
        summary: parentSummary,
        detail: `案件「${name}」に対応する親課題がありません`,
      });
    }
    for (const parent of parents) {
      if (!parent.assignee) {
        out.push(forIssue("missing_lead", parent, "案件親課題に担当者がいません"));
      }
      if (!parent.dueDate) {
        out.push(forIssue("missing_due_date", parent, "案件親課題に期限日がありません"));
      }
    }
    if (!initiativeNames.has(norm(engagement.initiative))) {
      out.push({
        kind: "unknown_initiative",
        target: name,
        summary: engagement.initiative,
        detail: `案件「${name}」のイニシアチブ「${engagement.initiative}」が定義されていません`,
      });
    }
  }

  // kind の順 → target → summary(安定。logvalet と同じ)。
  return out.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      compareKeys(a.target, b.target) ||
      compareKeys(a.summary, b.summary),
  );
}
