/** 分析・digest 系(加工出力。snake_case + schema_version/エンベロープ)。作成した課題を材料にして中身まで確かめる。 */
import { afterAll, describe, expect, it } from "vitest";
import { created, need, pollFor, todayTokyo, ymd } from "../helpers/issues";
import { errorOf, MARK, NAME_MARK } from "../helpers/live";
import { cleanupSettings, listMeta, registry, substituteStatusId } from "../helpers/settings";
import { DONE_NAMES, world } from "../helpers/world";

// biome-ignore lint/suspicious/noExplicitAny: 応答の形をテストごとに検証する
type Any = any;

function expectEnvelope(r: Any, resource: string, bodyKey: "analysis" | "digest") {
  expect(r.schema_version).toBe("1");
  expect(r.resource).toBe(resource);
  expect(new Date(r.generated_at).toString()).not.toBe("Invalid Date");
  const { spaceKey } = world();
  expect(r.space).toBe(spaceKey);
  // ホストはスペースごとに backlog.com / backlog.jp などがあるので、スペースキーで始まることだけを確かめる
  expect(r.base_url).toMatch(new RegExp(`^https://${spaceKey}\\.[^/]+$`));
  expect(Array.isArray(r.warnings)).toBe(true);
  for (const w of r.warnings) {
    expect(typeof w.code).toBe("string");
    expect(typeof w.message).toBe("string");
    expect(typeof w.retryable).toBe("boolean");
  }
  expect(r[bodyKey]).toBeDefined();
  expect(r[bodyKey === "analysis" ? "digest" : "analysis"]).toBeUndefined();
}

