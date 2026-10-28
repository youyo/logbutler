import { describe, expect, it } from "vitest";
import { callTool, expectTool } from "../helpers/tool-call";

// Backlog の生データ(camelCase)をそのまま返すこと、引数が API のパス・クエリになることを検証する。

describe("meta(project_key → /projects/{key}/...)", () => {
  const cases = [
    [
      "logbutler_meta_statuses",
      "statuses",
      [{ id: 1, projectId: 10, name: "未対応", displayOrder: 1000 }],
    ],
    [
      "logbutler_meta_issue_types",
      "issueTypes",
      [{ id: 2, projectId: 10, name: "バグ", templateSummary: "", displayOrder: 0 }],
    ],
    [
      "logbutler_meta_categories",
      "categories",
      [{ id: 3, projectId: 10, name: "API", displayOrder: 0 }],
    ],
    [
      "logbutler_meta_version",
      "versions",
      [{ id: 4, projectId: 10, name: "v1", releaseDueDate: null, archived: false }],
    ],
    [
      "logbutler_meta_custom_field",
      "customFields",
      [{ id: 5, typeId: 1, name: "顧客", applicableIssueTypes: [], required: false }],
    ],
  ] as const;

  for (const [tool, segment, body] of cases) {
    it(`${tool}: GET /projects/{key}/${segment} の結果を camelCase のまま返す`, async () => {
      await expectTool({
        tool,
        args: { project_key: "PROJ" },
        respond: { [`GET /projects/PROJ/${segment}`]: body },
        calls: [`GET /projects/PROJ/${segment}`],
      });
    });
  }

  it("project_key はパスの 1 セグメントとしてエスケープする", async () => {
    await expectTool({
      tool: "logbutler_meta_statuses",
      args: { project_key: "A/B" },
      respond: { "GET /projects/A%2FB/statuses": [] },
      calls: ["GET /projects/A%2FB/statuses"],
    });
  });

  it("project_key が空なら argument_error(Backlog は呼ばない)", async () => {
    const run = await callTool("logbutler_meta_statuses", { project_key: "" }, {});
    expect(run.isError).toBe(true);
    expect(run.json.error.code).toBe("argument_error");
    expect(run.calls).toEqual([]);
  });
});

describe("project", () => {
  it("project_get: GET /projects/{key}", async () => {
    await expectTool({
      tool: "logbutler_project_get",
      args: { project_key: "PROJ" },
      respond: {
        "GET /projects/PROJ": {
          id: 10,
          projectKey: "PROJ",
          name: "Project",
          chartEnabled: true,
          useResolvedForChart: false,
          subtaskingEnabled: false,
          projectLeaderCanEditProjectLeader: false,
          useWiki: true,
          useFileSharing: true,
          useWikiTreeView: true,
          useOriginalImageSizeAtWiki: false,
          textFormattingRule: "markdown",
          archived: false,
          displayOrder: 2147483646,
          useDevAttributes: true,
        },
      },
      calls: ["GET /projects/PROJ"],
    });
  });

  it("project_list: GET /projects(クエリなし)", async () => {
    await expectTool({
      tool: "logbutler_project_list",
      respond: { "GET /projects": [{ id: 10, projectKey: "PROJ", name: "P", archived: false }] },
      calls: ["GET /projects"],
    });
  });
});

