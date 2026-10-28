import { describe, expect, it } from "vitest";
import { activityTypeName } from "../../src/analysis/activity-types";

describe("activityTypeName(Backlog の type 番号 → 名前。1 か所に集約)", () => {
  it("1〜21 の名前", () => {
    const expected = [
      "issue_created",
      "issue_updated",
      "issue_commented",
      "issue_deleted",
      "wiki_created",
      "wiki_updated",
      "wiki_deleted",
      "file_added",
      "file_updated",
      "file_deleted",
      "svn_committed",
      "git_pushed",
      "git_created",
      "issue_multi_updated",
      "project_user_added",
      "project_user_deleted",
      "comment_notification",
      "pr_created",
      "pr_updated",
      "pr_commented",
      "pr_merged",
    ];
    expected.forEach((name, i) => {
      expect(activityTypeName(i + 1), `type ${i + 1}`).toBe(name);
    });
  });
  it("未知の番号は unknown_<番号>", () => {
    expect(activityTypeName(0)).toBe("unknown_0");
    expect(activityTypeName(22)).toBe("unknown_22");
  });
});
