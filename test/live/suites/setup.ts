/** 接続・プロジェクト設定の取得・tools/list。以降の suite はここで作る world を使う。 */
import { beforeAll, describe, expect, it } from "vitest";
import { created } from "../helpers/issues";
import { LiveClient, loadConfig, MARK } from "../helpers/live";
import { DONE_NAMES, loadSnapshotTools, setWorld, world } from "../helpers/world";

export function setupSuite(): void {
  describe("setup: 接続とプロジェクト設定", () => {
    beforeAll(async () => {
      const config = loadConfig();
      const client = await LiveClient.connect(config);
      const snapshotTools = loadSnapshotTools();

      const project = await client.ok("logbutler_project_get", { project_key: config.projectKey });
      const me = await client.ok("logbutler_user_me");
      const types = await client.ok("logbutler_meta_issue_types", {
        project_key: config.projectKey,
      });
      const statuses = (await client.ok("logbutler_meta_statuses", {
        project_key: config.projectKey,
      })) as Array<{ id: number; name: string }>;
      const sorted = [...statuses];
      const done = sorted.find((s) => DONE_NAMES.includes(s.name));
      if (!done) {
        throw new Error(
          `プロジェクトに完了とみなす状態(${DONE_NAMES.join(", ")})がない: ${statuses.map((s) => s.name).join(", ")}。` +
            "ユーザーが用意する必要がある。",
        );
      }
      const rest = sorted.filter((s) => s.id !== done.id);
      const open = rest[0];
      const mid = rest[1] ?? rest[0];
      if (!open || !mid) throw new Error("プロジェクトに完了以外の状態が 2 つ以上ない");

      // 優先度は課題から集める(GET /priorities を呼ぶツールがないため)。
      const issues = (await client.ok("logbutler_issue_list", {
        project_key: config.projectKey,
        count: 100,
        max_response_tokens: 0,
      })) as Array<{ priority?: { id: number } }>;
      const priorityIds = [
        ...new Set(
          issues.map((i) => i.priority?.id).filter((x): x is number => typeof x === "number"),
        ),
      ];
      if (priorityIds.length === 0) {
        // 新しいテスト用プロジェクトなど、課題が 0 件のとき: priority_id を省略して作成し
        // (Logbutler が GET /priorities から既定値を解決する)、その課題の優先度を使う。
        // 作った課題は他の作成物と同様に残る(削除ツールがない)。
        const seed = (await client.ok("logbutler_issue_create", {
          project_key: config.projectKey,
          summary: `${MARK} setup: 優先度取得用`,
          issue_type_id: types[0].id,
        })) as { issueKey: string; priority?: { id: number } };
        created.log.push(seed.issueKey);
        if (typeof seed.priority?.id !== "number") {
          throw new Error("priority_id を省略して作った課題に優先度がない");
        }
        priorityIds.push(seed.priority.id);
      }

      const space = (await client.ok("logbutler_space_info", {})) as { spaceKey: string };

      setWorld({
        config,
        client,
        projectId: project.id,
        spaceKey: space.spaceKey,
        meId: me.id,
        issueTypeId: types[0].id,
        statuses: sorted,
        openStatus: open,
        midStatus: mid,
        doneStatus: done,
        priorityIds,
        snapshotTools,
      });
    }, 120_000);

    it("LOGBUTLER_LIVE_PROJECT_KEY と状態ファイルが読めて、アクセストークンが得られている", () => {
      const w = world();
      expect(w.config.projectKey).not.toBe("");
      expect(w.projectId).toBeGreaterThan(0);
      expect(w.meId).toBeGreaterThan(0);
    });

    it("tools/list: 86 個で、スナップショットと名前が一致する", async () => {
      const w = world();
      const r = await w.client.listTools();
      expect(r.status).toBe(200);
      const names = (r.body.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
      expect(names).toHaveLength(86);
      expect(names).toEqual(w.snapshotTools.map((t) => t.name).sort());
    });

    it("tools/list: すべてのツールに annotations があり、読み取り専用の区分がスナップショットと一致する", async () => {
      const w = world();
      const r = await w.client.listTools();
      const tools = r.body.result.tools as Array<{
        name: string;
        inputSchema: { type: string };
        annotations?: { readOnlyHint?: boolean };
      }>;
      for (const t of tools) {
        const expected = w.snapshotTools.find((s) => s.name === t.name);
        expect(t.annotations?.readOnlyHint, t.name).toBe(expected?.readOnly);
        expect(t.inputSchema.type, t.name).toBe("object");
      }
    });
  });
}