describe("space", () => {
  it("space_info: GET /space", async () => {
    await expectTool({
      tool: "logbutler_space_info",
      respond: {
        "GET /space": {
          spaceKey: "example",
          name: "Example",
          ownerId: 1,
          lang: "ja",
          timezone: "Asia/Tokyo",
          reportSendTime: "08:00:00",
          textFormattingRule: "markdown",
          created: "2020-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        },
      },
      calls: ["GET /space"],
    });
  });

  it("space_disk_usage: GET /space/diskUsage", async () => {
    await expectTool({
      tool: "logbutler_space_disk_usage",
      respond: {
        "GET /space/diskUsage": {
          capacity: 1073741824,
          issue: 100,
          wiki: 200,
          file: 300,
          subversion: 0,
          git: 0,
          gitLFS: 0,
          details: [
            {
              projectId: 10,
              issue: 100,
              wiki: 200,
              document: 0,
              file: 300,
              subversion: 0,
              git: 0,
              gitLFS: 0,
            },
          ],
        },
      },
      calls: ["GET /space/diskUsage"],
    });
  });
});

describe("team", () => {
  const team = {
    id: 5,
    name: "開発",
    members: [{ id: 1, userId: "alice", name: "Alice", roleType: 1, mailAddress: "a@example.com" }],
    displayOrder: null,
    createdUser: { id: 1, userId: "alice", name: "Alice" },
    created: "2026-01-01T00:00:00Z",
    updatedUser: { id: 1, userId: "alice", name: "Alice" },
    updated: "2026-01-02T00:00:00Z",
  };

  it("team_list: 引数なしなら GET /teams(クエリなし)で、メンバー付きの生データを返す", async () => {
    await expectTool({
      tool: "logbutler_team_list",
      respond: { "GET /teams": [team] },
      calls: ["GET /teams"],
    });
  });

  it("team_list: count / offset をクエリにする", async () => {
    await expectTool({
      tool: "logbutler_team_list",
      args: { count: 50, offset: 100 },
      respond: { "GET /teams": [team] },
      calls: ["GET /teams?count=50&offset=100"],
    });
  });

  it("team_list: offset 0 は送らない(logvalet と同じ)", async () => {
    await expectTool({
      tool: "logbutler_team_list",
      args: { offset: 0 },
      respond: { "GET /teams": [] },
      calls: ["GET /teams"],
    });
  });

  it("team_list: no_members=true なら id と name だけにする", async () => {
    await expectTool({
      tool: "logbutler_team_list",
      args: { no_members: true },
      respond: { "GET /teams": [team] },
      calls: ["GET /teams"],
      output: [{ id: 5, name: "開発" }],
    });
  });

  it("team_list: no_members=false はそのまま", async () => {
    await expectTool({
      tool: "logbutler_team_list",
      args: { no_members: false },
      respond: { "GET /teams": [team] },
      calls: ["GET /teams"],
      output: [team],
    });
  });

  it("team_list: count は 1〜100(説明文に最大 100 とある)。範囲外は argument_error", async () => {
    for (const count of [0, 101, -1]) {
      const run = await callTool("logbutler_team_list", { count }, {});
      expect(run.isError).toBe(true);
      expect(run.json.error.code).toBe("argument_error");
      expect(run.json.error.message).toContain("count");
      expect(run.calls).toEqual([]);
    }
    await expectTool({
      tool: "logbutler_team_list",
      args: { count: 100 },
      respond: { "GET /teams": [] },
      calls: ["GET /teams?count=100"],
    });
  });

  it("team_get: GET /teams/{id}", async () => {
    await expectTool({
      tool: "logbutler_team_get",
      args: { team_id: 5 },
      respond: { "GET /teams/5": team },
      calls: ["GET /teams/5"],
    });
  });

  it("team_get: 整数でない team_id は argument_error", async () => {
    const run = await callTool("logbutler_team_get", { team_id: 1.5 }, {});
    expect(run.json.error.code).toBe("argument_error");
  });

  it("team_project: GET /projects/{key}/teams", async () => {
    await expectTool({
      tool: "logbutler_team_project",
      args: { project_key: "PROJ" },
      respond: { "GET /projects/PROJ/teams": [{ id: 5, name: "開発", displayOrder: null }] },
      calls: ["GET /projects/PROJ/teams"],
    });
  });
});

describe("user", () => {
  const user = {
    id: 7,
    userId: "bob",
    name: "Bob",
    roleType: 2,
    lang: "ja",
    nulabAccount: { nulabId: "n1", name: "Bob", uniqueId: "bob" },
    mailAddress: "b@example.com",
    lastLoginTime: "2026-10-01T00:00:00Z",
  };

  it("user_list: GET /users", async () => {
    await expectTool({
      tool: "logbutler_user_list",
      respond: { "GET /users": [user] },
      calls: ["GET /users"],
    });
  });

  it("user_get: 数値の ID は GET /users/{id}", async () => {
    await expectTool({
      tool: "logbutler_user_get",
      args: { user_id: "7" },
      respond: { "GET /users/7": user },
      calls: ["GET /users/7"],
    });
  });

  it("user_get: 文字列の ID(ユーザー ID)もそのままパスにする(エスケープあり)", async () => {
    await expectTool({
      tool: "logbutler_user_get",
      args: { user_id: "a b" },
      respond: { "GET /users/a%20b": user },
      calls: ["GET /users/a%20b"],
    });
  });

  it("user_get: 意図した変更 — me は GET /users/myself 1 回で引く", async () => {
    await expectTool({
      tool: "logbutler_user_get",
      args: { user_id: "me" },
      respond: { "GET /users/myself": user },
      calls: ["GET /users/myself"],
    });
  });

  it("エラー: Backlog の 404 は not_found の §9 エンベロープ(isError)", async () => {
    const run = await callTool(
      "logbutler_user_get",
      { user_id: "999" },
      {
        "GET /users/999": new Response(
          JSON.stringify({ errors: [{ message: "No such user.", code: 5 }] }),
          { status: 404 },
        ),
      },
    );
    expect(run.isError).toBe(true);
    expect(run.json).toEqual({
      schema_version: "1",
      error: {
        code: "not_found",
        message: "Backlog API error (HTTP 404, code=5): No such user.",
        retryable: false,
      },
    });
  });
});