export function analysisSuite(): void {
  describe("分析系", () => {
    // カスタム状態のテストが途中で失敗しても、作った状態を残さない
    afterAll(async () => {
      expect(await cleanupSettings()).toEqual([]);
    }, 60_000);

    it("logbutler_issue_context: 課題・シグナル・コメントが入る。compact でコメント本文と説明を省く", async () => {
      const { client } = world();
      const main = need(created.main, "main");
      const r = await client.ok("logbutler_issue_context", { issue_key: main.key });
      expectEnvelope(r, "issue_context", "analysis");
      expect(r.analysis.issue.issue_key ?? r.analysis.issue.issueKey).toBe(main.key);
      expect(r.analysis.recent_comments.length).toBeGreaterThan(0);
      expect(r.analysis.llm_hints).toHaveProperty("suggested_next_actions");
      const compact = await client.ok("logbutler_issue_context", {
        issue_key: main.key,
        compact: true,
        comments: 1,
        include_related_issues: false,
      });
      expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(r).length);
      expect(compact.analysis.recent_comments.length).toBeLessThanOrEqual(1);
      const nf = await client.call("logbutler_issue_context", {
        issue_key: `${world().config.projectKey}-999999`,
      });
      expect(errorOf(nf)?.code).toBe("not_found");
    });

    it("logbutler_issue_triage_materials: 統計・類似課題・履歴", async () => {
      const { client } = world();
      const main = need(created.main, "main");
      const r = await client.ok("logbutler_issue_triage_materials", { issue_key: main.key });
      expectEnvelope(r, "issue_triage_materials", "analysis");
      for (const k of ["issue", "history", "project_stats", "similar_issues", "truncated"])
        expect(r.analysis).toHaveProperty(k);
      const x = await client.ok("logbutler_issue_triage_materials", {
        issue_key: main.key,
        include_related_issues: false,
      });
      expect(x.analysis.related_issues).toHaveLength(0);
      expect(
        errorOf(
          await client.call("logbutler_issue_triage_materials", {
            issue_key: `${world().config.projectKey}-999999`,
          }),
        )?.code,
      ).toBe("not_found");
    });

    it("logbutler_issue_timeline: 作成したコメントが時系列に出る。max_comments・include_updates・期間が効く", async () => {
      const { client } = world();
      const main = need(created.main, "main");
      const r = await client.ok("logbutler_issue_timeline", {
        issue_key: main.key,
        timezone: "Asia/Tokyo",
      });
      expectEnvelope(r, "issue_timeline", "analysis");
      expect(r.analysis.issue_key).toBe(main.key);
      const events = r.analysis.events as Any[];
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).toContain("コメント 2 (body)");
      const stamps = events.map((e) => e.timestamp).filter(Boolean) as string[];
      expect([...stamps].sort()).toEqual(stamps);
      const one = await client.ok("logbutler_issue_timeline", {
        issue_key: main.key,
        max_comments: 1,
        include_updates: false,
      });
      const comments = (one.analysis.events as Any[]).filter((e) => e.kind === "comment");
      expect(comments.length).toBeLessThanOrEqual(1);
      expect((one.analysis.events as Any[]).every((e) => e.kind === "comment")).toBe(true);
      const future = await client.ok("logbutler_issue_timeline", {
        issue_key: main.key,
        since: ymd(30),
      });
      expect(future.analysis.events).toHaveLength(0);
      const today = await client.ok("logbutler_issue_timeline", {
        issue_key: main.key,
        since: todayTokyo(),
        until: todayTokyo(),
      });
      expect((today.analysis.events as Any[]).length).toBeGreaterThan(0); // until は当日を含む
      expect(
        errorOf(await client.call("logbutler_issue_timeline", { issue_key: main.key, since: "x" }))
          ?.code,
      ).toBe("argument_error");
      expect(
        errorOf(
          await client.call("logbutler_issue_timeline", {
            issue_key: main.key,
            since: ymd(2),
            until: ymd(1),
          }),
        )?.code,
      ).toBe("argument_error");
    });

    it("logbutler_project_blockers / issue_stale: 期限切れの課題が出て、完了にすると消える(完了集合は取得した状態一覧から選ぶ)", async () => {
      const { client, config, doneStatus, openStatus } = world();
      const overdue = need(created.overdue, "overdue");
      const keys = (r: Any) => (r.analysis.issues as Any[]).map((i) => i.issue_key);
      const b = await client.ok("logbutler_project_blockers", { project_keys: config.projectKey });
      expectEnvelope(b, "project_blockers", "analysis");
      expect(keys(b)).toContain(overdue.key);
      const item = (b.analysis.issues as Any[]).find((i) => i.issue_key === overdue.key);
      expect(item.signals.map((s: Any) => s.code)).toContain("overdue_open");
      expect(b.analysis.total_count).toBe(b.analysis.issues.length);
      expect(Object.keys(b.analysis.by_severity).length).toBeGreaterThan(0);
      const s = await client.ok("logbutler_issue_stale", {
        project_keys: config.projectKey,
        days: 1,
      });
      expectEnvelope(s, "stale_issues", "analysis");
      expect(s.analysis.threshold_days).toBe(1);
      expect(s.analysis.total_count).toBe(s.analysis.issues.length);
      // 作ったばかりの課題は停滞していない
      expect(keys(s)).not.toContain(overdue.key);

      await client.ok("logbutler_issue_update", {
        issue_key: overdue.key,
        status_id: doneStatus.id,
      });
      const b2 = await client.ok("logbutler_project_blockers", { project_keys: config.projectKey });
      expect(keys(b2)).not.toContain(overdue.key);
      // exclude_status で完了集合を上書きすると、完了の課題も対象になる
      const b3 = await client.ok("logbutler_project_blockers", {
        project_keys: config.projectKey,
        exclude_status: openStatus.name,
        include_comments: true,
        days: 1,
      });
      expect(keys(b3)).toContain(overdue.key);
      await client.ok("logbutler_issue_update", {
        issue_key: overdue.key,
        status_id: openStatus.id,
      });
      expect(
        errorOf(await client.call("logbutler_project_blockers", { project_keys: "" }))?.code,
      ).toBe("argument_error");
      const nf = await client.call("logbutler_issue_stale", { project_keys: "NOSUCHPROJ" });
      // 存在しないプロジェクトは warning か not_found のどちらか(生の例外にならない)
      if (nf.isError) expect(errorOf(nf)?.code).toBe("not_found");
      else expect(nf.data.warnings.length).toBeGreaterThan(0);
    });

    it("logbutler_project_health: スコアとレベル、サマリが整合する", async () => {
      const { client, config } = world();
      const r = await client.ok("logbutler_project_health", {
        project_key: config.projectKey,
        days: 7,
        include_comments: true,
      });
      expectEnvelope(r, "project_health", "analysis");
      expect(r.analysis.project_key).toBe(config.projectKey);
      expect(r.analysis.health_score).toBeGreaterThanOrEqual(0);
      expect(r.analysis.health_score).toBeLessThanOrEqual(100);
      expect(typeof r.analysis.health_level).toBe("string");
      expect(r.analysis.stale_summary.threshold_days).toBe(7);
    });

    it("logbutler_user_workload: 自分の担当件数が issue_list と一致する(完了を除く)", async () => {
      const { client, config, meId } = world();
      const r = await client.ok("logbutler_user_workload", { project_key: config.projectKey });
      expectEnvelope(r, "user_workload", "analysis");
      const me = (r.analysis.members as Any[]).find((m) => m.user_id === meId);
      const open = await client.ok("logbutler_issue_list", {
        project_key: config.projectKey,
        assignee_id: "me",
        count: 100,
        max_response_tokens: 0,
      });
      const { doneStatus } = world();
      const mineOpen = (open as Any[]).filter((i) => i.status.id !== doneStatus.id);
      expect(me?.total).toBe(mineOpen.length);
      expect(r.analysis.total_issues).toBeGreaterThanOrEqual(mineOpen.length);
      expect(r.analysis.unassigned_count).toBeGreaterThan(0);
    });

    it("logbutler_my_tasks: 期限内の担当課題が upcoming に、期限切れが overdue に出る。mode と timezone", async () => {
      const { client, config, meId, doneStatus } = world();
      const main = need(created.main, "main");
      // main の期限を今日にして、今週の範囲に確実に入れる
      await client.ok("logbutler_issue_update", {
        issue_key: main.key,
        due_date: todayTokyo(),
        assignee_id: meId,
      });
      const r = await client.ok("logbutler_my_tasks", { timezone: "Asia/Tokyo" });
      expectEnvelope(r, "my_tasks", "analysis");
      expect(r.analysis.mode).toBe("week");
      const all = [...r.analysis.overdue, ...r.analysis.upcoming].map((i: Any) => i.issue_key);
      expect(all).toContain(main.key);
      const next = await client.ok("logbutler_my_tasks", {
        mode: "next",
        stale_days: 1,
        timezone: "UTC",
      });
      expect(next.analysis.mode).toBe("next");
      expect(errorOf(await client.call("logbutler_my_tasks", { mode: "month" }))?.code).toBe(
        "argument_error",
      );
      expect(
        errorOf(await client.call("logbutler_my_tasks", { timezone: "Mars/Olympus" }))?.code,
      ).toBe("argument_error");
      // 完了にした課題は overdue から外れる(期限切れ課題を完了にして確かめる)
      const overdue = need(created.overdue, "overdue");
      await client.ok("logbutler_issue_update", { issue_key: overdue.key, assignee_id: meId });
      const withOverdue = await client.ok("logbutler_my_tasks", {});
      expect(withOverdue.analysis.overdue.map((i: Any) => i.issue_key)).toContain(overdue.key);
      await client.ok("logbutler_issue_update", {
        issue_key: overdue.key,
        status_id: doneStatus.id,
      });
      const without = await client.ok("logbutler_my_tasks", {});
      expect(without.analysis.overdue.map((i: Any) => i.issue_key)).not.toContain(overdue.key);
      expect(config.projectKey).toBeTruthy();
    });

    it("カスタムステータス(完了集合外)の課題が my_tasks と issue_list(not-closed)に出る(ADR 0012)", async () => {
      const { client, config, meId, issueTypeId, priorityIds } = world();
      // 既存の状態の ID・順序・名前には依存しない。スイート自身が status_add でカスタム状態を作り、最後に消す。
      // 名前は完了集合(完了 / 対応済み / Closed / Done / Resolved)に入らないものにする。
      const custom = await client.ok("logbutler_status_add", {
        project_key: config.projectKey,
        name: `${NAME_MARK} レビュー待ち`,
        color: "#eda62a",
      });
      registry.status.add(custom.id);
      expect(DONE_NAMES).not.toContain(custom.name);
      try {
        const issue = await client.ok("logbutler_issue_create", {
          project_key: config.projectKey,
          summary: `${MARK} custom status`,
          issue_type_id: issueTypeId,
          priority_id: priorityIds[0] as number,
          assignee_id: meId,
          due_date: todayTokyo(),
        });
        created.log.push(issue.issueKey);
        await client.ok("logbutler_issue_update", {
          issue_key: issue.issueKey,
          status_id: custom.id,
        });

        const mine = await client.ok("logbutler_my_tasks", { timezone: "Asia/Tokyo" });
        const keys = [...mine.analysis.overdue, ...mine.analysis.upcoming].map(
          (i: Any) => i.issue_key,
        );
        expect(keys, `my_tasks に ${custom.name}(${custom.id}) の課題が出ない`).toContain(
          issue.issueKey,
        );

        const list = await client.ok("logbutler_issue_list", {
          project_key: config.projectKey,
          status_id: "not-closed",
          count: 100,
          max_response_tokens: 0,
        });
        expect(
          list.map((i: Any) => i.issueKey),
          `issue_list(not-closed) に ${custom.name}(${custom.id}) の課題が出ない`,
        ).toContain(issue.issueKey);
        // プロジェクト指定なしでも同じ
        const all = await client.ok("logbutler_issue_list", {
          status_id: "not-closed",
          assignee_id: "me",
          count: 100,
          max_response_tokens: 0,
        });
        expect(all.map((i: Any) => i.issueKey)).toContain(issue.issueKey);
      } finally {
        // 課題は代替の状態(meta_statuses の完了集合以外の既存状態)へ移して、作った状態を消す。
        const substitute = await substituteStatusId(client, config.projectKey, [custom.id]);
        await client.ok("logbutler_status_delete", {
          project_key: config.projectKey,
          status_id: custom.id,
          substitute_status_id: substitute,
        });
        registry.status.delete(custom.id);
      }
      const statuses = await listMeta(client, "status", config.projectKey);
      expect(statuses.map((s) => s.id)).not.toContain(custom.id);
    });

    it("logbutler_digest_weekly / digest_daily: 完了にした課題が completed に出る。timezone・期間の指定が反映される", async () => {
      const { client, config, doneStatus } = world();
      const related = need(created.related, "related");
      await client.ok("logbutler_issue_update", {
        issue_key: related.key,
        status_id: doneStatus.id,
      });
      const today = todayTokyo();
      for (const [tool, resource] of [
        ["logbutler_digest_weekly", "periodic_digest"],
        ["logbutler_digest_daily", "periodic_digest"],
      ] as const) {
        const r = await client.ok(tool, {
          project_key: config.projectKey,
          since: ymd(-1),
          until: today,
          timezone: "Asia/Tokyo",
        });
        expectEnvelope(r, resource, "analysis");
        expect(r.analysis.project_key).toBe(config.projectKey);
        const completed = (r.analysis.completed as Any[]).map((i) => i.issue_key);
        expect(completed, `${tool} の completed`).toContain(related.key);
        const none = await client.ok(tool, { project_key: config.projectKey });
        expectEnvelope(none, resource, "analysis");
        expect(new Date(none.analysis.since).toString()).not.toBe("Invalid Date");
        expect(
          errorOf(
            await client.call(tool, {
              project_key: config.projectKey,
              since: ymd(1),
              until: ymd(-1),
            }),
          )?.code,
        ).toBe("argument_error");
        expect(
          errorOf(
            await client.call(tool, { project_key: config.projectKey, timezone: "Nowhere/Land" }),
          )?.code,
        ).toBe("argument_error");
      }
      await client.ok("logbutler_issue_update", {
        issue_key: related.key,
        status_id: world().openStatus.id,
      });
    });

    it("logbutler_activity_stats: scope=space/project/user と期間・top_n・timezone", async () => {
      const { client, config, meId } = world();
      const space = await client.ok("logbutler_activity_stats", {
        since: ymd(-3),
        until: todayTokyo(),
        timezone: "Asia/Tokyo",
      });
      expectEnvelope(space, "activity_stats", "analysis");
      expect(space.analysis.scope).toContain("space");
      expect(space.analysis.total_count).toBeGreaterThan(0);
      const sumTypes = Object.values(space.analysis.by_type as Record<string, number>).reduce(
        (a, b) => a + b,
        0,
      );
      expect(sumTypes).toBe(space.analysis.total_count);
      const proj = await client.ok("logbutler_activity_stats", {
        scope: "project",
        project_key: config.projectKey,
        top_n: 1,
      });
      expect(proj.analysis.top_active_actors.length).toBeLessThanOrEqual(1);
      const user = await client.ok("logbutler_activity_stats", {
        scope: "user",
        user_id: String(meId),
        timezone: "UTC",
      });
      expect(user.analysis.scope).toContain("user");
      expect(
        errorOf(await client.call("logbutler_activity_stats", { scope: "project" }))?.code,
      ).toBe("argument_error");
      expect(errorOf(await client.call("logbutler_activity_stats", { scope: "user" }))?.code).toBe(
        "argument_error",
      );
      expect(
        errorOf(await client.call("logbutler_activity_stats", { scope: "galaxy" }))?.code,
      ).toBe("argument_error");
      expect(
        errorOf(await client.call("logbutler_activity_stats", { since: "2026-13-01" }))?.code,
      ).toBe("argument_error");
    });
  });

  describe("digest 系", () => {
    it("logbutler_space_digest: スペース全体の digest エンベロープ", async () => {
      const r = await world().client.ok("logbutler_space_digest");
      expectEnvelope(r, "space", "digest");
      expect(r.digest).toHaveProperty("summary");
      expect(r.digest).toHaveProperty("disk_usage");
    });

    it("logbutler_activity_digest: limit・project・期間・timezone が効き、作った活動が含まれる", async () => {
      const { client, config } = world();
      const r = await client.ok("logbutler_activity_digest", {
        project: config.projectKey,
        since: ymd(-1),
        until: todayTokyo(),
        limit: 50,
        timezone: "Asia/Tokyo",
      });
      expectEnvelope(r, "activity", "digest");
      expect(r.digest.activities.length).toBeGreaterThan(0);
      expect(JSON.stringify(r.digest)).toContain(config.projectKey);
      const one = await client.ok("logbutler_activity_digest", { limit: 1 });
      expect(one.digest.activities.length).toBeLessThanOrEqual(1);
      const noArg = await client.ok("logbutler_activity_digest", {});
      expectEnvelope(noArg, "activity", "digest");
      expect(
        errorOf(await client.call("logbutler_activity_digest", { since: ymd(1), until: ymd(-1) }))
          ?.code,
      ).toBe("argument_error");
      expect(
        errorOf(await client.call("logbutler_activity_digest", { timezone: "Nowhere/Land" }))?.code,
      ).toBe("argument_error");
    });

    it("logbutler_user_activity: me / 数値 ID、limit・期間・project・activity_type_ids", async () => {
      const { client, config, meId } = world();
      // limit は期間(since/until)がないときだけ使う(logvalet と同じ。src/analysis/user-activity.ts)。
      const r = await client.ok("logbutler_user_activity", { user_id: "me", limit: 5 });
      expectEnvelope(r, "user_activity", "digest");
      expect(r.digest.activities.length).toBeLessThanOrEqual(5);
      expect(r.digest.activities.length).toBeGreaterThan(0);
      const dated = await client.ok("logbutler_user_activity", {
        user_id: "me",
        since: ymd(-2),
        max_response_tokens: 0,
      });
      expect(dated.digest.activities.length).toBeGreaterThan(0);
      const byId = await client.ok("logbutler_user_activity", {
        // 実行を重ねると活動が増え応答が上限を超えるため、サイズの安全網は外す(CLAUDE.md)
        max_response_tokens: 0,
        user_id: String(meId),
        project: config.projectKey,
        activity_type_ids: "1,2,3",
        timezone: "UTC",
      });
      expectEnvelope(byId, "user_activity", "digest");
      for (const a of byId.digest.activities) expect([1, 2, 3]).toContain(a.type);
      expect(errorOf(await client.call("logbutler_user_activity", { user_id: "bob" }))?.code).toBe(
        "argument_error",
      );
      expect(
        errorOf(
          await client.call("logbutler_user_activity", { user_id: "me", activity_type_ids: "x" }),
        )?.code,
      ).toBe("argument_error");
    });

    it("logbutler_digest_unified: project_keys / issue_keys / user_ids / team_ids / 日付フィルタ", async () => {
      const { client, config, meId } = world();
      const main = need(created.main, "main");
      const p = await client.ok("logbutler_digest_unified", {
        // 実行を重ねると課題が増え応答が上限を超えるため、サイズの安全網は外す(CLAUDE.md)
        max_response_tokens: 0,
        since: ymd(-1),
        project_keys: config.projectKey,
        timezone: "Asia/Tokyo",
      });
      expectEnvelope(p, "digest", "digest");
      expect((p.digest.issues as Any[]).length).toBeGreaterThan(0);
      const i = await client.ok("logbutler_digest_unified", {
        // 実行を重ねると課題が増え応答が上限を超えるため、サイズの安全網は外す(CLAUDE.md)
        max_response_tokens: 0,
        since: ymd(-1),
        issue_keys: main.key,
      });
      expect(JSON.stringify(i.digest.issues)).toContain(main.key);
      const u = await client.ok("logbutler_digest_unified", {
        // 実行を重ねると課題が増え応答が上限を超えるため、サイズの安全網は外す(CLAUDE.md)
        max_response_tokens: 0,
        since: ymd(-1),
        until: todayTokyo(),
        user_ids: String(meId),
        project_keys: config.projectKey,
      });
      expectEnvelope(u, "digest", "digest");
      const teams = await client.ok("logbutler_team_list", { no_members: true });
      const t = await client.ok("logbutler_digest_unified", {
        // 実行を重ねると課題が増え応答が上限を超えるため、サイズの安全網は外す(CLAUDE.md)
        max_response_tokens: 0,
        since: ymd(-1),
        team_ids: String(teams[0].id),
      });
      expectEnvelope(t, "digest", "digest");
      const due = await client.ok("logbutler_digest_unified", {
        // 実行を重ねると課題が増え応答が上限を超えるため、サイズの安全網は外す(CLAUDE.md)
        max_response_tokens: 0,
        since: ymd(-1),
        project_keys: config.projectKey,
        due_date: `${ymd(-30)}:${ymd(30)}`,
        start_date: `${ymd(-30)}:`,
      });
      expect(JSON.stringify(due.digest.issues)).toContain(main.key);
      expect(errorOf(await client.call("logbutler_digest_unified", {}))?.code).toBe(
        "argument_error",
      );
      expect(
        errorOf(
          await client.call("logbutler_digest_unified", {
            since: "today",
            project_keys: config.projectKey,
          }),
        )?.code,
      ).toBe("argument_error");
      expect(
        errorOf(await client.call("logbutler_digest_unified", { since: ymd(-1), due_date: "x" }))
          ?.code,
      ).toBe("argument_error");
    });

    it("logbutler_search: 作った課題が横断検索に出る。detail・件数・project_keys", async () => {
      const { client, config } = world();
      const main = need(created.main, "main");
      const r: Any = await pollFor(
        () =>
          client.ok("logbutler_search", { keyword: "updated", project_keys: config.projectKey }),
        (x: Any) => JSON.stringify(x.digest.items).includes(main.key),
      );
      const found = JSON.stringify(r.digest.items).includes(main.key);
      expectEnvelope(r, "search", "digest");
      expect(found, "課題が検索結果に出る").toBe(true);
      expect(r.digest.total_returned).toBe(r.digest.items.length);
      const meta = await client.ok("logbutler_search", {
        keyword: "live",
        detail: "meta",
        count: 1,
      });
      expect(meta.digest.returned_by_type.issues).toBeLessThanOrEqual(1);
      expect(
        errorOf(await client.call("logbutler_search", { keyword: "x", detail: "full" }))?.code,
      ).toBe("argument_error");
      expect(errorOf(await client.call("logbutler_search", { keyword: "x", count: 0 }))?.code).toBe(
        "argument_error",
      );
    });
  });
}
