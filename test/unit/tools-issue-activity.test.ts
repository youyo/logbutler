import { describe, expect, it } from "vitest";
import { callTool, expectTool } from "../helpers/tool-call";

const issue = {
  id: 1,
  projectId: 10,
  issueKey: "PROJ-1",
  keyId: 1,
  issueType: { id: 2, projectId: 10, name: "バグ", color: "#990000", displayOrder: 0 },
  summary: "s",
  description: "",
  priority: { id: 3, name: "中" },
  status: { id: 1, projectId: 10, name: "未対応", color: "#ed8077", displayOrder: 1000 },
  assignee: { id: 7, userId: "bob", name: "Bob" },
  startDate: null,
  dueDate: "2026-11-01T00:00:00Z",
  estimatedHours: null,
  createdUser: { id: 1, userId: "alice", name: "Alice" },
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-02T00:00:00Z",
  customFields: [],
  attachments: [],
  sharedFiles: [],
  stars: [],
};

describe("issue(単純な取得)", () => {
  it("issue_get: GET /issues/{key} の生データ(camelCase)をそのまま返す", async () => {
    const run = await expectTool({
      tool: "logbutler_issue_get",
      args: { issue_key: "PROJ-1" },
      respond: { "GET /issues/PROJ-1": issue },
      calls: ["GET /issues/PROJ-1"],
    });
    expect(Object.keys(run.json)).toContain("issueKey");
    expect(Object.keys(run.json)).not.toContain("issue_key");
  });

  describe("issue_comment_list(コメント一覧 API は minId / maxId / count / order のみ。offset は Backlog に送らない)", () => {
    const comment = (id: number) => ({
      id,
      content: `c${id}`,
      changeLog: [],
      createdUser: { id: 1 },
      created: "t",
      updated: "t",
      stars: [],
      notifications: [],
    });
    const many = (n: number) => Array.from({ length: n }, (_, i) => comment(100 - i)); // 新しい順(既定の desc)
    const run = (args: Record<string, unknown>, respond: Parameters<typeof callTool>[2]) =>
      callTool("logbutler_issue_comment_list", { issue_key: "PROJ-1", ...args }, respond);

    it("引数なし・count だけ・0 以下は offset なし: count だけ送る(0 以下は送らない)", async () => {
      await expectTool({
        tool: "logbutler_issue_comment_list",
        args: { issue_key: "PROJ-1" },
        respond: { "GET /issues/PROJ-1/comments": [comment(1)] },
        calls: ["GET /issues/PROJ-1/comments"],
      });
      await expectTool({
        tool: "logbutler_issue_comment_list",
        args: { issue_key: "PROJ-1", count: 50 },
        respond: { "GET /issues/PROJ-1/comments": [comment(1)] },
        calls: ["GET /issues/PROJ-1/comments?count=50"],
      });
      await expectTool({
        tool: "logbutler_issue_comment_list",
        args: { issue_key: "PROJ-1", count: 0, offset: 0 },
        respond: { "GET /issues/PROJ-1/comments": [comment(1)] },
        calls: ["GET /issues/PROJ-1/comments"],
      });
    });

    it("offset あり: count + offset 件を取り、先頭 offset 件を読み飛ばす(offset は送らない)", async () => {
      const r = await run({ count: 5, offset: 3 }, { "GET /issues/PROJ-1/comments": many(8) });
      expect(r.isError, r.text).toBe(false);
      expect(r.calls).toEqual(["GET /issues/PROJ-1/comments?count=8"]);
      expect(r.json.map((c: { id: number }) => c.id)).toEqual([97, 96, 95, 94, 93]);
    });

    it("offset だけ: count は Backlog の既定(20)として count = 20 + offset を取る", async () => {
      const r = await run({ offset: 2 }, { "GET /issues/PROJ-1/comments": many(22) });
      expect(r.calls).toEqual(["GET /issues/PROJ-1/comments?count=22"]);
      expect(r.json).toHaveLength(20);
      expect(r.json[0].id).toBe(98);
    });

    it("offset がコメント数以上なら空配列", async () => {
      const r = await run({ count: 5, offset: 10 }, { "GET /issues/PROJ-1/comments": many(4) });
      expect(r.isError, r.text).toBe(false);
      expect(r.json).toEqual([]);
    });

    it("count + offset がちょうど 100 は通り、101 以上は argument_error(Backlog を呼ばない)", async () => {
      const ok = await run(
        { count: 90, offset: 10, max_response_tokens: 0 },
        { "GET /issues/PROJ-1/comments": many(100) },
      );
      expect(ok.isError, ok.text).toBe(false);
      expect(ok.calls).toEqual(["GET /issues/PROJ-1/comments?count=100"]);
      expect(ok.json).toHaveLength(90);

      for (const args of [{ count: 91, offset: 10 }, { offset: 81 }]) {
        const r = await run(args, {});
        expect(r.isError).toBe(true);
        expect(r.json.error.code).toBe("argument_error");
        expect(r.calls).toEqual([]);
      }
    });
  });

  it("issue_attachment_list: GET /issues/{key}/attachments", async () => {
    await expectTool({
      tool: "logbutler_issue_attachment_list",
      args: { issue_key: "PROJ-1" },
      respond: {
        "GET /issues/PROJ-1/attachments": [
          { id: 7, name: "a.png", size: 3, createdUser: { id: 1 }, created: "t" },
        ],
      },
      calls: ["GET /issues/PROJ-1/attachments"],
    });
  });

  it("issue_related_list: 未公開 API GET /issues/{key}/relatedIssues", async () => {
    await expectTool({
      tool: "logbutler_issue_related_list",
      args: { issue_key: "PROJ-1" },
      respond: { "GET /issues/PROJ-1/relatedIssues": [{ id: 5, issueId: 1, relatedIssueId: 2 }] },
      calls: ["GET /issues/PROJ-1/relatedIssues"],
    });
  });

  it("issue_key が空・型違いなら argument_error", async () => {
    for (const issue_key of ["", 5]) {
      const run = await callTool("logbutler_issue_get", { issue_key }, {});
      expect(run.json.error.code).toBe("argument_error");
      expect(run.calls).toEqual([]);
    }
  });
});

