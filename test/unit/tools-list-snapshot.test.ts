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
  RESPONSE_LIMIT_TOOLS,
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

/** 計画書(plans/logbutler-m04-write-tools.md)の対象ツール。project_conventions は M05 から前倒し。 */
const M04_TOOLS = [
  "issue_create",
  "issue_comment_add",
  "issue_attachment_upload",
  "document_create",
  "issue_update",
  "issue_comment_update",
  "issue_related_add",
  "star_add",
  "watching_add",
  "watching_update",
  "watching_mark_as_read",
  "issue_related_delete",
  "issue_attachment_delete",
  "watching_delete",
  "project_conventions",
].map((n) => `logbutler_${n}`);

/** 計画書(plans/logbutler-m05-analysis-digest.md)の M05A: 分析系の加工ツール 11 個。 */
const M05A_TOOLS = [
  "issue_stale",
  "project_blockers",
  "user_workload",
  "project_health",
  "issue_context",
  "issue_triage_materials",
  "my_tasks",
  "digest_daily",
  "digest_weekly",
  "issue_timeline",
  "activity_stats",
].map((n) => `logbutler_${n}`);

/** 計画書(plans/logbutler-m05-analysis-digest.md)の M05B: digest 系 6 個 + user_activity。 */
const M05B_TOOLS = [
  "space_digest",
  "document_digest",
  "document_search",
  "search",
  "activity_digest",
  "user_activity",
  "digest_unified",
].map((n) => `logbutler_${n}`);

