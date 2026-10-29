import { describe, expect, it } from "vitest";
import { BacklogApiError } from "../../src/backlog/errors";
import { jsonResponse } from "../helpers/mock-fetch";
import { callTool } from "../helpers/tool-call";

const KEY = (n: number | string) => `err.editIssue.parentChildIssue.${n}`;
const backlog400 = (message: string, code = 7) =>
  jsonResponse({ errors: [{ message, code }] }, 400);

describe("親子関係の制約違反(HTTP 400・code=7・err.editIssue.parentChildIssue.N)は argument_error になる", () => {
  it.each([
    [1, "自分自身"],
    [3, "子課題を親課題にできません"],
    [5, "子を持つ課題を子課題にできません"],
    [6, "3 階層まで"],
  ])("N=%i: 理由と元のキーを含む argument_error(retryable=false)", (n, reason) => {
    const e = new BacklogApiError(400, { backlogCode: 7, backlogMessage: KEY(n) });
    expect(e.code).toBe("argument_error");
    expect(e.retryable).toBe(false);
    expect(e.message).toContain(reason);
    expect(e.message).toContain(KEY(n));
    expect(e.message).not.toContain("Backlog API error");
  });

  it.each([3, 5, 6])(
    "N=%i: grandchildIssueEnabled を logbutler_project_get で確認できると案内する",
    (n) => {
      const e = new BacklogApiError(400, { backlogCode: 7, backlogMessage: KEY(n) });
      expect(e.message).toContain("logbutler_project_get");
      expect(e.message).toContain("grandchildIssueEnabled");
    },
  );

  it("未知の番号は一般的な文と元のキー", () => {
    const e = new BacklogApiError(400, { backlogCode: 7, backlogMessage: KEY(2) });
    expect(e.code).toBe("argument_error");
    expect(e.message).toContain("親子関係の制約に違反");
    expect(e.message).toContain(KEY(2));
  });

  it("status・code・message のどれかが違えば従来どおり(api_error)", () => {
    for (const e of [
      new BacklogApiError(400, { backlogCode: 8, backlogMessage: KEY(6) }),
      new BacklogApiError(500, { backlogCode: 7, backlogMessage: KEY(6) }),
      new BacklogApiError(400, { backlogCode: 7, backlogMessage: "err.editIssue.other.6" }),
      new BacklogApiError(400, { backlogCode: 7, backlogMessage: `${KEY(6)}x` }),
      new BacklogApiError(400, { backlogCode: 7 }),
    ]) {
      expect(e.code).toBe("api_error");
      expect(e.message).toContain("Backlog API error");
    }
  });

  it("issue_update の応答でも argument_error のエンベロープになる", async () => {
    const run = await callTool(
      "logbutler_issue_update",
      { issue_key: "PROJ-1", parent_issue_id: 9 },
      { "PATCH /issues/PROJ-1": () => backlog400(KEY(6)) },
    );
    expect(run.isError).toBe(true);
    expect(run.json.error.code).toBe("argument_error");
    expect(run.json.error.retryable).toBe(false);
    expect(run.json.error.message).toContain(KEY(6));
    expect(run.json.error.message).toContain("grandchildIssueEnabled");
  });

  it("issue_create の応答でも argument_error のエンベロープになる", async () => {
    const run = await callTool(
      "logbutler_issue_create",
      { project_key: "PROJ", summary: "s", issue_type_id: 2, priority_id: 3, parent_issue_id: 9 },
      {
        "GET /projects/PROJ": { id: 10 },
        "POST /issues": () => backlog400(KEY(3)),
      },
    );
    expect(run.isError).toBe(true);
    expect(run.json.error.code).toBe("argument_error");
    expect(run.json.error.message).toContain(KEY(3));
  });
});