describe("issue_attachment_download / shared_file_download", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  const b64 = "AAEC+v8=";

  it("issue_attachment_download: base64・ファイル名・Content-Type・サイズを snake_case で返す", async () => {
    const run = await expectTool({
      tool: "logbutler_issue_attachment_download",
      args: { issue_key: "PROJ-1", attachment_id: 7 },
      respond: {
        "GET /issues/PROJ-1/attachments/7": () =>
          new Response(bytes, {
            headers: {
              "Content-Type": "image/png",
              "Content-Disposition": 'attachment; filename="shot.png"',
            },
          }),
      },
      calls: ["GET /issues/PROJ-1/attachments/7"],
      output: {
        content_base64: b64,
        filename: "shot.png",
        content_type: "image/png",
        size_bytes: 5,
      },
    });
    expect(run.recorded[0]?.headers.get("authorization")).toMatch(/^Bearer /);
  });

  it("shared_file_download: GET /projects/{key}/files/{id}", async () => {
    await expectTool({
      tool: "logbutler_shared_file_download",
      args: { project_key: "PROJ", file_id: 3 },
      respond: {
        "GET /projects/PROJ/files/3": () =>
          new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }),
      },
      calls: ["GET /projects/PROJ/files/3"],
      output: {
        content_base64: b64,
        filename: "3",
        content_type: "application/octet-stream",
        size_bytes: 5,
      },
    });
  });

  it("20 MiB ちょうどは成功する", async () => {
    const run = await callTool(
      "logbutler_issue_attachment_download",
      { issue_key: "PROJ-1", attachment_id: 7 },
      { "GET /issues/PROJ-1/attachments/7": () => new Response(new Uint8Array(20 * 1024 * 1024)) },
    );
    expect(run.isError).toBe(false);
    expect(run.json.size_bytes).toBe(20 * 1024 * 1024);
  });

  it("20 MiB を超えたら、argument_error ではなく専用 message の api_error。全体を読む前に止まる", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
        if (pulls >= 200) controller.close();
      },
    });
    const run = await callTool(
      "logbutler_issue_attachment_download",
      { issue_key: "PROJ-1", attachment_id: 7 },
      { "GET /issues/PROJ-1/attachments/7": () => new Response(body) },
    );
    expect(run.isError).toBe(true);
    expect(run.json.schema_version).toBe("1");
    expect(run.json.error.code).toBe("api_error");
    expect(run.json.error.code).not.toBe("argument_error");
    expect(run.json.error.retryable).toBe(false);
    expect(run.json.error.message).toMatch(/too large.*20 MiB/i);
    expect(pulls).toBeLessThanOrEqual(25);
  });

  it("エラー応答: Backlog の 404 は not_found のエンベロープ", async () => {
    const run = await callTool(
      "logbutler_shared_file_download",
      { project_key: "PROJ", file_id: 3 },
      { "GET /projects/PROJ/files/3": new Response("{}", { status: 404 }) },
    );
    expect(run.json.error.code).toBe("not_found");
  });
});

