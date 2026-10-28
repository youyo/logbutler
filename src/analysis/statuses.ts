import { parseCsvStrings } from "../mcp/args";

/** 完了とみなす状態(全分析共通。ロードマップの決定事項。logvalet はツールにより「完了」のみと 5 種に分かれていた)。 */
export const DONE_STATUSES: readonly string[] = ["完了", "対応済み", "Closed", "Done", "Resolved"];

/** `exclude_status`(CSV)があればそれだけ、なければ完了集合。 */
export function excludeSetFrom(csv: string | undefined): ReadonlySet<string> {
  const names = parseCsvStrings(csv);
  return new Set(names.length > 0 ? names : DONE_STATUSES);
}

export const statusName = (issue: { status?: { name: string } | null }): string =>
  issue.status?.name ?? "";

/** status のない課題は除外しない(logvalet と同じ)。 */
export const isExcluded = (
  issue: { status?: { name: string } | null },
  excluded: ReadonlySet<string>,
): boolean => {
  const name = statusName(issue);
  return name !== "" && excluded.has(name);
};
