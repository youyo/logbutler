/** 課題の作成・更新・コメント・関連・添付と、読み戻し。スイート自身が作った課題に対してだけ書き込む。 */
import { describe, expect, it } from "vitest";
import { created, need, pollFor, todayTokyo, ymd } from "../helpers/issues";
import { errorOf, MARK } from "../helpers/live";
import { world } from "../helpers/world";

const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
const idemKey = (label: string) => `live-${MARK}-${label}`;

/** 本文の見分けやすい 1 行。 */
const summaryOf = (label: string) => `${MARK} ${label}`;

export function issueSuite(): void {
  describe("課題: 作成・更新・読み戻し", () => {
    it("logbutler_issue_create: 必須項目 + priority_id を明示して作成でき、issue_get に反映される", async () => {
      const { client, config, issueTypeId, priorityIds, meId } = world();
      const priorityId = priorityIds[0] as number;
      const issue = await client.ok("logbutler_issue_create", {
        project_key: config.projectKey,
        summary: summaryOf("main"),
        issue_type_id: issueTypeId,
        priority_id: priorityId,
        description: "live E2E の主課題\n2 行目 日本語",
        assignee_id: meId,
        due_date: ymd(3),
        start_date: ymd(0),
      });
      expect(issue.issueKey).toMatch(KEY_RE);
      expect(issue.issueKey.startsWith(`${config.projectKey}-`)).toBe(true);
      expect(issue.summary).toBe(summaryOf("main"));
      created.main = { id: issue.id, key: issue.issueKey, summary: issue.summary };
      created.log.push(issue.issueKey);

      const got = await client.ok("logbutler_issue_get", { issue_key: issue.issueKey });
      expect(got).toMatchObject({
        id: issue.id,
        issueKey: issue.issueKey,
        summary: summaryOf("main"),
      });
      expect(got.description).toBe("live E2E の主課題\n2 行目 日本語");
      expect(got.priority.id).toBe(priorityId);
      expect(got.assignee.id).toBe(meId);
      expect(got.issueType.id).toBe(issueTypeId);
      expect(got.projectId).toBe(world().projectId);
      expect(got.dueDate?.slice(0, 10)).toBe(ymd(3));
      expect(got.startDate?.slice(0, 10)).toBe(ymd(0));
      // 生データなので camelCase
      for (const k of ["issueKey", "keyId", "createdUser", "updatedUser", "issueType"]) {
        expect(got).toHaveProperty(k);
      }
    });

    it("logbutler_issue_create: priority_id を省略しても作成でき、優先度は既知の値になる(Backlog は priorityId 必須)", async () => {
      // 根拠: https://developer.nulab.com/docs/backlog/api/2/add-issue/ (priorityId は必須)。
      // Logbutler が GET /priorities から既定値を解決する修正が未デプロイの間は、ここが失敗するのが正しい。
      const { client, config, issueTypeId, priorityIds } = world();
      const r = await client.call("logbutler_issue_create", {
        project_key: config.projectKey,
        summary: summaryOf("priority 省略"),
        issue_type_id: issueTypeId,
      });
      expect(r.isError, r.text.slice(0, 300)).toBe(false);
      created.log.push(r.data.issueKey);
      const got = await client.ok("logbutler_issue_get", { issue_key: r.data.issueKey });
      expect(priorityIds).toContain(got.priority.id);
      expect(typeof got.priority.name).toBe("string");
    });

    it("logbutler_issue_create: 冪等キー付きの 2 回目は同じ結果で、課題は 1 件しかできない", async () => {
      const { client, config, issueTypeId, priorityIds } = world();
      const args = {
        project_key: config.projectKey,
        summary: summaryOf("idempotent create"),
        issue_type_id: issueTypeId,
        priority_id: priorityIds[0],
        idempotency_key: idemKey("create"),
      };
      const first = await client.call("logbutler_issue_create", args);
      const second = await client.call("logbutler_issue_create", args);
      expect(first.isError, first.text).toBe(false);
      expect(second.text).toBe(first.text);
      created.log.push(first.data.issueKey);
      const list = await client.ok("logbutler_issue_list", {
        project_key: config.projectKey,
        sort: "created",
        order: "desc",
        count: 100,
        max_response_tokens: 0,
      });
      const same = list.filter(
        (i: { summary: string }) => i.summary === summaryOf("idempotent create"),
      );
      expect(same).toHaveLength(1);
      // 別のキーなら別の課題として作られる
      const third = await client.call("logbutler_issue_create", {
        ...args,
        idempotency_key: idemKey("create-2"),
      });
      expect(third.isError, third.text).toBe(false);
      expect(third.data.issueKey).not.toBe(first.data.issueKey);
      created.log.push(third.data.issueKey);
    });

    it("logbutler_issue_create: params._meta.idempotency_key でも冪等になる", async () => {
      const { client, config, issueTypeId, priorityIds } = world();
      const args = {
        project_key: config.projectKey,
        summary: summaryOf("idempotent meta"),
        issue_type_id: issueTypeId,
        priority_id: priorityIds[0],
      };
      const meta = { idempotency_key: idemKey("meta") };
      const a = await client.call("logbutler_issue_create", args, { meta });
      const b = await client.call("logbutler_issue_create", args, { meta });
      expect(a.isError, a.text).toBe(false);
      expect(b.text).toBe(a.text);
      created.log.push(a.data.issueKey);
    });

    it("logbutler_issue_create: 関連課題・子課題・期限切れ課題の元になる課題を作る", async () => {
      const { client, config, issueTypeId, priorityIds } = world();
      const main = need(created.main, "main");
      const mk = async (label: string, extra: Record<string, unknown> = {}) => {
        const i = await client.ok("logbutler_issue_create", {
          project_key: config.projectKey,
          summary: summaryOf(label),
          issue_type_id: issueTypeId,
          priority_id: priorityIds[0],
          ...extra,
        });
        created.log.push(i.issueKey);
        return {
          id: i.id as number,
          key: i.issueKey as string,
          summary: i.summary as string,
          raw: i,
        };
      };
      const related = await mk("related");
      created.related = related;
      const child = await mk("child", { parent_issue_id: main.id });
      created.child = child;
      expect(child.raw.parentIssueId).toBe(main.id);
      const overdue = await mk("overdue", { due_date: "2020-01-01", start_date: "2019-12-01" });
      created.overdue = overdue;
      const got = await client.ok("logbutler_issue_get", { issue_key: child.key });
      expect(got.parentIssueId).toBe(main.id);
      // parent_issue_ids で絞り込める
      const children = await client.ok("logbutler_issue_list", {
        project_key: config.projectKey,
        parent_issue_ids: String(main.id),
      });
      expect(children.map((i: { issueKey: string }) => i.issueKey)).toEqual([child.key]);
    });

    it("logbutler_issue_create: 不正な引数は argument_error(Backlog を呼ぶ前)で、課題は増えない", async () => {
      const { client, config, issueTypeId } = world();
      const base = {
        project_key: config.projectKey,
        summary: summaryOf("invalid"),
        issue_type_id: issueTypeId,
      };
      for (const bad of [
        { due_date: "2026-02-30" },
        { start_date: "yesterday" },
        { category_ids: "a,b" },
        { issue_type_id: 0 },
        { summary: "" },
        { summary: 123 },
      ]) {
        const r = await client.call("logbutler_issue_create", { ...base, ...bad });
        expect(errorOf(r)?.code, JSON.stringify(bad)).toBe("argument_error");
      }
      const missing = await client.call("logbutler_issue_create", {
        project_key: "NOSUCHPROJ",
        summary: summaryOf("x"),
        issue_type_id: issueTypeId,
      });
      expect(errorOf(missing)?.code).toBe("not_found");
      const list = await client.ok("logbutler_issue_list", {
        project_key: config.projectKey,
        keyword: summaryOf("invalid"),
      });
      expect(
        list.filter((i: { summary: string }) => i.summary === summaryOf("invalid")),
      ).toHaveLength(0);
    });

    it("logbutler_issue_update: 変更した値が issue_get に出る(要約・説明・状態・優先度・期限・コメント)", async () => {
      const { client, midStatus, priorityIds } = world();
      const main = need(created.main, "main");
      const newPriority = priorityIds[priorityIds.length - 1] as number;
      const updated = await client.ok("logbutler_issue_update", {
        issue_key: main.key,
        summary: summaryOf("main (updated)"),
        description: "更新後の説明",
        status_id: midStatus.id,
        priority_id: newPriority,
        due_date: ymd(10),
        comment: "update と同時のコメント",
      });
      expect(updated.issueKey).toBe(main.key);
      const got = await client.ok("logbutler_issue_get", { issue_key: main.key });
      expect(got.summary).toBe(summaryOf("main (updated)"));
      expect(got.description).toBe("更新後の説明");
      expect(got.status.id).toBe(midStatus.id);
      expect(got.priority.id).toBe(newPriority);
      expect(got.dueDate?.slice(0, 10)).toBe(ymd(10));
      const comments = await client.ok("logbutler_issue_comment_list", { issue_key: main.key });
      expect(
        comments.some((c: { content: string }) => c.content === "update と同時のコメント"),
      ).toBe(true);
    });

    it("logbutler_issue_update: 同じ内容をもう一度送っても成功し、状態は変わらない(冪等)", async () => {
      const { client } = world();
      const main = need(created.main, "main");
      const args = { issue_key: main.key, description: "冪等な更新" };
      expect((await client.call("logbutler_issue_update", args)).isError).toBe(false);
      expect((await client.call("logbutler_issue_update", args)).isError).toBe(false);
      const got = await client.ok("logbutler_issue_get", { issue_key: main.key });
      expect(got.description).toBe("冪等な更新");
    });

    it("logbutler_issue_update: 親の解除(parent_issue_id=0)・親の設定ができる", async () => {
      const { client } = world();
      const main = need(created.main, "main");
      const child = need(created.child, "child");
      await client.ok("logbutler_issue_update", { issue_key: child.key, parent_issue_id: 0 });
      expect(
        (await client.ok("logbutler_issue_get", { issue_key: child.key })).parentIssueId,
      ).toBeNull();
      await client.ok("logbutler_issue_update", { issue_key: child.key, parent_issue_id: main.id });
      expect((await client.ok("logbutler_issue_get", { issue_key: child.key })).parentIssueId).toBe(
        main.id,
      );
    });

    it("logbutler_issue_update: 担当者の変更と、issue_type_id の変更", async () => {
      const { client, config, meId } = world();
      const related = need(created.related, "related");
      const types = await client.ok("logbutler_meta_issue_types", {
        project_key: config.projectKey,
      });
      const other = types[types.length - 1].id;
      await client.ok("logbutler_issue_update", {
        issue_key: related.key,
        assignee_id: meId,
        issue_type_id: other,
      });
      const got = await client.ok("logbutler_issue_get", { issue_key: related.key });
      expect(got.assignee.id).toBe(meId);
      expect(got.issueType.id).toBe(other);
    });

    it("logbutler_issue_update: 更新する項目がなければ argument_error、存在しない課題は not_found", async () => {
      const { client, config } = world();
      const main = need(created.main, "main");
      expect(
        errorOf(await client.call("logbutler_issue_update", { issue_key: main.key }))?.code,
      ).toBe("argument_error");
      expect(
        errorOf(
          await client.call("logbutler_issue_update", {
            issue_key: `${config.projectKey}-999999`,
            summary: "x",
          }),
        )?.code,
      ).toBe("not_found");
      expect(
        errorOf(
          await client.call("logbutler_issue_update", { issue_key: main.key, due_date: "bad" }),
        )?.code,
      ).toBe("argument_error");
    });

    it("logbutler_issue_get: 存在しない課題は not_found、課題 ID(数値)でも引ける", async () => {
      const { client, config } = world();
      const main = need(created.main, "main");
      const r = await client.call("logbutler_issue_get", {
        issue_key: `${config.projectKey}-999999`,
      });
      expect(errorOf(r)?.code).toBe("not_found");
      expect(errorOf(r)?.retryable).toBe(false);
      const byId = await client.ok("logbutler_issue_get", { issue_key: String(main.id) });
      expect(byId.issueKey).toBe(main.key);
      expect(errorOf(await client.call("logbutler_issue_get", {}))?.code).toBe("argument_error");
      expect(errorOf(await client.call("logbutler_issue_get", { issue_key: "  " }))?.code).toBe(
        "argument_error",
      );
    });

    it("logbutler_issue_list: 絞り込み(keyword/status/assignee/due/count/offset/sort)が実 Backlog の結果と一致する", async () => {
      const { client, config, meId, midStatus } = world();
      const main = need(created.main, "main");
      const overdue = need(created.overdue, "overdue");
      const base = { project_key: config.projectKey };
      // キーワード検索は結果整合(インデックス反映待ち)なので、現れるまで再取得する。
      const byKeyword = await pollFor(
        () =>
          // 過去の実行の課題も "updated" に一致するので、件数を広げ応答サイズの安全網を外す
          client.ok("logbutler_issue_list", {
            ...base,
            keyword: "updated",
            count: 100,
            max_response_tokens: 0,
          }),
        (r) => r.some((i: { issueKey: string }) => i.issueKey === main.key),
      );
      expect(byKeyword.map((i: { issueKey: string }) => i.issueKey)).toContain(main.key);
      const byStatus = await client.ok("logbutler_issue_list", {
        ...base,
        status_id: String(midStatus.id),
        count: 100,
        max_response_tokens: 0,
      });
      for (const i of byStatus) expect(i.status.id).toBe(midStatus.id);
      expect(byStatus.map((i: { issueKey: string }) => i.issueKey)).toContain(main.key);
      const mine = await client.ok("logbutler_issue_list", {
        ...base,
        assignee_id: "me",
        count: 100,
        max_response_tokens: 0,
      });
      for (const i of mine) expect(i.assignee.id).toBe(meId);
      const od = await client.ok("logbutler_issue_list", {
        ...base,
        due_date: "overdue",
        count: 100,
        max_response_tokens: 0,
      });
      expect(od.map((i: { issueKey: string }) => i.issueKey)).toContain(overdue.key);
      const today = todayTokyo();
      for (const i of od) expect(i.dueDate.slice(0, 10) < today).toBe(true);
      const range = await client.ok("logbutler_issue_list", {
        ...base,
        due_date: `${ymd(9)}:${ymd(11)}`,
        count: 100,
        max_response_tokens: 0,
      });
      expect(range.map((i: { issueKey: string }) => i.issueKey)).toContain(main.key);
      const two = await client.ok("logbutler_issue_list", {
        ...base,
        count: 2,
        sort: "created",
        order: "asc",
      });
      expect(two).toHaveLength(2);
      const next = await client.ok("logbutler_issue_list", {
        ...base,
        count: 2,
        offset: 2,
        sort: "created",
        order: "asc",
      });
      expect(next[0].id).toBeGreaterThan(two[1].id);
      const bounded = await client.call("logbutler_issue_list", { ...base, count: 101 });
      expect(errorOf(bounded)?.code).toBe("argument_error");
      const many = await client.ok("logbutler_issue_list", {
        project_keys: config.projectKey,
        timezone: "UTC",
        updated_since: ymd(-1),
      });
      expect(many.length).toBeGreaterThan(0);
      for (const bad of [
        { due_date: "someday" },
        { status_id: "x" },
        { assignee_id: "bob" },
        { updated_since: "2026/10/01" },
      ]) {
        expect(
          errorOf(await client.call("logbutler_issue_list", { ...base, ...bad }))?.code,
          JSON.stringify(bad),
        ).toBe("argument_error");
      }
    });

    it("logbutler_issue_list: status_id=not-closed は、完了集合に入る状態の課題を含まない", async () => {
      // 実環境の状態一覧(logbutler_meta_statuses)から期待を組み立てる。
      const { client, config, doneStatus, openStatus } = world();
      const main = need(created.main, "main");
      const related = need(created.related, "related");
      await client.ok("logbutler_issue_update", {
        issue_key: related.key,
        status_id: doneStatus.id,
      });
      const list = await client.ok("logbutler_issue_list", {
        project_key: config.projectKey,
        status_id: "not-closed",
        count: 100,
        max_response_tokens: 0,
      });
      const keys = list.map((i: { issueKey: string }) => i.issueKey);
      expect(keys).toContain(main.key);
      expect(keys).not.toContain(related.key);
      await client.ok("logbutler_issue_update", {
        issue_key: related.key,
        status_id: openStatus.id,
      });
    });
  });

  describe("課題: コメント・スター・関連課題", () => {
    it("logbutler_issue_comment_add: content と body(別名)で追加でき、comment_list に出る。count/offset が効く", async () => {
      const { client } = world();
      const main = need(created.main, "main");
      const c1 = await client.ok("logbutler_issue_comment_add", {
        issue_key: main.key,
        content: "コメント 1",
      });
      expect(c1).toMatchObject({ content: "コメント 1" });
      expect(typeof c1.id).toBe("number");
      const c2 = await client.ok("logbutler_issue_comment_add", {
        issue_key: main.key,
        body: "コメント 2 (body)",
      });
      expect(c2.content).toBe("コメント 2 (body)");
      created.commentIds.push(c1.id, c2.id);
      const all = await client.ok("logbutler_issue_comment_list", {
        issue_key: main.key,
        count: 100,
      });
      const ids = all.map((c: { id: number }) => c.id);
      expect(ids).toEqual(expect.arrayContaining([c1.id, c2.id]));
      expect(all.find((c: { id: number }) => c.id === c1.id).createdUser.id).toBe(world().meId);
      const one = await client.ok("logbutler_issue_comment_list", {
        issue_key: main.key,
        count: 1,
      });
      expect(one).toHaveLength(1);
      expect(
        errorOf(await client.call("logbutler_issue_comment_add", { issue_key: main.key }))?.code,
      ).toBe("argument_error");
      expect(
        errorOf(
          await client.call("logbutler_issue_comment_add", {
            issue_key: main.key,
            content: "x",
            notified_user_ids: "z",
          }),
        )?.code,
      ).toBe("argument_error");
      const nf = await client.call("logbutler_issue_comment_add", {
        issue_key: "NOSUCHPROJ-1",
        content: "x",
      });
      expect(errorOf(nf)?.code).toBe("not_found");
    });

    it("logbutler_issue_comment_list: offset を指定してもエラーにならず、次のコメントが返る", async () => {
      // 根拠: コメント一覧 API は minId/maxId/count/order で、offset を受け付けない(Backlog は error.unknownParameter)。
      // https://developer.nulab.com/docs/backlog/api/2/get-comment-list/
      const { client } = world();
      const main = need(created.main, "main");
      const one = await client.ok("logbutler_issue_comment_list", {
        issue_key: main.key,
        count: 1,
      });
      const off = await client.call("logbutler_issue_comment_list", {
        issue_key: main.key,
        count: 1,
        offset: 1,
      });
      expect(off.isError, off.text.slice(0, 300)).toBe(false);
      expect(off.data).toHaveLength(1);
      expect(off.data[0].id).not.toBe(one[0].id);
    });

    it("logbutler_issue_comment_add: 冪等キー(引数・_meta)の 2 回目は同じ結果で、コメントは 1 件", async () => {
      const { client } = world();
      const main = need(created.main, "main");
      const text = `冪等コメント ${MARK}`;
      const args = { issue_key: main.key, content: text, idempotency_key: idemKey("comment") };
      const a = await client.call("logbutler_issue_comment_add", args);
      const b = await client.call("logbutler_issue_comment_add", args);
      expect(a.isError, a.text).toBe(false);
      expect(b.text).toBe(a.text);
      const meta = { idempotency_key: idemKey("comment-meta") };
      const m1 = await client.call(
        "logbutler_issue_comment_add",
        { issue_key: main.key, content: `${text} meta` },
        { meta },
      );
      const m2 = await client.call(
        "logbutler_issue_comment_add",
        { issue_key: main.key, content: `${text} meta` },
        { meta },
      );
      expect(m2.text).toBe(m1.text);
      const all = await client.ok("logbutler_issue_comment_list", {
        issue_key: main.key,
        count: 100,
      });
      expect(all.filter((c: { content: string }) => c.content === text)).toHaveLength(1);
      expect(all.filter((c: { content: string }) => c.content === `${text} meta`)).toHaveLength(1);
      created.commentIds.push(a.data.id, m1.data.id);
    });

    it("logbutler_issue_comment_update: 内容が変わり comment_list に反映される。不正な指定は argument_error / not_found", async () => {
      const { client } = world();
      const main = need(created.main, "main");
      const id = need(created.commentIds[0], "comment id");
      const upd = await client.ok("logbutler_issue_comment_update", {
        issue_key: main.key,
        comment_id: id,
        content: "コメント 1 (編集)",
      });
      expect(upd.id).toBe(id);
      const all = await client.ok("logbutler_issue_comment_list", {
        issue_key: main.key,
        count: 100,
      });
      expect(all.find((c: { id: number }) => c.id === id).content).toBe("コメント 1 (編集)");
      expect(
        errorOf(
          await client.call("logbutler_issue_comment_update", {
            issue_key: main.key,
            comment_id: id,
          }),
        )?.code,
      ).toBe("argument_error");
      expect(
        errorOf(
          await client.call("logbutler_issue_comment_update", {
            issue_key: main.key,
            comment_id: 0,
            content: "x",
          }),
        )?.code,
      ).toBe("argument_error");
      expect(
        errorOf(
          await client.call("logbutler_issue_comment_update", {
            issue_key: main.key,
            comment_id: 999999999,
            content: "x",
          }),
        )?.code,
      ).toBe("not_found");
    });

    it("logbutler_star_add: コメントと課題にスターを付けられ、読み戻しに反映される", async () => {
      const { client } = world();
      const main = need(created.main, "main");
      const commentId = need(created.commentIds[0], "comment id");
      expect(await client.ok("logbutler_star_add", { comment_id: commentId })).toEqual({
        result: "ok",
      });
      const comments = await client.ok("logbutler_issue_comment_list", {
        issue_key: main.key,
        count: 100,
      });
      const starred = comments.find((c: { id: number }) => c.id === commentId);
      expect(starred.stars.length).toBe(1);
      expect(await client.ok("logbutler_star_add", { issue_id: main.id })).toEqual({
        result: "ok",
      });
      const got = await client.ok("logbutler_issue_get", { issue_key: main.key });
      expect(got.stars.length).toBe(1);
      // 存在しない対象
      expect(errorOf(await client.call("logbutler_star_add", { issue_id: 999999999 }))?.code).toBe(
        "not_found",
      );
    });

    it("logbutler_star_add: Backlog は呼ぶたびにスターを追加するので、注釈は idempotentHint=false", async () => {
      const { client } = world();
      const main = need(created.main, "main");
      const { tools } = (await client.listTools()).body.result as {
        tools: { name: string; annotations?: { idempotentHint?: boolean } }[];
      };
      const star = tools.find((t) => t.name === "logbutler_star_add");
      expect(star?.annotations?.idempotentHint, "注釈が実態(非冪等)と一致する").toBe(false);
      const before = await client.ok("logbutler_issue_get", { issue_key: main.key });
      const again = await client.call("logbutler_star_add", { issue_id: main.id });
      expect(again.isError, again.text).toBe(false);
      const after = await client.ok("logbutler_issue_get", { issue_key: main.key });
      expect(after.stars.length, "2 回目の star_add でスターが 1 つ増える").toBe(
        before.stars.length + 1,
      );
    });

    it("関連課題: related_add → related_list → related_delete → related_list(消える)", async () => {
      const { client } = world();
      const main = need(created.main, "main");
      const related = need(created.related, "related");
      const added = await client.call("logbutler_issue_related_add", {
        issue_key: main.key,
        target_issue_id: related.id,
      });
      expect(added.isError, added.text).toBe(false);
      const list = await client.ok("logbutler_issue_related_list", { issue_key: main.key });
      expect(list.map((i: { issueKey: string }) => i.issueKey)).toContain(related.key);
      // 逆側からも見える
      const rev = await client.ok("logbutler_issue_related_list", { issue_key: related.key });
      expect(rev.map((i: { issueKey: string }) => i.issueKey)).toContain(main.key);
      // 冪等: 同じ関連をもう一度追加しても重複しない
      await client.call("logbutler_issue_related_add", {
        issue_key: main.key,
        target_issue_id: related.id,
      });
      const dup = await client.ok("logbutler_issue_related_list", { issue_key: main.key });
      expect(dup.filter((i: { issueKey: string }) => i.issueKey === related.key)).toHaveLength(1);
      // related_list が返す課題の id で削除できる(ツールの説明は「related_list が返す ID」)
      const del = await client.call("logbutler_issue_related_delete", {
        issue_key: main.key,
        related_issue_id: related.id,
      });
      expect(del.isError, del.text).toBe(false);
      const after = await client.ok("logbutler_issue_related_list", { issue_key: main.key });
      expect(after.map((i: { issueKey: string }) => i.issueKey)).not.toContain(related.key);
      expect(
        errorOf(
          await client.call("logbutler_issue_related_add", {
            issue_key: main.key,
            target_issue_id: 0,
          }),
        )?.code,
      ).toBe("argument_error");
      expect(
        errorOf(
          await client.call("logbutler_issue_related_add", {
            issue_key: main.key,
            target_issue_id: 999999999,
          }),
        ),
      ).not.toBeNull();
    });
  });

  describe("課題: 添付", () => {
    const text = (s: string) => Buffer.from(s, "utf8").toString("base64");

    it("添付: upload → attachment_list → download(内容一致)→ delete → list(消える)", async () => {
      const { client } = world();
      const main = need(created.main, "main");
      const content = `live attachment ${MARK}\n日本語 ✓\n`;
      const up = await client.call("logbutler_issue_attachment_upload", {
        issue_key: main.key,
        file_name: "live-note.txt",
        file_content_base64: text(content),
        mime_type: "text/plain",
        idempotency_key: idemKey("attach"),
      });
      expect(up.isError, up.text).toBe(false);
      expect(up.data.issueKey).toBe(main.key);
      // 冪等: 同じキーの 2 回目は同じ結果で、添付は 1 件
      const up2 = await client.call("logbutler_issue_attachment_upload", {
        issue_key: main.key,
        file_name: "live-note.txt",
        file_content_base64: text(content),
        idempotency_key: idemKey("attach"),
      });
      expect(up2.text).toBe(up.text);
      const list = await client.ok("logbutler_issue_attachment_list", { issue_key: main.key });
      const mine = list.filter((a: { name: string }) => a.name === "live-note.txt");
      expect(mine).toHaveLength(1);
      expect(mine[0].size).toBe(Buffer.byteLength(content, "utf8"));
      const dl = await client.ok("logbutler_issue_attachment_download", {
        issue_key: main.key,
        attachment_id: mine[0].id,
      });
      expect(Buffer.from(dl.content_base64, "base64").toString("utf8")).toBe(content);
      expect(dl.filename).toBe("live-note.txt");
      expect(dl.size_bytes).toBe(Buffer.byteLength(content, "utf8"));
      expect(typeof dl.content_type).toBe("string");
      const del = await client.call("logbutler_issue_attachment_delete", {
        issue_key: main.key,
        attachment_id: mine[0].id,
      });
      expect(del.isError, del.text).toBe(false);
      expect(del.data.id).toBe(mine[0].id);
      const after = await client.ok("logbutler_issue_attachment_list", { issue_key: main.key });
      expect(after.filter((a: { id: number }) => a.id === mine[0].id)).toHaveLength(0);
      // 削除済みの添付は not_found
      expect(
        errorOf(
          await client.call("logbutler_issue_attachment_delete", {
            issue_key: main.key,
            attachment_id: mine[0].id,
          }),
        )?.code,
      ).toBe("not_found");
      expect(
        errorOf(
          await client.call("logbutler_issue_attachment_download", {
            issue_key: main.key,
            attachment_id: mine[0].id,
          }),
        )?.code,
      ).toBe("not_found");
    });

    it("添付: 全バイト値のバイナリと、空ファイルが往復できる。パス付きの名前はベース名になる", async () => {
      const { client } = world();
      const main = need(created.main, "main");
      const bin = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
      const up = await client.call("logbutler_issue_attachment_upload", {
        issue_key: main.key,
        file_name: "../nested/live-bin.bin",
        file_content_base64: bin.toString("base64"),
      });
      expect(up.isError, up.text).toBe(false);
      const list = await client.ok("logbutler_issue_attachment_list", { issue_key: main.key });
      const a = list.find((x: { name: string }) => x.name === "live-bin.bin");
      expect(a, `添付名: ${list.map((x: { name: string }) => x.name)}`).toBeDefined();
      const dl = await client.ok("logbutler_issue_attachment_download", {
        issue_key: main.key,
        attachment_id: a.id,
      });
      expect(Buffer.from(dl.content_base64, "base64").equals(bin)).toBe(true);
      await client.ok("logbutler_issue_attachment_delete", {
        issue_key: main.key,
        attachment_id: a.id,
      });
    });

    it("logbutler_issue_attachment_upload: 0 バイトのファイルは、成功するか argument_error(不透明な api_error にならない)", async () => {
      // 実 Backlog は空ファイルの添付を 400 "Internal error"(code=1) で拒否する。
      const { client } = world();
      const main = need(created.main, "main");
      const empty = await client.call("logbutler_issue_attachment_upload", {
        issue_key: main.key,
        file_name: "live-empty.txt",
        file_content_base64: "",
      });
      if (!empty.isError) {
        const list2 = await client.ok("logbutler_issue_attachment_list", { issue_key: main.key });
        const e = list2.find((x: { name: string }) => x.name === "live-empty.txt");
        expect(e?.size).toBe(0);
        await client.ok("logbutler_issue_attachment_delete", {
          issue_key: main.key,
          attachment_id: e.id,
        });
      } else {
        expect(errorOf(empty)?.code, empty.text.slice(0, 300)).toBe("argument_error");
      }
    });

    it("添付: 引数の誤り(必須欠落・不正な base64・4 MiB 超)は argument_error", async () => {
      const { client } = world();
      const main = need(created.main, "main");
      const up = (a: Record<string, unknown>) =>
        client.call("logbutler_issue_attachment_upload", { issue_key: main.key, ...a });
      expect(errorOf(await up({}))?.code).toBe("argument_error");
      expect(errorOf(await up({ file_content_base64: text("x") }))?.code).toBe("argument_error");
      expect(
        errorOf(await up({ file_name: "a.txt", file_content_base64: "!!!not base64!!!" }))?.code,
      ).toBe("argument_error");
      expect(errorOf(await up({ file_name: "..", file_content_base64: text("x") }))?.code).toBe(
        "argument_error",
      );
      const big = Buffer.alloc(4 * 1024 * 1024 + 1, 1).toString("base64");
      expect(errorOf(await up({ file_name: "big.bin", file_content_base64: big }))?.code).toBe(
        "argument_error",
      );
      const list = await client.ok("logbutler_issue_attachment_list", { issue_key: main.key });
      expect(list.filter((a: { name: string }) => a.name === "big.bin")).toHaveLength(0);
    });

    it("添付: 既存の 3.9 MiB の添付(LOGBUTLER-3)をダウンロードでき、サイズが一致する", async () => {
      const { client, config } = world();
      const key = `${config.projectKey}-3`;
      const list = await client.ok("logbutler_issue_attachment_list", { issue_key: key });
      const a = list.find((x: { size: number }) => x.size > 3_000_000);
      expect(a, `${key} に 3 MB 超の添付がある前提(V11 で用意済み)`).toBeDefined();
      const dl = await client.ok("logbutler_issue_attachment_download", {
        issue_key: key,
        attachment_id: a.id,
      });
      expect(dl.size_bytes).toBe(a.size);
      expect(Buffer.from(dl.content_base64, "base64").byteLength).toBe(a.size);
    });
  });
}