describe("issue_list", () => {
  const me = { id: 42, userId: "alice", name: "Alice" };

  it("引数なしなら GET /issues(クエリなし)", async () => {
    await expectTool({
      tool: "logbutler_issue_list",
      respond: { "GET /issues": [issue] },
      calls: ["GET /issues"],
    });
  });

  it("project_key は projectId に解決して projectId[] で渡す", async () => {
    await expectTool({
      tool: "logbutler_issue_list",
      args: { project_key: "PROJ" },
      respond: { "GET /projects/PROJ": { id: 10 }, "GET /issues": [issue] },
      calls: ["GET /projects/PROJ", "GET /issues?projectId[]=10"],
      output: [issue],
    });
  });

  it("project_keys(CSV)は 1 件ずつ順番に解決する。project_key と重なるキーは 1 回だけ引き、ID も重複させない", async () => {
    await expectTool({
      tool: "logbutler_issue_list",
      args: { project_key: "A", project_keys: "A, B,,C" },
      respond: {
        "GET /projects/A": { id: 1 },
        "GET /projects/B": { id: 2 },
        "GET /projects/C": { id: 3 },
        "GET /issues": [],
      },
      calls: [
        "GET /projects/A",
        "GET /projects/B",
        "GET /projects/C",
        "GET /issues?projectId[]=1&projectId[]=2&projectId[]=3",
      ],
    });
  });

  it("assignee_id=me は GET /users/myself で解決する。数値はそのまま", async () => {
    await expectTool({
      tool: "logbutler_issue_list",
      args: { assignee_id: "me" },
      respond: { "GET /users/myself": me, "GET /issues": [issue] },
      calls: ["GET /users/myself", "GET /issues?assigneeId[]=42"],
      output: [issue],
    });
    await expectTool({
      tool: "logbutler_issue_list",
      args: { assignee_id: "7" },
      respond: { "GET /issues": [] },
      calls: ["GET /issues?assigneeId[]=7"],
    });
    const bad = await callTool("logbutler_issue_list", { assignee_id: "bob" }, {});
    expect(bad.json.error.code).toBe("argument_error");
    expect(bad.json.error.message).toContain("assignee_id");
  });

  it("status_id: CSV はそのまま(状態一覧は引かない)。数値でも not-closed でもなければ argument_error", async () => {
    await expectTool({
      tool: "logbutler_issue_list",
      args: { status_id: "2, 4" },
      respond: { "GET /issues": [] },
      calls: ["GET /issues?statusId[]=2&statusId[]=4"],
    });
    const bad = await callTool("logbutler_issue_list", { status_id: "open" }, {});
    expect(bad.json.error.code).toBe("argument_error");
  });

  describe("status_id=not-closed(完了集合以外のすべての状態。ID を決め打ちしない)", () => {
    const st = (id: number, name: string) => ({ id, projectId: 10, name });
    const standard = [st(1, "未対応"), st(2, "処理中"), st(3, "処理済み"), st(4, "完了")];

    it("project_key あり: 対象プロジェクトの状態一覧から完了集合以外の ID を使う(カスタム状態も入る)", async () => {
      await expectTool({
        tool: "logbutler_issue_list",
        args: { project_key: "PROJ", status_id: "not-closed" },
        respond: {
          "GET /projects/PROJ": { id: 10 },
          "GET /projects/PROJ/statuses": [...standard, st(101, "レビュー待ち")],
          "GET /issues": [],
        },
        calls: [
          "GET /projects/PROJ",
          "GET /projects/PROJ/statuses",
          "GET /issues?projectId[]=10&statusId[]=1&statusId[]=2&statusId[]=3&statusId[]=101",
        ],
      });
    });

    it("完了集合の名前(完了 / 対応済み / Closed / Done / Resolved)は ID が何であっても除く。ID が別名のカスタム状態なら残す", async () => {
      await expectTool({
        tool: "logbutler_issue_list",
        args: { project_key: "PROJ", status_id: "not-closed" },
        respond: {
          "GET /projects/PROJ": { id: 10 },
          "GET /projects/PROJ/statuses": [
            st(7, "対応済み"),
            st(8, "Closed"),
            st(9, "Done"),
            st(10, "Resolved"),
            st(11, "完了"),
            st(4, "保留"), // ID 4 でも名前が完了集合でなければ未完了
          ],
          "GET /issues": [],
        },
        calls: [
          "GET /projects/PROJ",
          "GET /projects/PROJ/statuses",
          "GET /issues?projectId[]=10&statusId[]=4",
        ],
      });
    });

    it("複数プロジェクト: 状態一覧を 1 件ずつ引き、ID の重複は 1 つにまとめる", async () => {
      await expectTool({
        tool: "logbutler_issue_list",
        args: { project_keys: "A,B", status_id: "not-closed" },
        respond: {
          "GET /projects/A": { id: 1 },
          "GET /projects/B": { id: 2 },
          "GET /projects/A/statuses": [st(1, "未対応"), st(4, "完了")],
          "GET /projects/B/statuses": [st(1, "未対応"), st(201, "検証中")],
          "GET /issues": [],
        },
        calls: [
          "GET /projects/A",
          "GET /projects/B",
          "GET /projects/A/statuses",
          "GET /projects/B/statuses",
          "GET /issues?projectId[]=1&projectId[]=2&statusId[]=1&statusId[]=201",
        ],
      });
    });

    it("プロジェクト指定なし: GET /projects(アーカイブ除く)の各プロジェクトの状態一覧を使う", async () => {
      await expectTool({
        tool: "logbutler_issue_list",
        args: { status_id: "not-closed" },
        respond: {
          "GET /projects": [
            { id: 10, projectKey: "PROJ" },
            { id: 20, projectKey: "OTHER" },
          ],
          "GET /projects/PROJ/statuses": standard,
          "GET /projects/OTHER/statuses": [st(1, "未対応"), st(301, "検証中")],
          "GET /issues": [],
        },
        calls: [
          "GET /projects?archived=false",
          "GET /projects/PROJ/statuses",
          "GET /projects/OTHER/statuses",
          "GET /issues?statusId[]=1&statusId[]=2&statusId[]=3&statusId[]=301",
        ],
      });
    });

    it("プロジェクトが 20 を超える(指定なし)と argument_error(project_key で絞るよう促す)。課題一覧は呼ばない", async () => {
      const projects = Array.from({ length: 21 }, (_, i) => ({ id: i + 1, projectKey: `P${i}` }));
      const run = await callTool(
        "logbutler_issue_list",
        { status_id: "not-closed" },
        { "GET /projects": projects },
      );
      expect(run.isError).toBe(true);
      expect(run.json.error.code).toBe("argument_error");
      expect(run.json.error.message).toContain("project_key");
      expect(run.calls).toEqual(["GET /projects?archived=false"]);
    });

    it("project_keys が 20 を超えると Backlog を呼ぶ前に argument_error", async () => {
      const keys = Array.from({ length: 21 }, (_, i) => `P${i}`).join(",");
      const run = await callTool(
        "logbutler_issue_list",
        { project_keys: keys, status_id: "not-closed" },
        {},
      );
      expect(run.json.error.code).toBe("argument_error");
      expect(run.calls).toEqual([]);
    });

    it("未完了の状態が 1 つもない(参加プロジェクトなし・全状態が完了集合)なら、課題一覧を呼ばず空配列", async () => {
      const none = await callTool(
        "logbutler_issue_list",
        { status_id: "not-closed" },
        { "GET /projects": [] },
      );
      expect(none.json).toEqual([]);
      expect(none.calls).toEqual(["GET /projects?archived=false"]);
      const allDone = await callTool(
        "logbutler_issue_list",
        { project_key: "PROJ", status_id: "not-closed" },
        {
          "GET /projects/PROJ": { id: 10 },
          "GET /projects/PROJ/statuses": [st(4, "完了")],
        },
      );
      expect(allDone.json).toEqual([]);
      expect(allDone.calls).toEqual(["GET /projects/PROJ", "GET /projects/PROJ/statuses"]);
    });

    it("状態一覧の取得に失敗したらツールエラー(黙って ID を決め打ちしない)", async () => {
      const run = await callTool(
        "logbutler_issue_list",
        { project_key: "PROJ", status_id: "not-closed" },
        {
          "GET /projects/PROJ": { id: 10 },
          "GET /projects/PROJ/statuses": new Response(
            JSON.stringify({ errors: [{ message: "x", code: 11 }] }),
            { status: 403 },
          ),
        },
      );
      expect(run.isError).toBe(true);
      expect(run.json.error.code).toBe("permission_error");
    });
  });

  it("keyword / sort / order / count / offset", async () => {
    await expectTool({
      tool: "logbutler_issue_list",
      args: { keyword: "バグ", sort: "updated", order: "asc", count: 100, offset: 20 },
      respond: { "GET /issues": [] },
      calls: ["GET /issues?count=100&keyword=バグ&offset=20&order=asc&sort=updated"],
    });
  });

  it("count は 1〜100(説明文に max 100)。範囲外は argument_error。offset 0 は送らない", async () => {
    for (const count of [0, 101]) {
      const run = await callTool("logbutler_issue_list", { count }, {});
      expect(run.json.error.code).toBe("argument_error");
      expect(run.calls).toEqual([]);
    }
    await expectTool({
      tool: "logbutler_issue_list",
      args: { offset: 0 },
      respond: { "GET /issues": [] },
      calls: ["GET /issues"],
    });
  });

  it("parent_issue_ids は parentIssueId[] に分解する", async () => {
    await expectTool({
      tool: "logbutler_issue_list",
      args: { parent_issue_ids: "100,200" },
      respond: { "GET /issues": [] },
      calls: ["GET /issues?parentIssueId[]=100&parentIssueId[]=200"],
    });
    const bad = await callTool("logbutler_issue_list", { parent_issue_ids: "1,x" }, {});
    expect(bad.json.error.message).toContain("parent_issue_ids");
  });

  it("updated_since / updated_until は YYYY-MM-DD を検証して渡す", async () => {
    await expectTool({
      tool: "logbutler_issue_list",
      args: { updated_since: "2026-01-01", updated_until: "2026-01-31" },
      respond: { "GET /issues": [] },
      calls: ["GET /issues?updatedSince=2026-01-01&updatedUntil=2026-01-31"],
    });
    const bad = await callTool("logbutler_issue_list", { updated_since: "2026-02-30" }, {});
    expect(bad.json.error.code).toBe("argument_error");
    expect(bad.json.error.message).toContain("updated_since");
  });

  describe("due_date / start_date(基準タイムゾーンの「今日」)", () => {
    // 2026-10-28 15:30 UTC = 2026-10-29 00:30 JST(木曜日)
    const now = new Date("2026-10-28T15:30:00Z");

    it("既定のタイムゾーンは Asia/Tokyo(Workers は UTC で動くため)", async () => {
      const run = await callTool(
        "logbutler_issue_list",
        { due_date: "today" },
        { "GET /issues": [] },
        { now },
      );
      expect(run.calls).toEqual(["GET /issues?dueDateSince=2026-10-29&dueDateUntil=2026-10-29"]);
    });

    it("timezone を渡せばその地域の今日になる", async () => {
      const run = await callTool(
        "logbutler_issue_list",
        { due_date: "today" },
        { "GET /issues": [] },
        { now, timezone: "UTC" },
      );
      expect(run.calls).toEqual(["GET /issues?dueDateSince=2026-10-28&dueDateUntil=2026-10-28"]);
    });

    it("overdue は昨日まで、this-week は月曜〜日曜、this-month は月初〜月末", async () => {
      const call = async (args: Record<string, unknown>) =>
        (await callTool("logbutler_issue_list", args, { "GET /issues": [] }, { now })).calls;
      expect(await call({ due_date: "overdue" })).toEqual(["GET /issues?dueDateUntil=2026-10-28"]);
      expect(await call({ due_date: "this-week" })).toEqual([
        "GET /issues?dueDateSince=2026-10-26&dueDateUntil=2026-11-01",
      ]);
      expect(await call({ start_date: "this-month" })).toEqual([
        "GET /issues?startDateSince=2026-10-01&startDateUntil=2026-10-31",
      ]);
    });

    it("日付・範囲 A:B", async () => {
      const call = async (args: Record<string, unknown>) =>
        (await callTool("logbutler_issue_list", args, { "GET /issues": [] }, { now })).calls;
      expect(await call({ due_date: "2026-01-05" })).toEqual([
        "GET /issues?dueDateSince=2026-01-05&dueDateUntil=2026-01-05",
      ]);
      expect(await call({ start_date: "2026-01-05:2026-01-09" })).toEqual([
        "GET /issues?startDateSince=2026-01-05&startDateUntil=2026-01-09",
      ]);
    });

    it("start_date に overdue は使えない。不正な値は argument_error", async () => {
      for (const args of [{ start_date: "overdue" }, { due_date: "tomorrow" }]) {
        const run = await callTool("logbutler_issue_list", args, {}, { now });
        expect(run.json.error.code).toBe("argument_error");
        expect(run.calls).toEqual([]);
      }
    });

    it("存在しないタイムゾーンは設定ミスなので generic_error(詳細は応答に出さない)", async () => {
      const run = await callTool(
        "logbutler_issue_list",
        { due_date: "today" },
        {},
        { now, timezone: "Mars/Base" },
      );
      expect(run.isError).toBe(true);
      expect(run.json.error.code).toBe("generic_error");
      expect(run.text).not.toContain("Mars");
    });
  });

  it("Backlog のエラー(プロジェクトが 404)は not_found のエンベロープで、issues は呼ばない", async () => {
    const run = await callTool(
      "logbutler_issue_list",
      { project_key: "NOPE" },
      {
        "GET /projects/NOPE": new Response(
          JSON.stringify({ errors: [{ message: "No project.", code: 6 }] }),
          { status: 404 },
        ),
      },
    );
    expect(run.isError).toBe(true);
    expect(run.json.error.code).toBe("not_found");
    expect(run.calls).toEqual(["GET /projects/NOPE"]);
  });
});

