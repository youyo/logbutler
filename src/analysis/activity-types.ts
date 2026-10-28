/**
 * Backlog の activity type 番号 → 名前(spec §12)。logvalet は analysis と digest の 2 か所に同じ表を
 * 持っていた。ここに 1 か所だけ置き、timeline / activity_stats / M05B の digest が使う。
 */
const NAMES: readonly string[] = [
  "issue_created", // 1
  "issue_updated", // 2
  "issue_commented", // 3
  "issue_deleted", // 4
  "wiki_created", // 5
  "wiki_updated", // 6
  "wiki_deleted", // 7
  "file_added", // 8
  "file_updated", // 9
  "file_deleted", // 10
  "svn_committed", // 11
  "git_pushed", // 12
  "git_created", // 13
  "issue_multi_updated", // 14
  "project_user_added", // 15
  "project_user_deleted", // 16
  "comment_notification", // 17
  "pr_created", // 18
  "pr_updated", // 19
  "pr_commented", // 20
  "pr_merged", // 21
];

export const activityTypeName = (type: number): string => NAMES[type - 1] ?? `unknown_${type}`;
