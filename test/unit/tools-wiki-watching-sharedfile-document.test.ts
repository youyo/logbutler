import { describe, expect, it } from "vitest";
import { callTool, expectTool } from "../helpers/tool-call";

describe("wiki", () => {
  const page = {
    id: 100,
    projectId: 10,
    name: "Home",
    content: "# hi",
    tags: [{ id: 1, name: "tag" }],
    attachments: [],
    sharedFiles: [],
    stars: [],
    createdUser: { id: 1, userId: "alice", name: "Alice" },
    created: "2026-01-01T00:00:00Z",
    updatedUser: { id: 1, userId: "alice", name: "Alice" },
    updated: "2026-01-02T00:00:00Z",
  };

  it("wiki_list: project_key を projectIdOrKey に、keyword は任意", async () => {
    await expectTool({
      tool: "logbutler_wiki_list",
      args: { project_key: "PROJ" },
      respond: { "GET /wikis": [page] },
      calls: ["GET /wikis?projectIdOrKey=PROJ"],
    });
    await expectTool({
      tool: "logbutler_wiki_list",
      args: { project_key: "PROJ", keyword: "設計" },
      respond: { "GET /wikis": [page] },
      calls: ["GET /wikis?keyword=設計&projectIdOrKey=PROJ"],
    });
  });

  it("wiki_get: GET /wikis/{id}", async () => {
    await expectTool({
      tool: "logbutler_wiki_get",
      args: { wiki_id: 100 },
      respond: { "GET /wikis/100": page },
      calls: ["GET /wikis/100"],
    });
  });

  it("wiki_count: GET /wikis/count?projectIdOrKey= の {count} をそのまま返す", async () => {
    await expectTool({
      tool: "logbutler_wiki_count",
      args: { project_key: "PROJ" },
      respond: { "GET /wikis/count": { count: 12 } },
      calls: ["GET /wikis/count?projectIdOrKey=PROJ"],
    });
  });

  it("wiki_tags: GET /wikis/tags", async () => {
    await expectTool({
      tool: "logbutler_wiki_tags",
      args: { project_key: "PROJ" },
      respond: { "GET /wikis/tags": [{ id: 1, name: "tag" }] },
      calls: ["GET /wikis/tags?projectIdOrKey=PROJ"],
    });
  });

  it("wiki_history: min_id / max_id / count / order をクエリにする", async () => {
    const body = [
      {
        pageId: 100,
        version: 2,
        name: "Home",
        content: "x",
        createdUser: { id: 1 },
        created: "2026-01-01T00:00:00Z",
      },
    ];
    await expectTool({
      tool: "logbutler_wiki_history",
      args: { wiki_id: 100 },
      respond: { "GET /wikis/100/history": body },
      calls: ["GET /wikis/100/history"],
    });
    await expectTool({
      tool: "logbutler_wiki_history",
      args: { wiki_id: 100, min_id: 5, max_id: 50, count: 30, order: "asc" },
      respond: { "GET /wikis/100/history": body },
      calls: ["GET /wikis/100/history?count=30&maxId=50&minId=5&order=asc"],
    });
  });

  it("wiki_history: 0 以下の min_id / max_id は送らない(logvalet と同じ)", async () => {
    await expectTool({
      tool: "logbutler_wiki_history",
      args: { wiki_id: 100, min_id: 0, max_id: 0 },
      respond: { "GET /wikis/100/history": [] },
      calls: ["GET /wikis/100/history"],
    });
  });

  it("wiki_history: count は 1〜100(説明文にある)。範囲外は argument_error", async () => {
    for (const count of [0, 101]) {
      const run = await callTool("logbutler_wiki_history", { wiki_id: 100, count }, {});
      expect(run.json.error.code).toBe("argument_error");
      expect(run.calls).toEqual([]);
    }
  });

  it("wiki_stars / wiki_attachment_list / wiki_sharedfile_list", async () => {
    await expectTool({
      tool: "logbutler_wiki_stars",
      args: { wiki_id: 100 },
      respond: {
        "GET /wikis/100/stars": [
          { id: 1, comment: null, url: "u", presenter: { id: 1 }, created: "t" },
        ],
      },
      calls: ["GET /wikis/100/stars"],
    });
    await expectTool({
      tool: "logbutler_wiki_attachment_list",
      args: { wiki_id: 100 },
      respond: {
        "GET /wikis/100/attachments": [
          { id: 1, name: "a.png", size: 10, createdUser: { id: 1 }, created: "t" },
        ],
      },
      calls: ["GET /wikis/100/attachments"],
    });
    await expectTool({
      tool: "logbutler_wiki_sharedfile_list",
      args: { wiki_id: 100 },
      respond: {
        "GET /wikis/100/sharedFiles": [
          { id: 1, projectId: 10, type: "file", dir: "/", name: "a.txt", size: 3 },
        ],
      },
      calls: ["GET /wikis/100/sharedFiles"],
    });
  });

  it("wiki_id が数値でない(文字列)と argument_error", async () => {
    const run = await callTool("logbutler_wiki_get", { wiki_id: "100" }, {});
    expect(run.isError).toBe(true);
    expect(run.json.error.code).toBe("argument_error");
  });
});

