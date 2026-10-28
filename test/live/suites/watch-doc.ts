/** ウォッチ・ドキュメントの書き込みと読み戻し。 */
import { describe, expect, it } from "vitest";
import { created, need, pollFor } from "../helpers/issues";
import { errorOf, MARK } from "../helpers/live";
import { world } from "../helpers/world";

const idemKey = (label: string) => `live-${MARK}-${label}`;

export function watchDocSuite(): void {
  describe("ウォッチ", () => {
    let watchingId = 0;
    let before = 0;

    it("logbutler_watching_count / watching_list: 追加前の件数を控える", async () => {
      const { client, meId } = world();
      const c = await client.ok("logbutler_watching_count", { user_id: meId });
      expect(Number.isInteger(c.count)).toBe(true);
      before = c.count;
      const list = await client.ok("logbutler_watching_list", { user_id: "me", count: 100 });
      expect(Array.isArray(list)).toBe(true);
      expect(list).toHaveLength(before);
    });

    it("logbutler_watching_add: 追加でき、get / list / count に反映される", async () => {
      const { client, meId } = world();
      const main = need(created.main, "main");
      const w = await client.ok("logbutler_watching_add", {
        issue_id_or_key: main.key,
        note: `live ${MARK}`,
      });
      expect(w.note).toBe(`live ${MARK}`);
      expect(w.issue.issueKey).toBe(main.key);
      watchingId = w.id;
      const got = await client.ok("logbutler_watching_get", { watching_id: watchingId });
      expect(got).toMatchObject({ id: watchingId, note: `live ${MARK}` });
      const list = await client.ok("logbutler_watching_list", {
        user_id: String(meId),
        count: 100,
      });
      expect(list.map((x: { id: number }) => x.id)).toContain(watchingId);
      expect((await client.ok("logbutler_watching_count", { user_id: meId })).count).toBe(
        before + 1,
      );
      for (const [order, sort] of [
        ["asc", "created"],
        ["desc", "updated"],
        ["desc", "issueUpdated"],
      ]) {
        const l = await client.ok("logbutler_watching_list", {
          user_id: "me",
          order,
          sort,
          count: 5,
        });
        expect(Array.isArray(l)).toBe(true);
      }
    });

    it("logbutler_watching_add: 同じ課題をもう一度ウォッチしても、ウォッチは増えない", async () => {
      const { client, meId } = world();
      const main = need(created.main, "main");
      const again = await client.call("logbutler_watching_add", { issue_id_or_key: main.key });
      if (again.isError) expect(errorOf(again), again.text).not.toBeNull();
      expect((await client.ok("logbutler_watching_count", { user_id: meId })).count).toBe(
        before + 1,
      );
    });

    it("logbutler_watching_update: note が変わり get に出る。空文字でも更新できる", async () => {
      const { client } = world();
      await client.ok("logbutler_watching_update", { watching_id: watchingId, note: "更新後" });
      expect((await client.ok("logbutler_watching_get", { watching_id: watchingId })).note).toBe(
        "更新後",
      );
      await client.ok("logbutler_watching_update", { watching_id: watchingId, note: "" });
      expect(
        (await client.ok("logbutler_watching_get", { watching_id: watchingId })).note ?? "",
      ).toBe("");
      expect(
        errorOf(await client.call("logbutler_watching_update", { watching_id: watchingId }))?.code,
      ).toBe("argument_error");
      expect(
        errorOf(await client.call("logbutler_watching_update", { watching_id: 0, note: "x" }))
          ?.code,
      ).toBe("argument_error");
    });

    it("logbutler_watching_mark_as_read: {result: ok} を返し、ウォッチは残る", async () => {
      const { client } = world();
      expect(
        await client.ok("logbutler_watching_mark_as_read", { watching_id: watchingId }),
      ).toEqual({ result: "ok" });
      const got = await client.ok("logbutler_watching_get", { watching_id: watchingId });
      expect(got.resourceAlreadyRead).toBe(true);
      expect(
        errorOf(await client.call("logbutler_watching_mark_as_read", { watching_id: 999999999 }))
          ?.code,
      ).toBe("not_found");
    });

    it("logbutler_watching_delete: 削除したウォッチを返し、get は not_found、count は元に戻る", async () => {
      const { client, meId } = world();
      const del = await client.ok("logbutler_watching_delete", { watching_id: watchingId });
      expect(del.id).toBe(watchingId);
      expect(
        errorOf(await client.call("logbutler_watching_get", { watching_id: watchingId }))?.code,
      ).toBe("not_found");
      expect((await client.ok("logbutler_watching_count", { user_id: meId })).count).toBe(before);
      expect(
        errorOf(await client.call("logbutler_watching_delete", { watching_id: watchingId }))?.code,
      ).toBe("not_found");
      expect(
        errorOf(await client.call("logbutler_watching_delete", { watching_id: 0 }))?.code,
      ).toBe("argument_error");
    });
  });

  describe("ドキュメント", () => {
    const docs: { id?: string; childId?: string } = {};
    const title = () => `${MARK} doc`;

    it("logbutler_document_create: 作成でき、冪等キー付きの 2 回目は同じ結果で 1 件だけ", async () => {
      const { client, projectId, config } = world();
      const args = {
        project_id: projectId,
        title: title(),
        content: "# live\n\n本文 **markdown**\n",
        idempotency_key: idemKey("doc"),
      };
      const a = await client.call("logbutler_document_create", args);
      expect(a.isError, a.text).toBe(false);
      const b = await client.call("logbutler_document_create", args);
      expect(b.text).toBe(a.text);
      docs.id = String(a.data.id);
      created.log.push(`document ${docs.id}`);
      const list = await client.ok("logbutler_document_list", {
        project_key: config.projectKey,
        count: 100,
      });
      expect(list.filter((d: { title: string }) => d.title === title())).toHaveLength(1);
    });

    it("logbutler_document_get: 作成した内容が読み戻せる", async () => {
      const { client, projectId } = world();
      const d = await client.ok("logbutler_document_get", {
        document_id: need(docs.id, "document id"),
      });
      expect(String(d.id)).toBe(docs.id);
      expect(d.title).toBe(title());
      expect(d.projectId).toBe(projectId);
      expect(JSON.stringify(d)).toContain("本文");
      expect(
        errorOf(
          await client.call("logbutler_document_get", {
            document_id: "00000000000000000000000000000000",
          }),
        )?.code,
      ).toBe("not_found");
    });

    it("logbutler_document_create (parent_id): 子ドキュメントを作ると document_tree に親子で出る", async () => {
      const { client, projectId, config } = world();
      const child = await client.call("logbutler_document_create", {
        project_id: projectId,
        title: `${MARK} doc child`,
        content: "子",
        parent_id: need(docs.id, "document id"),
      });
      expect(child.isError, child.text).toBe(false);
      docs.childId = String(child.data.id);
      created.log.push(`document ${docs.childId}`);
      const tree = await client.ok("logbutler_document_tree", { project_key: config.projectKey });
      const flat = JSON.stringify(tree);
      expect(flat).toContain(docs.id);
      expect(flat).toContain(docs.childId);
      const list = await client.ok("logbutler_document_list", {
        project_key: config.projectKey,
        count: 1,
        offset: 0,
      });
      expect(list).toHaveLength(1);
      const off = await client.ok("logbutler_document_list", {
        project_key: config.projectKey,
        count: 1,
        offset: 1,
      });
      expect(off.length).toBeLessThanOrEqual(1);
      if (off[0]) expect(off[0].id).not.toBe(list[0].id);
    });

    it("logbutler_document_create: 必須欠落・project_id=0 は argument_error", async () => {
      const { client, projectId } = world();
      expect(
        errorOf(
          await client.call("logbutler_document_create", { project_id: projectId, title: "x" }),
        )?.code,
      ).toBe("argument_error");
      expect(
        errorOf(
          await client.call("logbutler_document_create", {
            project_id: 0,
            title: "x",
            content: "y",
          }),
        )?.code,
      ).toBe("argument_error");
    });

    it("logbutler_document_digest: 作成したドキュメントのダイジェスト(digest エンベロープ)", async () => {
      const { client } = world();
      const r = await client.ok("logbutler_document_digest", {
        document_id: need(docs.id, "document id"),
      });
      expect(r).toMatchObject({
        schema_version: "1",
        resource: expect.any(String),
        warnings: expect.any(Array),
      });
      expect(r.digest).toBeDefined();
      expect(JSON.stringify(r.digest)).toContain(title());
      expect(
        errorOf(
          await client.call("logbutler_document_digest", {
            document_id: "00000000000000000000000000000000",
          }),
        )?.code,
      ).toBe("not_found");
    });

    it("logbutler_document_search: タイトルのキーワードで見つかる(反映待ちは数回まで再試行)", async () => {
      const { client, config } = world();
      // キーワード検索は結果整合なので、現れるまで再取得する。トークン化の都合で、記号を含む題名全体ではなく "doc" で探す。
      const r = await pollFor(
        () =>
          client.ok("logbutler_document_search", {
            keyword: "doc",
            project_keys: config.projectKey,
            detail: "meta",
          }),
        (x) => JSON.stringify(x.digest.items).includes(String(docs.id)),
      );
      const found = JSON.stringify(r.digest.items).includes(String(docs.id));
      expect(r.digest.keyword).toBe("doc");
      expect(found, "作成したドキュメントが検索に出る").toBe(true);
      for (const detail of ["snippet", "full"]) {
        const x = await client.ok("logbutler_document_search", {
          keyword: title(),
          detail,
          count: 5,
          sort: "created",
          order: "desc",
        });
        expect(Array.isArray(x.digest.items)).toBe(true);
      }
      expect(
        errorOf(await client.call("logbutler_document_search", { keyword: "x", detail: "bogus" }))
          ?.code,
      ).toBe("argument_error");
      expect(
        errorOf(await client.call("logbutler_document_search", { keyword: "x", count: 101 }))?.code,
      ).toBe("argument_error");
    });
  });
}
