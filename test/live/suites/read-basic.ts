/** 読み取り系ツール(Backlog の生データを返すもの)。camelCase のまま返ること、件数・絞り込みが効くことを確かめる。 */
import { describe, expect, it } from "vitest";
import { errorOf } from "../helpers/live";
import { world } from "../helpers/world";

const snake = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

export function readBasicSuite(): void {
  describe("読み取り系(Backlog 生データ)", () => {
    it("logbutler_user_me: 加工出力なので snake_case で、user_get と同じ人", async () => {
      const { client, meId } = world();
      const me = await client.ok("logbutler_user_me");
      expect(me).toMatchObject({ id: meId });
      for (const k of ["id", "user_id", "name", "mail_address", "role_type"])
        expect(me).toHaveProperty(k);
      for (const k of Object.keys(me)) expect(k, "snake_case").toMatch(snake);
      const got = await client.ok("logbutler_user_get", { user_id: String(meId) });
      expect(got.name).toBe(me.name);
      expect(got.mailAddress).toBe(me.mail_address); // 生データは camelCase
      expect(got).toHaveProperty("roleType");
    });

    it("logbutler_user_list / logbutler_user_get: 一覧に自分がいて、camelCase", async () => {
      const { client, meId } = world();
      const list = await client.ok("logbutler_user_list");
      expect(Array.isArray(list)).toBe(true);
      expect(list.map((u: { id: number }) => u.id)).toContain(meId);
      expect(list[0]).toHaveProperty("userId");
      // Backlog は存在しないユーザー ID に 403(code=5)を返す。ADR 0004 の対応で permission_error になる。
      const r = await client.call("logbutler_user_get", { user_id: "999999999" });
      expect(errorOf(r)?.code).toBe("permission_error");
    });

    it("logbutler_project_list / logbutler_project_get: テスト用プロジェクトが載り、設定が一貫している", async () => {
      const { client, config, projectId } = world();
      const list = await client.ok("logbutler_project_list");
      const found = list.find((p: { projectKey: string }) => p.projectKey === config.projectKey);
      expect(found?.id).toBe(projectId);
      const p = await client.ok("logbutler_project_get", { project_key: config.projectKey });
      expect(p).toMatchObject({ id: projectId, projectKey: config.projectKey });
      for (const k of ["name", "useWiki", "useDocument", "useFileSharing", "archived"]) {
        expect(p).toHaveProperty(k);
      }
      // 数値の ID でも引ける(Backlog の仕様: projectIdOrKey)
      const byId = await client.ok("logbutler_project_get", { project_key: String(projectId) });
      expect(byId.projectKey).toBe(config.projectKey);
      const missing = await client.call("logbutler_project_get", { project_key: "NOSUCHPROJ" });
      expect(errorOf(missing)?.code).toBe("not_found");
    });

    it("logbutler_project_users: 参加者に自分が含まれる", async () => {
      const { client, config, meId } = world();
      const users = await client.ok("logbutler_project_users", { project_key: config.projectKey });
      expect(users.map((u: { id: number }) => u.id)).toContain(meId);
      const noGroup = await client.ok("logbutler_project_users", {
        project_key: config.projectKey,
        exclude_group_members: true,
      });
      expect(Array.isArray(noGroup)).toBe(true);
    });

    it("logbutler_project_conventions: 規約課題が未導入でも snake_case の構造で返る", async () => {
      const { client, config } = world();
      const c = await client.ok("logbutler_project_conventions", {
        project_key: config.projectKey,
      });
      expect(c.project_key).toBe(config.projectKey);
      expect(typeof c.adopted).toBe("boolean");
      expect(Array.isArray(c.glossary)).toBe(true);
    });

    it("logbutler_meta_issue_types / statuses: 取得した ID で課題を作れる形(id, name, projectId)", async () => {
      const { client, config, projectId, statuses } = world();
      const types = await client.ok("logbutler_meta_issue_types", {
        project_key: config.projectKey,
      });
      expect(types.length).toBeGreaterThan(0);
      for (const t of types) expect(t).toMatchObject({ projectId });
      expect(statuses.length).toBeGreaterThanOrEqual(2);
      const s = await client.ok("logbutler_meta_statuses", { project_key: config.projectKey });
      expect(s.map((x: { id: number }) => x.id)).toEqual(statuses.map((x) => x.id));
    });

    it("logbutler_meta_categories / meta_version / meta_custom_field: 配列で返る(このプロジェクトは 0 件でも形は同じ)", async () => {
      const { client, config } = world();
      for (const tool of [
        "logbutler_meta_categories",
        "logbutler_meta_version",
        "logbutler_meta_custom_field",
      ]) {
        const r = await client.ok(tool, { project_key: config.projectKey });
        expect(Array.isArray(r), tool).toBe(true);
        for (const item of r) expect(item).toHaveProperty("id");
      }
    });

    it("logbutler_space_info / space_disk_usage", async () => {
      const { client, projectId } = world();
      const info = await client.ok("logbutler_space_info");
      for (const k of ["spaceKey", "name", "ownerId", "lang", "timezone"])
        expect(info).toHaveProperty(k);
      const du = await client.ok("logbutler_space_disk_usage");
      expect(typeof du.capacity).toBe("number");
      expect(du.capacity).toBeGreaterThan(0);
      expect(du.details.map((d: { projectId: number }) => d.projectId)).toContain(projectId);
    });

    it("logbutler_team_list / team_get / team_project", async () => {
      const { client, config } = world();
      const teams = await client.ok("logbutler_team_list");
      expect(Array.isArray(teams)).toBe(true);
      expect(teams.length).toBeGreaterThan(0);
      expect(teams[0]).toHaveProperty("members");
      const t = await client.ok("logbutler_team_get", { team_id: teams[0].id });
      expect(t.id).toBe(teams[0].id);
      expect(t.name).toBe(teams[0].name);
      const noMembers = await client.ok("logbutler_team_list", { no_members: true });
      expect(noMembers[0].members ?? []).toHaveLength(0);
      const paged = await client.ok("logbutler_team_list", { count: 1, offset: 0 });
      expect(paged.length).toBeLessThanOrEqual(1);
      const tp = await client.ok("logbutler_team_project", { project_key: config.projectKey });
      expect(Array.isArray(tp)).toBe(true);
      const missing = await client.call("logbutler_team_get", { team_id: 999999999 });
      expect(errorOf(missing)?.code).toBe("not_found");
    });

    it("logbutler_activity_list: count・project_key・activity_type_ids・order・user_id が効く", async () => {
      const { client, config, meId } = world();
      const two = await client.ok("logbutler_activity_list", {
        project_key: config.projectKey,
        count: 2,
      });
      expect(two.length).toBeLessThanOrEqual(2);
      expect(two.length).toBeGreaterThan(0);
      for (const a of two) {
        expect(a.project.projectKey).toBe(config.projectKey);
        expect(typeof a.type).toBe("number");
      }
      const asc = await client.ok("logbutler_activity_list", {
        project_key: config.projectKey,
        count: 5,
        order: "asc",
      });
      const desc = await client.ok("logbutler_activity_list", {
        project_key: config.projectKey,
        count: 5,
        order: "desc",
      });
      const ids = (xs: Array<{ id: number }>) => xs.map((x) => x.id);
      expect(ids(asc)).toEqual([...ids(asc)].sort((a, b) => a - b));
      expect(ids(desc)).toEqual([...ids(desc)].sort((a, b) => b - a));
      const typed = await client.ok("logbutler_activity_list", {
        project_key: config.projectKey,
        activity_type_ids: "1",
        count: 20,
      });
      for (const a of typed) expect(a.type).toBe(1);
      const mine = await client.ok("logbutler_activity_list", { user_id: String(meId), count: 3 });
      expect(Array.isArray(mine)).toBe(true);
    });

    it("logbutler_notification_count / notification_list: 形と整合(通知 0 件の環境でも成り立つ事実を検証)", async () => {
      const { client } = world();
      const c = await client.ok("logbutler_notification_count");
      expect(Number.isInteger(c.count)).toBe(true);
      const unread = await client.ok("logbutler_notification_count", { already_read: false });
      const read = await client.ok("logbutler_notification_count", { already_read: true });
      expect(unread.count + read.count).toBe(c.count);
      await client.ok("logbutler_notification_count", { resource_already_read: false });
      const list = await client.ok("logbutler_notification_list", { count: 5, order: "asc" });
      expect(list.length).toBeLessThanOrEqual(5);
      for (const n of list) expect(n).toHaveProperty("id");
      const bad = await client.call("logbutler_notification_list", { order: "sideways" });
      expect(errorOf(bad)?.code).toBe("argument_error");
    });

    it("logbutler_star_add: 対象の指定が 0 個・複数なら argument_error", async () => {
      const { client } = world();
      expect(errorOf(await client.call("logbutler_star_add", {}))?.code).toBe("argument_error");
      expect(
        errorOf(await client.call("logbutler_star_add", { issue_id: 1, comment_id: 2 }))?.code,
      ).toBe("argument_error");
    });
  });
}
