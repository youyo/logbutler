import { describe, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/server";
import baseline from "../fixtures/logvalet_tools_list_baseline.json";
import {
  ALLOWED_CHANGES,
  ALLOWED_EXTRA,
  ALLOWED_MISSING,
  compareWithBaseline,
  formatCompareResult,
  fromLogvaletBaseline,
  type McpToolListing,
  normalizeTools,
} from "../helpers/baseline";
import { fakeClient, rpcTo } from "../helpers/mcp";

/** 計画書(plans/logbutler-m03-read-tools.md)の対象ツール。user_me は M01 で実装済み。 */
const M03_TOOLS = [
  "activity_list",
  "document_get",
  "document_list",
  "document_tree",
  "issue_get",
  "issue_list",
  "issue_comment_list",
  "issue_attachment_list",
  "issue_attachment_download",
  "issue_related_list",
  "meta_statuses",
  "meta_issue_types",
  "meta_categories",
  "meta_version",
  "meta_custom_field",
  "project_get",
  "project_list",
  "shared_file_list",
  "shared_file_download",
  "space_info",
  "space_disk_usage",
  "team_list",
  "team_get",
  "team_project",
  "user_me",
  "user_get",
  "user_list",
  "watching_list",
  "watching_get",
  "watching_count",
  "wiki_list",
  "wiki_get",
  "wiki_count",
  "wiki_tags",
  "wiki_history",
  "wiki_stars",
  "wiki_attachment_list",
  "wiki_sharedfile_list",
].map((n) => `logbutler_${n}`);

async function listTools(): Promise<McpToolListing[]> {
  const { result } = await rpcTo(
    () => createMcpServer({ getClient: () => fakeClient(), onBacklogUnauthorized: () => {} }),
    "tools/list",
  );
  return (result?.tools ?? []) as unknown as McpToolListing[];
}

describe("tools/list スナップショット", () => {
  it("公開しているツールの定義(名前・説明・入力スキーマ・annotation)が固定されている", async () => {
    // ツールを足す・変えるときは意図して更新する: mise run test:update-snapshots
    await expect(
      `${JSON.stringify(normalizeTools(await listTools()), null, 2)}\n`,
    ).toMatchFileSnapshot("../snapshots/tools_list.json");
  });

  it("M03 の対象 38 ツールを公開している(加工系 19 と書き込みは含まない)", async () => {
    const names = (await listTools()).map((t) => t.name).sort();
    expect(names).toEqual([...M03_TOOLS].sort());
    expect(names).toHaveLength(38);
  });

  it("logvalet の baseline と比べて、38 ツールすべてで差分がない(許容リストの分を除く)", async () => {
    const result = compareWithBaseline(
      await listTools(),
      fromLogvaletBaseline(baseline as unknown as Parameters<typeof fromLogvaletBaseline>[0]),
      {
        only: M03_TOOLS,
        allowedChanges: ALLOWED_CHANGES,
        allowedMissing: ALLOWED_MISSING,
        allowedExtra: ALLOWED_EXTRA,
      },
    );
    // 失敗したときに、どのツールのどの property が違うかが読めるようにする。
    expect(formatCompareResult(result)).toBe("");
    expect(result).toEqual({ missing: [], extra: [], changed: [] });
  });

  it("baseline fixture は 71 ツールで、すべて logbutler_ に置換できる", () => {
    const tools = fromLogvaletBaseline(
      baseline as unknown as Parameters<typeof fromLogvaletBaseline>[0],
    );
    expect(tools).toHaveLength(71);
    expect(tools.every((t) => t.name.startsWith("logbutler_"))).toBe(true);
  });
});