/** 計画書(plans/logbutler-m06-official-mcp-features.md)の 3 ツール。logvalet に無い(Nulab 公式 MCP から取り込み)。 */
const M06_TOOLS = ["notification_list", "notification_count", "project_users"].map(
  (n) => `logbutler_${n}`,
);

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

  it("M03 の 38 ツール、M04 の 15 ツール、M05A の 11 ツール、M05B の 7 ツール = logvalet の 71 ツールと、M06 の 3 ツール = 74 ツールを公開している", async () => {
    const names = (await listTools()).map((t) => t.name).sort();
    expect(names).toEqual(
      [...M03_TOOLS, ...M04_TOOLS, ...M05A_TOOLS, ...M05B_TOOLS, ...M06_TOOLS].sort(),
    );
    expect(names).toHaveLength(38 + 15 + 11 + 7 + 3);
    expect(names).toHaveLength(74);
  });

  it("M06 の 3 ツールは読み取り専用で、notification_* は notification、project_users は project の toolset", async () => {
    const tools = await listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const n of M06_TOOLS) {
      expect(byName.get(n)?.annotations, n).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
      });
    }
    expect(byName.get("logbutler_notification_list")?.description).toMatch(/not mark/i);
  });

  it("書き込み・破壊的ツール 14 個のカテゴリ(annotation)が計画書どおり", async () => {
    const byName = new Map((await listTools()).map((t) => [t.name, t.annotations]));
    const kind = (n: string) => {
      const a = byName.get(`logbutler_${n}`) as Record<string, boolean> | undefined;
      if (a?.readOnlyHint) return "ReadOnly";
      if (a?.destructiveHint) return "Destructive";
      return a?.idempotentHint ? "WriteIdempotent" : "WriteNonIdempotent";
    };
    for (const n of [
      "issue_create",
      "issue_comment_add",
      "issue_attachment_upload",
      "document_create",
    ])
      expect(kind(n), n).toBe("WriteNonIdempotent");
    for (const n of [
      "issue_update",
      "issue_comment_update",
      "issue_related_add",
      "star_add",
      "watching_add",
      "watching_update",
      "watching_mark_as_read",
    ])
      expect(kind(n), n).toBe("WriteIdempotent");
    for (const n of ["issue_related_delete", "issue_attachment_delete", "watching_delete"])
      expect(kind(n), n).toBe("Destructive");
    expect(kind("project_conventions")).toBe("ReadOnly");
  });

  it("M05A の 11 ツールはすべて分析系で、読み取り専用(ReadOnly)", async () => {
    const byName = new Map((await listTools()).map((t) => [t.name, t.annotations]));
    for (const n of M05A_TOOLS) {
      expect(byName.get(n), n).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    }
  });

  it("M05B の 7 ツールはすべて読み取り専用(ReadOnly)で、digest / search / activity の toolset に属する", async () => {
    const byName = new Map((await listTools()).map((t) => [t.name, t.annotations]));
    for (const n of M05B_TOOLS) {
      expect(byName.get(n), n).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    }
  });

  it("logvalet の baseline と比べて、71 ツールすべてで差分がない(許容リストの分を除く)", async () => {
    const result = compareWithBaseline(
      await listTools(),
      fromLogvaletBaseline(baseline as unknown as Parameters<typeof fromLogvaletBaseline>[0]),
      {
        only: [...M03_TOOLS, ...M04_TOOLS, ...M05A_TOOLS, ...M05B_TOOLS],
        allowedChanges: ALLOWED_CHANGES,
        allowedMissing: ALLOWED_MISSING,
        allowedExtra: ALLOWED_EXTRA,
      },
    );
    // 失敗したときに、どのツールのどの property が違うかが読めるようにする。
    expect(formatCompareResult(result)).toBe("");
    expect(result).toEqual({ missing: [], extra: [], changed: [] });
  });

  it("許容した issue_attachment_upload の差分は、file_paths の削除に伴う 3 か所だけ", async () => {
    const result = compareWithBaseline(
      await listTools(),
      fromLogvaletBaseline(baseline as unknown as Parameters<typeof fromLogvaletBaseline>[0]),
      { only: ["logbutler_issue_attachment_upload"] },
    );
    const where = result.changed.flatMap((c) =>
      c.diffs.map((d) => (d.path === "" ? d.field : `${d.field}.${d.path}`)),
    );
    expect(where.sort()).toEqual([
      "description",
      "inputSchema.properties.file_content_base64.description",
      "inputSchema.properties.file_paths",
    ]);
  });

  it("許容した timezone 引数の差分は、9 ツールそれぞれ inputSchema.properties.timezone の追加と max_response_tokens の追加だけ", async () => {
    const tools = [
      "issue_list",
      "my_tasks",
      "digest_daily",
      "digest_weekly",
      "activity_stats",
      "issue_timeline",
      "activity_digest",
      "user_activity",
      "digest_unified",
    ].map((n) => `logbutler_${n}`);
    const result = compareWithBaseline(
      await listTools(),
      fromLogvaletBaseline(baseline as unknown as Parameters<typeof fromLogvaletBaseline>[0]),
      { only: tools },
    );
    expect(result.changed.map((c) => c.name).sort()).toEqual([...tools].sort());
    for (const c of result.changed) {
      const diffs = c.diffs.map((d) => ({ path: `${d.field}.${d.path}`, expected: d.expected }));
      expect(diffs, c.name).toEqual([
        { path: "inputSchema.properties.max_response_tokens", expected: undefined },
        { path: "inputSchema.properties.timezone", expected: undefined },
      ]);
    }
  });

  it("max_response_tokens は読み取りツール 55 個(ダウンロード系 2 個を除く)にだけあり、差分は properties の追加だけ", async () => {
    const tools = await listTools();
    // 引数を持つツール = ReadOnly の annotation を持つツールからダウンロード系を除いたもの(M06 の 3 ツールを含む)
    const withArg = tools
      .filter((t) => "max_response_tokens" in (t.inputSchema.properties as object))
      .map((t) => t.name)
      .sort();
    const readOnly = tools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name)
      .filter((n) => !/_attachment_download$|_shared_file_download$/.test(n))
      .sort();
    expect(withArg).toEqual(readOnly);
    expect(withArg).toEqual([...RESPONSE_LIMIT_TOOLS, ...M06_TOOLS].sort());
    expect(RESPONSE_LIMIT_TOOLS).toHaveLength(55);

    const result = compareWithBaseline(
      tools,
      fromLogvaletBaseline(baseline as unknown as Parameters<typeof fromLogvaletBaseline>[0]),
      { only: [...RESPONSE_LIMIT_TOOLS] },
    );
    for (const c of result.changed) {
      const paths = c.diffs
        .map((d) => `${d.field}.${d.path}`)
        .filter((p) => p !== "inputSchema.properties.timezone");
      expect(paths, c.name).toEqual(["inputSchema.properties.max_response_tokens"]);
    }
    expect(result.changed).toHaveLength(55);
  });

  it("baseline fixture は 71 ツールで、すべて logbutler_ に置換できる", () => {
    const tools = fromLogvaletBaseline(
      baseline as unknown as Parameters<typeof fromLogvaletBaseline>[0],
    );
    expect(tools).toHaveLength(71);
    expect(tools.every((t) => t.name.startsWith("logbutler_"))).toBe(true);
  });
});
