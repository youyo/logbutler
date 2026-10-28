import { describe, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/server";
import baseline from "../fixtures/logvalet_tools_list_baseline.json";
import {
  ALLOWED_CHANGES,
  ALLOWED_EXTRA,
  ALLOWED_MISSING,
  compareWithBaseline,
  fromLogvaletBaseline,
  type McpToolListing,
  normalizeTools,
} from "../helpers/baseline";
import { fakeClient, rpcTo } from "../helpers/mcp";

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
      JSON.stringify(normalizeTools(await listTools()), null, 2) + "\n",
    ).toMatchFileSnapshot("../snapshots/tools_list.json");
  });

  it("logvalet の baseline と比べて(user_me のみ)差分がない", async () => {
    const result = compareWithBaseline(
      await listTools(),
      fromLogvaletBaseline(baseline as unknown as Parameters<typeof fromLogvaletBaseline>[0]),
      {
        only: ["logbutler_user_me"],
        allowedChanges: ALLOWED_CHANGES,
        allowedMissing: ALLOWED_MISSING,
        allowedExtra: ALLOWED_EXTRA,
      },
    );
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
