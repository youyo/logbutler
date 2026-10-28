/**
 * M06: Nulab 公式 MCP から取り込んだ 3 ツール(notification_list / notification_count / project_users)。
 * 引数 → Backlog API の写像と、生データ(camelCase)をそのまま返すことを検証する。
 */
import { describe, expect, it } from "vitest";
import { callTool, expectTool } from "../helpers/tool-call";

const notification = {
  id: 1,
  alreadyRead: false,
  reason: 2,
  resourceAlreadyRead: false,
  project: { id: 10, projectKey: "PROJ", name: "P" },
  issue: { id: 100, issueKey: "PROJ-1", summary: "s" },
  sender: { id: 5, userId: "bob", name: "Bob" },
  created: "2026-10-01T00:00:00Z",
};

describe("logbutler_notification_list", () => {
  it("引数なし: GET /notifications(クエリなし)の生データを返す", async () => {
    await expectTool({
      tool: "logbutler_notification_list",
      respond: { "GET /notifications": [notification] },
      calls: ["GET /notifications"],
    });
  });

  it("min_id / max_id / count / order は minId / maxId / count / order になる", async () => {
    await expectTool({
      tool: "logbutler_notification_list",
      args: { min_id: 5, max_id: 99, count: 30, order: "asc" },
      respond: { "GET /notifications": [notification] },
      calls: ["GET /notifications?count=30&maxId=99&minId=5&order=asc"],
    });
  });

  it("count は 1〜100。範囲外は argument_error で Backlog を呼ばない", async () => {
    for (const count of [0, 101, -1]) {
      const run = await callTool("logbutler_notification_list", { count }, {});
      expect(run.isError, String(count)).toBe(true);
      expect(run.json.error.code).toBe("argument_error");
      expect(run.calls).toEqual([]);
    }
  });

  it("order は asc / desc だけ。それ以外は argument_error", async () => {
    const run = await callTool("logbutler_notification_list", { order: "up" }, {});
    expect(run.isError).toBe(true);
    expect(run.json.error.code).toBe("argument_error");
    expect(run.calls).toEqual([]);
  });

  it("読み取りだけ: 既読化(markAsRead)など GET 以外を呼ばない", async () => {
    const run = await callTool(
      "logbutler_notification_list",
      { count: 5 },
      { "GET /notifications": [notification] },
    );
    expect(run.recorded.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("logbutler_notification_count", () => {
  it("引数なし: GET /notifications/count(クエリなし)。{count: n} を返す", async () => {
    await expectTool({
      tool: "logbutler_notification_count",
      respond: { "GET /notifications/count": { count: 3 } },
      calls: ["GET /notifications/count"],
      output: { count: 3 },
    });
  });

  it("already_read / resource_already_read は alreadyRead / resourceAlreadyRead(false も送る)", async () => {
    await expectTool({
      tool: "logbutler_notification_count",
      args: { already_read: false, resource_already_read: true },
      respond: { "GET /notifications/count": { count: 0 } },
      calls: ["GET /notifications/count?alreadyRead=false&resourceAlreadyRead=true"],
      output: { count: 0 },
    });
  });

  it("未指定のフラグは送らない", async () => {
    await expectTool({
      tool: "logbutler_notification_count",
      args: { already_read: true },
      respond: { "GET /notifications/count": { count: 9 } },
      calls: ["GET /notifications/count?alreadyRead=true"],
      output: { count: 9 },
    });
  });
});

describe("logbutler_project_users", () => {
  const users = [
    {
      id: 1,
      userId: "alice",
      name: "Alice",
      roleType: 1,
      lang: "ja",
      mailAddress: "a@example.com",
    },
  ];

  it("project_key は必須: GET /projects/{key}/users の生データを返す", async () => {
    await expectTool({
      tool: "logbutler_project_users",
      args: { project_key: "PROJ" },
      respond: { "GET /projects/PROJ/users": users },
      calls: ["GET /projects/PROJ/users"],
    });
  });

  it("exclude_group_members は excludeGroupMembers(false も送る)", async () => {
    await expectTool({
      tool: "logbutler_project_users",
      args: { project_key: "PROJ", exclude_group_members: true },
      respond: { "GET /projects/PROJ/users": users },
      calls: ["GET /projects/PROJ/users?excludeGroupMembers=true"],
    });
    await expectTool({
      tool: "logbutler_project_users",
      args: { project_key: "PROJ", exclude_group_members: false },
      respond: { "GET /projects/PROJ/users": users },
      calls: ["GET /projects/PROJ/users?excludeGroupMembers=false"],
    });
  });

  it("project_key はパスの 1 セグメントとしてエスケープし、空なら argument_error", async () => {
    await expectTool({
      tool: "logbutler_project_users",
      args: { project_key: "A/B" },
      respond: { "GET /projects/A%2FB/users": [] },
      calls: ["GET /projects/A%2FB/users"],
    });
    const run = await callTool("logbutler_project_users", { project_key: "" }, {});
    expect(run.isError).toBe(true);
    expect(run.json.error.code).toBe("argument_error");
    expect(run.calls).toEqual([]);
  });
});
