import { describe, expect, it } from "vitest";
import { issueCreate } from "../../src/mcp/tools/issue-write";
import { jsonResponse } from "../helpers/mock-fetch";
import { callTool, formPairs } from "../helpers/tool-call";

const created = { id: 500, issueKey: "PROJ-9", summary: "s" };
const noContent = () => new Response(null, { status: 204 });

describe("issue_create", () => {
  const project = { "GET /projects/PROJ": { id: 10, projectKey: "PROJ" } };

  const priorities = [
    { id: 2, name: "高" },
    { id: 3, name: "中" },
    { id: 4, name: "低" },
  ];

  it("必須の引数だけ: priority_id 省略時は GET /priorities から既定値(id 3 があれば 3)を決めて POST /issues", async () => {
    const run = await callTool(
      "logbutler_issue_create",
      { project_key: "PROJ", summary: "件名", issue_type_id: 2 },
      { ...project, "GET /priorities": priorities, "POST /issues": created },
    );
    expect(run.isError, run.text).toBe(false);
    expect(run.calls).toEqual(["GET /projects/PROJ", "GET /priorities", "POST /issues"]);
    expect(run.json).toEqual(created);
    const post = run.recorded[2];
    expect(post?.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(formPairs(post)).toEqual([
      "issueTypeId=2",
      "priorityId=3",
      "projectId=10",
      "summary=件名",
    ]);
  });

  it("priority_id 省略で一覧に id 3 が無ければ、一覧の中央の要素(名前に頼らない)", async () => {
    const run = await callTool(
      "logbutler_issue_create",
      { project_key: "PROJ", summary: "件名", issue_type_id: 2 },
      {
        ...project,
        "GET /priorities": [
          { id: 12, name: "Low" },
          { id: 10, name: "High" },
          { id: 11, name: "Normal" },
        ],
        "POST /issues": created,
      },
    );
    expect(run.isError, run.text).toBe(false);
    expect(formPairs(run.recorded[2])).toContain("priorityId=11");
  });

  it("priority_id 省略で優先度一覧が空なら argument_error(選べる id と指定の案内)。課題は作らない", async () => {
    const run = await callTool(
      "logbutler_issue_create",
      { project_key: "PROJ", summary: "件名", issue_type_id: 2 },
      { ...project, "GET /priorities": [], "POST /issues": created },
    );
    expect(run.isError).toBe(true);
    expect(run.json.error.code).toBe("argument_error");
    expect(run.json.error.message).toContain("priority_id");
    expect(run.calls).not.toContain("POST /issues");
  });

  it("maxApiCalls は 25 = GetProject 1 + 規約(課題種別 1 + 10 ページ) + カテゴリ 1 + 案件の親課題 10 ページ + 優先度 1 + POST 1", () => {
    expect(issueCreate.maxApiCalls).toBe(25);
  });

  it("priority_id を明示したらそのまま送る(0 も変換せず Backlog に検証を任せる)", async () => {
    for (const [given, sent] of [
      [2, "priorityId=2"],
      [0, "priorityId=0"],
    ] as const) {
      const run = await callTool(
        "logbutler_issue_create",
        { project_key: "PROJ", summary: "件名", issue_type_id: 2, priority_id: given },
        { ...project, "POST /issues": created },
      );
      expect(run.isError, run.text).toBe(false);
      expect(run.calls).toEqual(["GET /projects/PROJ", "POST /issues"]);
      expect(formPairs(run.recorded[1])).toContain(sent);
    }
  });

  it("すべての引数: 配列は key[]、日付は YYYY-MM-DD、priority_id は指定した値を送る", async () => {
    const run = await callTool(
      "logbutler_issue_create",
      {
        project_key: "PROJ",
        summary: "件名",
        issue_type_id: 2,
        description: "本文",
        priority_id: 3,
        assignee_id: 7,
        parent_issue_id: 99,
        category_ids: "10,20",
        version_ids: "1",
        milestone_ids: "5, 6",
        notified_user_ids: "8,9",
        due_date: "2026-11-30",
        start_date: "2026-11-01",
      },
      { ...project, "POST /issues": created },
    );
    expect(run.isError, run.text).toBe(false);
    expect(formPairs(run.recorded[1])).toEqual([
      "assigneeId=7",
      "categoryId[]=10",
      "categoryId[]=20",
      "description=本文",
      "dueDate=2026-11-30",
      "issueTypeId=2",
      "milestoneId[]=5",
      "milestoneId[]=6",
      "notifiedUserId[]=8",
      "notifiedUserId[]=9",
      "parentIssueId=99",
      "priorityId=3",
      "projectId=10",
      "startDate=2026-11-01",
      "summary=件名",
      "versionId[]=1",
    ]);
  });

  it("入力が不正なら Backlog を呼ばずに argument_error", async () => {
    const base = { project_key: "PROJ", summary: "s", issue_type_id: 2 };
    for (const bad of [
      { category_ids: "1,x" },
      { version_ids: "a" },
      { notified_user_ids: "1;2" },
      { due_date: "2026-13-01" },
      { start_date: "tomorrow" },
      { summary: "" },
      { project_key: " " },
      { issue_type_id: 0 },
      { issue_type_id: 1.5 },
    ]) {
      const run = await callTool("logbutler_issue_create", { ...base, ...bad }, {});
      expect(run.isError, JSON.stringify(bad)).toBe(true);
      expect(run.json.error.code, JSON.stringify(bad)).toBe("argument_error");
      expect(run.calls, JSON.stringify(bad)).toEqual([]);
    }
  });

  it("プロジェクトが無ければ not_found で、課題は作らない", async () => {
    const run = await callTool(
      "logbutler_issue_create",
      { project_key: "NOPE", summary: "s", issue_type_id: 2 },
      {
        "GET /projects/NOPE": jsonResponse({ errors: [{ message: "No project.", code: 6 }] }, 404),
      },
    );
    expect(run.json.error.code).toBe("not_found");
    expect(run.calls).toEqual(["GET /projects/NOPE"]);
  });

  describe("engagement", () => {
    const engagementYaml = `schema_version: 1
project:
  key: PROJ
engagements:
  - name: 顧客A 基盤更改
    lead: 山田
    initiative: 運用保守
`;
    const rule = {
      id: 100,
      issueKey: "PROJ-1",
      issueType: { name: "規約" },
      description: `\`\`\`yaml\n${engagementYaml}\`\`\`\n`,
    };
    const parent = { id: 101, summary: "[案件] 顧客A 基盤更改", issueType: { name: "案件" } };
    const respond = (issues: (type: string | null) => unknown[]) => ({
      ...project,
      "GET /projects/PROJ/issueTypes": [
        { id: 10, name: "規約" },
        { id: 11, name: "案件" },
      ],
      "GET /issues": (call: { url: string }) =>
        issues(new URL(call.url).searchParams.get("issueTypeId[]")),
      "GET /projects/PROJ/categories": [{ id: 20, name: "顧客A 基盤更改" }],
      "GET /priorities": priorities,
      "POST /issues": created,
    });
    const byType = (t: string | null) => (t === "10" ? [rule] : t === "11" ? [parent] : []);

    it("カテゴリと親課題を補完する（プロジェクトの解決は 1 回）", async () => {
      const run = await callTool(
        "logbutler_issue_create",
        { project_key: "PROJ", summary: "s", issue_type_id: 2, engagement: "顧客A 基盤更改" },
        respond(byType),
      );
      expect(run.isError, run.text).toBe(false);
      expect(run.calls.filter((c) => c === "GET /projects/PROJ")).toHaveLength(1);
      expect(run.calls.at(-1)).toBe("POST /issues");
      expect(formPairs(run.recorded.at(-1))).toEqual([
        "categoryId[]=20",
        "issueTypeId=2",
        "parentIssueId=101",
        "priorityId=3",
        "projectId=10",
        "summary=s",
      ]);
    });

    it("明示した category_ids / parent_issue_id は上書きしない", async () => {
      const run = await callTool(
        "logbutler_issue_create",
        {
          project_key: "PROJ",
          summary: "s",
          issue_type_id: 2,
          engagement: "顧客A 基盤更改",
          category_ids: "7",
          parent_issue_id: 55,
        },
        respond(byType),
      );
      expect(formPairs(run.recorded.at(-1))).toEqual([
        "categoryId[]=7",
        "issueTypeId=2",
        "parentIssueId=55",
        "priorityId=3",
        "projectId=10",
        "summary=s",
      ]);
    });

    it("category_ids を空文字で明示したら、カテゴリは補完しない（親課題は補完する）", async () => {
      const run = await callTool(
        "logbutler_issue_create",
        {
          project_key: "PROJ",
          summary: "s",
          issue_type_id: 2,
          engagement: "顧客A 基盤更改",
          category_ids: "",
        },
        respond(byType),
      );
      expect(formPairs(run.recorded.at(-1))).toEqual([
        "issueTypeId=2",
        "parentIssueId=101",
        "priorityId=3",
        "projectId=10",
        "summary=s",
      ]);
    });

    it("親課題が無い案件は parentIssueId を送らない。未知の案件は argument_error で課題を作らない", async () => {
      const noParent = await callTool(
        "logbutler_issue_create",
        { project_key: "PROJ", summary: "s", issue_type_id: 2, engagement: "顧客A 基盤更改" },
        respond((t) => (t === "10" ? [rule] : [])),
      );
      expect(formPairs(noParent.recorded.at(-1))).not.toContain("parentIssueId=101");
      expect(formPairs(noParent.recorded.at(-1)).some((p) => p.startsWith("parentIssueId"))).toBe(
        false,
      );

      const unknown = await callTool(
        "logbutler_issue_create",
        { project_key: "PROJ", summary: "s", issue_type_id: 2, engagement: "存在しない" },
        respond(byType),
      );
      expect(unknown.json.error.code).toBe("argument_error");
      expect(unknown.calls).not.toContain("POST /issues");
    });
  });
});

describe("issue_update", () => {
  const updated = { id: 1, issueKey: "PROJ-1" };

  it("指定した項目だけを PATCH /issues/{key} のフォームで送る", async () => {
    const run = await callTool(
      "logbutler_issue_update",
      {
        issue_key: "PROJ-1",
        summary: "新件名",
        description: "",
        status_id: 3,
        priority_id: 2,
        assignee_id: 7,
        issue_type_id: 4,
        category_ids: "10,20",
        version_ids: "1,2",
        milestone_ids: "3",
        notified_user_ids: "8",
        due_date: "2026-12-01",
        start_date: "2026-11-01",
        comment: "更新します",
      },
      { "PATCH /issues/PROJ-1": updated },
    );
    expect(run.isError, run.text).toBe(false);
    expect(run.calls).toEqual(["PATCH /issues/PROJ-1"]);
    expect(run.json).toEqual(updated);
    expect(formPairs(run.recorded[0])).toEqual([
      "assigneeId=7",
      "categoryId[]=10",
      "categoryId[]=20",
      "comment=更新します",
      "description=",
      "dueDate=2026-12-01",
      "issueTypeId=4",
      "milestoneId[]=3",
      "notifiedUserId[]=8",
      "priorityId=2",
      "startDate=2026-11-01",
      "statusId=3",
      "summary=新件名",
      "versionId[]=1",
      "versionId[]=2",
    ]);
  });

  it("parent_issue_id=0 は親の解除（parentIssueId を空文字で送る）。他の値は ID", async () => {
    const clear = await callTool(
      "logbutler_issue_update",
      { issue_key: "PROJ-1", parent_issue_id: 0 },
      { "PATCH /issues/PROJ-1": updated },
    );
    expect(clear.recorded[0]?.body).toBe("parentIssueId=");
    const set = await callTool(
      "logbutler_issue_update",
      { issue_key: "PROJ-1", parent_issue_id: 12 },
      { "PATCH /issues/PROJ-1": updated },
    );
    expect(formPairs(set.recorded[0])).toEqual(["parentIssueId=12"]);
  });

  describe('変更なしの更新(実 Backlog は現在と同じ値だけの PATCH に 400 code=7 "No comment content." を返す)', () => {
    const noChange = () =>
      new Response(JSON.stringify({ errors: [{ message: "No comment content.", code: 7 }] }), {
        status: 400,
      });
    const current = { id: 1, issueKey: "PROJ-1", description: "same" };

    it("その 400 のときだけ課題を GET して成功として返す(PATCH → GET の順)", async () => {
      const run = await callTool(
        "logbutler_issue_update",
        { issue_key: "PROJ-1", description: "same" },
        { "PATCH /issues/PROJ-1": noChange, "GET /issues/PROJ-1": current },
      );
      expect(run.isError, run.text).toBe(false);
      expect(run.calls).toEqual(["PATCH /issues/PROJ-1", "GET /issues/PROJ-1"]);
      expect(run.json).toEqual(current);
    });

    it.each([
      ["code が 7 でない", { message: "No comment content.", code: 6 }, 400],
      ["message が違う", { message: "Something else.", code: 7 }, 400],
      ["HTTP 400 でない", { message: "No comment content.", code: 7 }, 422],
    ])("%s 400 はそのままエラー(GET しない)", async (_label, error, status) => {
      const run = await callTool(
        "logbutler_issue_update",
        { issue_key: "PROJ-1", description: "same" },
        {
          "PATCH /issues/PROJ-1": () =>
            new Response(JSON.stringify({ errors: [error] }), { status }),
        },
      );
      expect(run.isError).toBe(true);
      expect(run.calls).toEqual(["PATCH /issues/PROJ-1"]);
      expect(run.json.error.code).toBe(status === 422 ? "argument_error" : "api_error");
    });

    it("GET が失敗したらそのエラーを返す", async () => {
      const run = await callTool(
        "logbutler_issue_update",
        { issue_key: "PROJ-1", description: "same" },
        {
          "PATCH /issues/PROJ-1": noChange,
          "GET /issues/PROJ-1": () =>
            new Response(JSON.stringify({ errors: [{ message: "No issue.", code: 6 }] }), {
              status: 404,
            }),
        },
      );
      expect(run.isError).toBe(true);
      expect(run.json.error.code).toBe("not_found");
    });
  });

  it("コメントだけの更新も更新項目として数える", async () => {
    const run = await callTool(
      "logbutler_issue_update",
      { issue_key: "PROJ-1", comment: "c" },
      { "PATCH /issues/PROJ-1": updated },
    );
    expect(run.isError, run.text).toBe(false);
  });

  it("更新項目が 1 つもなければ argument_error（Backlog を呼ばない）", async () => {
    for (const args of [
      { issue_key: "PROJ-1" },
      { issue_key: "PROJ-1", category_ids: "", due_date: "", notified_user_ids: "" },
    ]) {
      const run = await callTool("logbutler_issue_update", args, {});
      expect(run.json.error.code).toBe("argument_error");
      expect(run.json.error.message).toContain("at least one field");
      expect(run.calls).toEqual([]);
    }
  });

  it("入力が不正なら argument_error", async () => {
    for (const bad of [{ due_date: "x" }, { version_ids: "a" }, { status_id: 1.5 }]) {
      const run = await callTool("logbutler_issue_update", { issue_key: "PROJ-1", ...bad }, {});
      expect(run.json.error.code, JSON.stringify(bad)).toBe("argument_error");
      expect(run.calls, JSON.stringify(bad)).toEqual([]);
    }
  });

  describe("engagement", () => {
    const yaml = `schema_version: 1\nproject:\n  key: PROJ\nengagements:\n  - name: 顧客A\n    lead: 山田\n    initiative: 運用保守\n`;
    const rule = {
      id: 100,
      issueKey: "PROJ-1",
      issueType: { name: "規約" },
      description: `\`\`\`yaml\n${yaml}\`\`\`\n`,
    };
    const respond = (extra: Record<string, unknown> = {}) => ({
      "GET /projects/PROJ": { id: 10 },
      "GET /projects/PROJ/issueTypes": [
        { id: 10, name: "規約" },
        { id: 11, name: "案件" },
      ],
      "GET /issues": (call: { url: string }) =>
        new URL(call.url).searchParams.get("issueTypeId[]") === "10"
          ? [rule]
          : [{ id: 101, summary: "[案件] 顧客A", issueType: { name: "案件" } }],
      "GET /projects/PROJ/categories": [{ id: 20, name: "顧客A" }],
      "PATCH /issues/PROJ-5": updated,
      ...extra,
    });

    it("課題キーの接頭辞からプロジェクトを決め、カテゴリと親課題を補完する", async () => {
      const run = await callTool(
        "logbutler_issue_update",
        { issue_key: "PROJ-5", engagement: "顧客A" },
        respond(),
      );
      expect(run.isError, run.text).toBe(false);
      expect(run.calls[0]).toBe("GET /projects/PROJ");
      expect(formPairs(run.recorded.at(-1))).toEqual(["categoryId[]=20", "parentIssueId=101"]);
    });

    it("数値の課題 ID なら GET /issues/{id} で課題キーからプロジェクトを決める", async () => {
      const run = await callTool(
        "logbutler_issue_update",
        { issue_key: "123", engagement: "顧客A" },
        respond({
          "GET /issues/123": { id: 123, issueKey: "PROJ-5" },
          "PATCH /issues/123": updated,
        }),
      );
      expect(run.isError, run.text).toBe(false);
      expect(run.calls[0]).toBe("GET /issues/123");
      expect(run.calls.at(-1)).toBe("PATCH /issues/123");
    });

    it("明示した parent_issue_id=0 は上書きしない（解除のまま）", async () => {
      const run = await callTool(
        "logbutler_issue_update",
        { issue_key: "PROJ-5", engagement: "顧客A", parent_issue_id: 0 },
        respond(),
      );
      expect(formPairs(run.recorded.at(-1))).toEqual(["categoryId[]=20", "parentIssueId="]);
    });
  });
});

describe("issue_comment_add / issue_comment_update", () => {
  const comment = { id: 5, content: "c" };

  it("add: POST /issues/{key}/comments に content と notifiedUserId[]", async () => {
    const run = await callTool(
      "logbutler_issue_comment_add",
      { issue_key: "PROJ-1", content: "コメント", notified_user_ids: "1,2" },
      { "POST /issues/PROJ-1/comments": comment },
    );
    expect(run.isError, run.text).toBe(false);
    expect(run.json).toEqual(comment);
    expect(formPairs(run.recorded[0])).toEqual([
      "content=コメント",
      "notifiedUserId[]=1",
      "notifiedUserId[]=2",
    ]);
  });

  it("add / update: content が空なら別名 body を使う。どちらも空なら argument_error", async () => {
    const add = await callTool(
      "logbutler_issue_comment_add",
      { issue_key: "PROJ-1", content: "", body: "別名" },
      { "POST /issues/PROJ-1/comments": comment },
    );
    expect(formPairs(add.recorded[0])).toEqual(["content=別名"]);
    const upd = await callTool(
      "logbutler_issue_comment_update",
      { issue_key: "PROJ-1", comment_id: 5, body: "別名" },
      { "PATCH /issues/PROJ-1/comments/5": comment },
    );
    expect(formPairs(upd.recorded[0])).toEqual(["content=別名"]);

    for (const tool of ["logbutler_issue_comment_add", "logbutler_issue_comment_update"]) {
      const run = await callTool(tool, { issue_key: "PROJ-1", comment_id: 5, content: "" }, {});
      expect(run.json.error.code).toBe("argument_error");
      expect(run.json.error.message).toContain("content (or body)");
      expect(run.calls).toEqual([]);
    }
  });

  it("update: PATCH /issues/{key}/comments/{id}。comment_id が 0 なら argument_error", async () => {
    const run = await callTool(
      "logbutler_issue_comment_update",
      { issue_key: "PROJ-1", comment_id: 5, content: "新" },
      { "PATCH /issues/PROJ-1/comments/5": comment },
    );
    expect(run.calls).toEqual(["PATCH /issues/PROJ-1/comments/5"]);
    expect(run.json).toEqual(comment);
    const zero = await callTool(
      "logbutler_issue_comment_update",
      { issue_key: "PROJ-1", comment_id: 0, content: "新" },
      {},
    );
    expect(zero.json.error.code).toBe("argument_error");
  });
});

describe("issue_related_add / issue_related_delete(未公開 API)", () => {
  it("add: POST /issues/{key}/relatedIssues に targetIssueId", async () => {
    const related = { id: 3, issueId: 1, targetIssueId: 77 };
    const run = await callTool(
      "logbutler_issue_related_add",
      { issue_key: "PROJ-1", target_issue_id: 77 },
      { "POST /issues/PROJ-1/relatedIssues": related },
    );
    expect(run.json).toEqual(related);
    expect(formPairs(run.recorded[0])).toEqual(["targetIssueId=77"]);
    const zero = await callTool(
      "logbutler_issue_related_add",
      { issue_key: "PROJ-1", target_issue_id: 0 },
      {},
    );
    expect(zero.json.error.code).toBe("argument_error");
  });

  it("delete: DELETE /issues/{key}/relatedIssues/{id}。本文があればそれを返す", async () => {
    const related = { id: 3 };
    const run = await callTool(
      "logbutler_issue_related_delete",
      { issue_key: "PROJ-1", related_issue_id: 3 },
      { "DELETE /issues/PROJ-1/relatedIssues/3": related },
    );
    expect(run.calls).toEqual(["DELETE /issues/PROJ-1/relatedIssues/3"]);
    expect(run.recorded[0]?.body).toBe("");
    expect(run.json).toEqual(related);
  });

  it("delete: 204・空本文でも成功し {result: ok} を返す", async () => {
    for (const res of [noContent, () => new Response("", { status: 200 })]) {
      const run = await callTool(
        "logbutler_issue_related_delete",
        { issue_key: "PROJ-1", related_issue_id: 3 },
        { "DELETE /issues/PROJ-1/relatedIssues/3": res },
      );
      expect(run.isError, run.text).toBe(false);
      expect(run.json).toEqual({ result: "ok" });
    }
  });
});