describe("activity_list", () => {
  const activities = [
    {
      id: 1,
      project: { id: 10, projectKey: "PROJ" },
      type: 1,
      content: { id: 1, key_id: 1, summary: "s" },
      createdUser: { id: 1 },
      created: "t",
    },
  ];

  it("引数なしはスペース全体 GET /space/activities?count=20(既定 20 件)", async () => {
    await expectTool({
      tool: "logbutler_activity_list",
      respond: { "GET /space/activities": activities },
      calls: ["GET /space/activities?count=20"],
    });
  });

  it("project_key はプロジェクト単位", async () => {
    await expectTool({
      tool: "logbutler_activity_list",
      args: { project_key: "PROJ" },
      respond: { "GET /projects/PROJ/activities": activities },
      calls: ["GET /projects/PROJ/activities?count=20"],
    });
  });

  it("user_id: 数値はそのまま、me は GET /users/myself で解決する", async () => {
    await expectTool({
      tool: "logbutler_activity_list",
      args: { user_id: "7" },
      respond: { "GET /users/7/activities": activities },
      calls: ["GET /users/7/activities?count=20"],
    });
    await expectTool({
      tool: "logbutler_activity_list",
      args: { user_id: "me" },
      respond: { "GET /users/myself": { id: 42 }, "GET /users/42/activities": activities },
      calls: ["GET /users/myself", "GET /users/42/activities?count=20"],
      output: activities,
    });
  });

  it("count / activity_type_ids(activityTypeId[]) / order", async () => {
    await expectTool({
      tool: "logbutler_activity_list",
      args: { count: 100, activity_type_ids: "1, 2,3", order: "asc" },
      respond: { "GET /space/activities": [] },
      calls: [
        "GET /space/activities?activityTypeId[]=1&activityTypeId[]=2&activityTypeId[]=3&count=100&order=asc",
      ],
    });
  });

  it("user_id と project_key は同時に指定できない(argument_error)。Backlog は呼ばない", async () => {
    const run = await callTool("logbutler_activity_list", { user_id: "1", project_key: "P" }, {});
    expect(run.json.error.code).toBe("argument_error");
    expect(run.json.error.message).toContain("mutually exclusive");
    expect(run.calls).toEqual([]);
  });

  it("不正な user_id・activity_type_ids・範囲外の count は argument_error", async () => {
    for (const args of [
      { user_id: "bob" },
      { activity_type_ids: "1,x" },
      { count: 0 },
      { count: 101 },
    ]) {
      const run = await callTool("logbutler_activity_list", args, {});
      expect(run.json.error.code).toBe("argument_error");
      expect(run.calls).toEqual([]);
    }
  });
});