describe("watching", () => {
  const watching = {
    id: 9,
    resourceAlreadyRead: false,
    note: "メモ",
    type: "issue",
    issue: { id: 1, issueKey: "PROJ-1", summary: "s" },
    lastContentUpdated: "2026-01-01T00:00:00Z",
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
  };

  it("watching_list: 数値の user_id は /users/{id}/watchings(Backlog は呼ばずに)", async () => {
    await expectTool({
      tool: "logbutler_watching_list",
      args: { user_id: "12345" },
      respond: { "GET /users/12345/watchings": [watching] },
      calls: ["GET /users/12345/watchings"],
    });
  });

  it("watching_list: me は GET /users/myself で ID を引いてから呼ぶ", async () => {
    await expectTool({
      tool: "logbutler_watching_list",
      args: { user_id: "me" },
      respond: {
        "GET /users/myself": { id: 42, userId: "alice", name: "Alice" },
        "GET /users/42/watchings": [watching],
      },
      calls: ["GET /users/myself", "GET /users/42/watchings"],
    });
  });

  it("watching_list: count / offset / order / sort をクエリにする", async () => {
    await expectTool({
      tool: "logbutler_watching_list",
      args: { user_id: "7", count: 100, offset: 20, order: "asc", sort: "issueUpdated" },
      respond: { "GET /users/7/watchings": [] },
      calls: ["GET /users/7/watchings?count=100&offset=20&order=asc&sort=issueUpdated"],
    });
  });

  it("watching_list: count は 1〜100(説明文に max 100)。user_id が me でも数値でもなければ argument_error", async () => {
    const tooMany = await callTool("logbutler_watching_list", { user_id: "7", count: 101 }, {});
    expect(tooMany.json.error.code).toBe("argument_error");
    const bad = await callTool("logbutler_watching_list", { user_id: "alice" }, {});
    expect(bad.json.error.code).toBe("argument_error");
    expect(bad.json.error.message).toContain("user_id");
    expect(bad.calls).toEqual([]);
  });

  it("watching_get: GET /watchings/{id}", async () => {
    await expectTool({
      tool: "logbutler_watching_get",
      args: { watching_id: 9 },
      respond: { "GET /watchings/9": watching },
      calls: ["GET /watchings/9"],
    });
  });

  it("watching_count: user_id は数値で、{count} をそのまま返す", async () => {
    await expectTool({
      tool: "logbutler_watching_count",
      args: { user_id: 7 },
      respond: { "GET /users/7/watchings/count": { count: 3 } },
      calls: ["GET /users/7/watchings/count"],
    });
  });
});

