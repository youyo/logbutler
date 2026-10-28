/**
 * プロジェクト設定ツール 12 個(ADR 0013)。スイート自身が作ったもの(名前に MARK)だけを対象に、
 * add → meta_* で読み戻し → update → 読み戻し → delete → 消えたことを確認する。管理者権限が必要。
 * 失敗しても afterAll で、作ったものを必ず消す。
 */
import { afterAll, describe, expect, it } from "vitest";
import { errorOf, NAME_MARK } from "../helpers/live";
import { cleanupSettings, listMeta, registry, substituteStatusId } from "../helpers/settings";
import { world } from "../helpers/world";

export function projectSettingsSuite(): void {
  describe("プロジェクト設定(追加・更新・削除。管理者権限が必要)", () => {
    afterAll(async () => {
      const failures = await cleanupSettings();
      expect(failures, "後片付けで消せなかった設定(手動で削除する)").toEqual([]);
    }, 120_000);

    it("カテゴリー: add → 読み戻し → update → 読み戻し → delete → 消えた", async () => {
      const { client, config, projectId } = world();
      const key = config.projectKey;
      const added = await client.ok("logbutler_category_add", {
        project_key: key,
        name: `${NAME_MARK} category`,
      });
      registry.category.add(added.id);
      expect(added).toMatchObject({ projectId, name: `${NAME_MARK} category` });
      expect(added).toHaveProperty("displayOrder"); // 生データ(camelCase)
      expect((await listMeta(client, "category", key)).find((c) => c.id === added.id)?.name).toBe(
        `${NAME_MARK} category`,
      );

      const updated = await client.ok("logbutler_category_update", {
        project_key: key,
        category_id: added.id,
        name: `${NAME_MARK} category renamed`,
      });
      expect(updated).toMatchObject({ id: added.id, name: `${NAME_MARK} category renamed` });
      expect((await listMeta(client, "category", key)).find((c) => c.id === added.id)?.name).toBe(
        `${NAME_MARK} category renamed`,
      );

      const deleted = await client.ok("logbutler_category_delete", {
        project_key: key,
        category_id: added.id,
      });
      expect(deleted.id).toBe(added.id);
      registry.category.delete(added.id);
      expect((await listMeta(client, "category", key)).map((c) => c.id)).not.toContain(added.id);
    });

    it("バージョン: add(日付つき)→ 読み戻し → update(アーカイブ・期限)→ 読み戻し → delete → 消えた", async () => {
      const { client, config, projectId } = world();
      const key = config.projectKey;
      const added = await client.ok("logbutler_version_add", {
        project_key: key,
        name: `${NAME_MARK} version`,
        description: "live",
        start_date: "2030-01-01",
        release_due_date: "2030-03-31",
      });
      registry.version.add(added.id);
      expect(added).toMatchObject({ projectId, name: `${NAME_MARK} version`, archived: false });
      const read = (await listMeta(client, "version", key)).find((v) => v.id === added.id);
      expect(read).toMatchObject({ description: "live" });
      expect(String(read?.startDate)).toContain("2030-01-01");
      expect(String(read?.releaseDueDate)).toContain("2030-03-31");

      const updated = await client.ok("logbutler_version_update", {
        project_key: key,
        version_id: added.id,
        name: `${NAME_MARK} version renamed`,
        description: "live updated",
        release_due_date: "2030-06-30",
        archived: true,
      });
      expect(updated).toMatchObject({ id: added.id, archived: true });
      const reread = (await listMeta(client, "version", key)).find((v) => v.id === added.id);
      expect(reread).toMatchObject({
        name: `${NAME_MARK} version renamed`,
        description: "live updated",
        archived: true,
      });
      expect(String(reread?.releaseDueDate)).toContain("2030-06-30");

      await client.ok("logbutler_version_delete", { project_key: key, version_id: added.id });
      registry.version.delete(added.id);
      expect((await listMeta(client, "version", key)).map((v) => v.id)).not.toContain(added.id);
    });

    it("状態: add(色つき)→ 読み戻し → update(名前・色)→ 読み戻し → delete(代替の状態を指定)→ 消えた", async () => {
      const { client, config, projectId } = world();
      const key = config.projectKey;
      const added = await client.ok("logbutler_status_add", {
        project_key: key,
        name: `${NAME_MARK} status`,
        color: "#e87758",
      });
      registry.status.add(added.id);
      expect(added).toMatchObject({ projectId, name: `${NAME_MARK} status`, color: "#e87758" });
      expect((await listMeta(client, "status", key)).find((s) => s.id === added.id)).toMatchObject({
        color: "#e87758",
      });

      const updated = await client.ok("logbutler_status_update", {
        project_key: key,
        status_id: added.id,
        name: `${NAME_MARK} status 2`,
        color: "#3b9dbd",
      });
      expect(updated).toMatchObject({ id: added.id, color: "#3b9dbd" });
      expect((await listMeta(client, "status", key)).find((s) => s.id === added.id)).toMatchObject({
        name: `${NAME_MARK} status 2`,
        color: "#3b9dbd",
      });

      const substitute = await substituteStatusId(client, key, [added.id]);
      const deleted = await client.ok("logbutler_status_delete", {
        project_key: key,
        status_id: added.id,
        substitute_status_id: substitute,
      });
      expect(deleted.id).toBe(added.id);
      registry.status.delete(added.id);
      expect((await listMeta(client, "status", key)).map((s) => s.id)).not.toContain(added.id);
    });

    it("カスタム属性(テキスト型): add → 読み戻し → update → 読み戻し → delete → 消えた", async () => {
      const { client, config, projectId } = world();
      const key = config.projectKey;
      const added = await client.ok("logbutler_custom_field_add", {
        project_key: key,
        type_id: 1,
        name: `${NAME_MARK} text`,
        description: "live",
      });
      registry.custom_field.add(added.id);
      expect(added).toMatchObject({
        projectId,
        typeId: 1,
        name: `${NAME_MARK} text`,
        required: false,
      });
      expect(
        (await listMeta(client, "custom_field", key)).find((f) => f.id === added.id),
      ).toMatchObject({ typeId: 1, description: "live" });

      const updated = await client.ok("logbutler_custom_field_update", {
        project_key: key,
        custom_field_id: added.id,
        name: `${NAME_MARK} text renamed`,
        description: "live updated",
        required: true,
      });
      expect(updated).toMatchObject({ id: added.id, required: true });
      expect(
        (await listMeta(client, "custom_field", key)).find((f) => f.id === added.id),
      ).toMatchObject({
        name: `${NAME_MARK} text renamed`,
        description: "live updated",
        required: true,
      });

      await client.ok("logbutler_custom_field_delete", {
        project_key: key,
        custom_field_id: added.id,
      });
      registry.custom_field.delete(added.id);
      expect((await listMeta(client, "custom_field", key)).map((f) => f.id)).not.toContain(
        added.id,
      );
    });

    it("カスタム属性(単一リスト型): 初期 items つきで add → items を読み戻し → update → delete → 消えた", async () => {
      const { client, config } = world();
      const key = config.projectKey;
      const added = await client.ok("logbutler_custom_field_add", {
        project_key: key,
        type_id: 5,
        name: `${NAME_MARK} list`,
        items: ["alpha", "beta"],
        allow_input: false,
      });
      registry.custom_field.add(added.id);
      expect(added).toMatchObject({ typeId: 5, name: `${NAME_MARK} list` });
      const read = (await listMeta(client, "custom_field", key)).find((f) => f.id === added.id);
      const itemNames = ((read?.items ?? []) as Array<{ name: string }>).map((i) => i.name);
      expect(itemNames.sort()).toEqual(["alpha", "beta"]);

      const updated = await client.ok("logbutler_custom_field_update", {
        project_key: key,
        custom_field_id: added.id,
        name: `${NAME_MARK} list renamed`,
        allow_input: true,
      });
      expect(updated).toMatchObject({ id: added.id, name: `${NAME_MARK} list renamed` });
      expect(
        (await listMeta(client, "custom_field", key)).find((f) => f.id === added.id)?.name,
      ).toBe(`${NAME_MARK} list renamed`);

      await client.ok("logbutler_custom_field_delete", {
        project_key: key,
        custom_field_id: added.id,
      });
      registry.custom_field.delete(added.id);
      expect((await listMeta(client, "custom_field", key)).map((f) => f.id)).not.toContain(
        added.id,
      );
    });

    it("不正な引数は Backlog を呼ぶ前に argument_error(色・代替状態・型に合わない引数)", async () => {
      const { client, config } = world();
      const key = config.projectKey;
      const before = (await listMeta(client, "status", key)).length;
      for (const [tool, args] of [
        ["logbutler_status_add", { project_key: key, name: `${NAME_MARK} bad`, color: "#ffffff" }],
        ["logbutler_status_delete", { project_key: key, status_id: 1 }],
        ["logbutler_custom_field_add", { project_key: key, type_id: 1, name: "x", items: ["a"] }],
        ["logbutler_category_update", { project_key: key, category_id: 0, name: "x" }],
      ] as Array<[string, Record<string, unknown>]>) {
        expect(errorOf(await client.call(tool, args))?.code, tool).toBe("argument_error");
      }
      expect((await listMeta(client, "status", key)).length).toBe(before);
    });
  });
}