describe("shared_file", () => {
  const file = {
    id: 1,
    projectId: 10,
    type: "file",
    dir: "/docs/",
    name: "a.txt",
    size: 3,
    createdUser: { id: 1 },
    created: "t",
  };

  it("shared_file_list: path 省略はルート(末尾スラッシュ)。count / offset はクエリ", async () => {
    await expectTool({
      tool: "logbutler_shared_file_list",
      args: { project_key: "PROJ" },
      respond: { "GET /projects/PROJ/files/metadata/": [file] },
      calls: ["GET /projects/PROJ/files/metadata/"],
    });
    await expectTool({
      tool: "logbutler_shared_file_list",
      args: { project_key: "PROJ", count: 10, offset: 5 },
      respond: { "GET /projects/PROJ/files/metadata/": [file] },
      calls: ["GET /projects/PROJ/files/metadata/?count=10&offset=5"],
    });
  });

  it("shared_file_list: 先頭の / は落とす", async () => {
    await expectTool({
      tool: "logbutler_shared_file_list",
      args: { project_key: "PROJ", path: "/docs" },
      respond: { "GET /projects/PROJ/files/metadata/docs": [file] },
      calls: ["GET /projects/PROJ/files/metadata/docs"],
    });
  });

  it("shared_file_list: 意図した変更 — path はセグメントごとにエスケープする(スラッシュは区切りのまま)", async () => {
    await expectTool({
      tool: "logbutler_shared_file_list",
      args: { project_key: "PROJ", path: "設計 書/a#b?c/%2e" },
      respond: {
        "GET /projects/PROJ/files/metadata/%E8%A8%AD%E8%A8%88%20%E6%9B%B8/a%23b%3Fc/%252e": [file],
      },
      calls: ["GET /projects/PROJ/files/metadata/%E8%A8%AD%E8%A8%88%20%E6%9B%B8/a%23b%3Fc/%252e"],
    });
  });

  it("shared_file_list: ../ でパスを抜けられない(. と .. のセグメントは拒否)", async () => {
    for (const path of ["../x", "a/../b", "./a"]) {
      const run = await callTool("logbutler_shared_file_list", { project_key: "PROJ", path }, {});
      expect(run.isError).toBe(true);
      expect(run.json.error.code).toBe("argument_error");
      expect(run.calls).toEqual([]);
    }
  });
});

describe("document", () => {
  const doc = {
    id: "d1",
    projectId: 10,
    title: "仕様",
    plain: "text",
    json: "{}",
    statusId: 1,
    emoji: null,
    attachments: [],
    tags: [],
    createdUser: { id: 1 },
    created: "t",
    updatedUser: { id: 1 },
    updated: "t",
  };

  it("document_get: GET /documents/{id}(文字列 ID)", async () => {
    await expectTool({
      tool: "logbutler_document_get",
      args: { document_id: "d1" },
      respond: { "GET /documents/d1": doc },
      calls: ["GET /documents/d1"],
    });
  });

  it("document_list: project_key を projectId に解決してから、projectId[] と offset(常に送る)で呼ぶ", async () => {
    await expectTool({
      tool: "logbutler_document_list",
      args: { project_key: "PROJ" },
      respond: { "GET /projects/PROJ": { id: 10, projectKey: "PROJ" }, "GET /documents": [doc] },
      calls: ["GET /projects/PROJ", "GET /documents?offset=0&projectId[]=10"],
      output: [doc],
    });
  });

  it("document_list: count / offset", async () => {
    await expectTool({
      tool: "logbutler_document_list",
      args: { project_key: "PROJ", count: 5, offset: 10 },
      respond: { "GET /projects/PROJ": { id: 10 }, "GET /documents": [] },
      calls: ["GET /projects/PROJ", "GET /documents?count=5&offset=10&projectId[]=10"],
    });
  });

  it("document_tree: GET /documents/tree?projectIdOrKey=", async () => {
    await expectTool({
      tool: "logbutler_document_tree",
      args: { project_key: "PROJ" },
      respond: {
        "GET /documents/tree": {
          projectId: 10,
          activeTree: { id: "root", children: [] },
          trashTree: null,
        },
      },
      calls: ["GET /documents/tree?projectIdOrKey=PROJ"],
    });
  });
});
