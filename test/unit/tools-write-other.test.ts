import { describe, expect, it } from "vitest";
import { starAdd } from "../../src/mcp/tools/star";
import { callTool, formPairs } from "../helpers/tool-call";

const noContent = () => new Response(null, { status: 204 });

describe("star_add", () => {
  it("注釈: 同じ対象に 2 回付けるとスターが 2 個になる(実 Backlog で確認)ので idempotentHint は false。他は書き込み(非破壊)のまま", () => {
    expect(starAdd.annotations).toEqual({
      title: "スター追加",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  const cases: [string, number, string][] = [
    ["issue_id", 1, "issueId=1"],
    ["comment_id", 2, "commentId=2"],
    ["wiki_id", 3, "wikiId=3"],
    ["pull_request_id", 4, "pullRequestId=4"],
    ["pull_request_comment_id", 5, "pullRequestCommentId=5"],
  ];
  for (const [arg, id, pair] of cases) {
    it(`${arg} だけ: POST /stars に ${pair}。204 は {result: ok}`, async () => {
      const run = await callTool("logbutler_star_add", { [arg]: id }, { "POST /stars": noContent });
      expect(run.isError, run.text).toBe(false);
      expect(run.calls).toEqual(["POST /stars"]);
      expect(formPairs(run.recorded[0])).toEqual([pair]);
      expect(run.json).toEqual({ result: "ok" });
    });
  }

  it("ちょうど 1 つ: 0 個・2 個以上は argument_error。値が 0 のものは指定なしとみなす", async () => {
    for (const args of [
      {},
      { issue_id: 0 },
      { issue_id: 1, wiki_id: 2 },
      { comment_id: 1, wiki_id: 2, issue_id: 3 },
    ]) {
      const run = await callTool("logbutler_star_add", args, {});
      expect(run.json.error.code, JSON.stringify(args)).toBe("argument_error");
      expect(run.calls).toEqual([]);
    }
    const run = await callTool(
      "logbutler_star_add",
      { issue_id: 0, wiki_id: 9 },
      { "POST /stars": noContent },
    );
    expect(formPairs(run.recorded[0])).toEqual(["wikiId=9"]);
  });
});

describe("watching_*", () => {
  const watching = { id: 5, resourceAlreadyRead: false, note: "n", type: "issue" };

  it("add: POST /watchings に issueIdOrKey と note（note は空なら送らない）", async () => {
    const run = await callTool(
      "logbutler_watching_add",
      { issue_id_or_key: "PROJ-1", note: "後で見る" },
      { "POST /watchings": watching },
    );
    expect(run.json).toEqual(watching);
    expect(formPairs(run.recorded[0])).toEqual(["issueIdOrKey=PROJ-1", "note=後で見る"]);
    const bare = await callTool(
      "logbutler_watching_add",
      { issue_id_or_key: "PROJ-1" },
      { "POST /watchings": watching },
    );
    expect(formPairs(bare.recorded[0])).toEqual(["issueIdOrKey=PROJ-1"]);
    const empty = await callTool("logbutler_watching_add", { issue_id_or_key: "" }, {});
    expect(empty.json.error.code).toBe("argument_error");
  });

  it("update: PATCH /watchings/{id} に note（空文字も送る）", async () => {
    const run = await callTool(
      "logbutler_watching_update",
      { watching_id: 5, note: "" },
      { "PATCH /watchings/5": watching },
    );
    expect(run.calls).toEqual(["PATCH /watchings/5"]);
    expect(run.recorded[0]?.body).toBe("note=");
    expect(run.json).toEqual(watching);
    const zero = await callTool("logbutler_watching_update", { watching_id: 0, note: "n" }, {});
    expect(zero.json.error.code).toBe("argument_error");
  });

  it("mark_as_read: 本文なしの POST /watchings/{id}/markAsRead。204 は {result: ok}", async () => {
    const run = await callTool(
      "logbutler_watching_mark_as_read",
      { watching_id: 5 },
      { "POST /watchings/5/markAsRead": noContent },
    );
    expect(run.calls).toEqual(["POST /watchings/5/markAsRead"]);
    expect(run.recorded[0]?.body).toBe("");
    expect(run.json).toEqual({ result: "ok" });
  });

  it("delete: DELETE /watchings/{id}。削除されたウォッチを返す。watching_id が 0 なら argument_error", async () => {
    const run = await callTool(
      "logbutler_watching_delete",
      { watching_id: 5 },
      { "DELETE /watchings/5": watching },
    );
    expect(run.calls).toEqual(["DELETE /watchings/5"]);
    expect(run.json).toEqual(watching);
    const zero = await callTool("logbutler_watching_delete", { watching_id: 0 }, {});
    expect(zero.json.error.code).toBe("argument_error");
    expect(zero.calls).toEqual([]);
  });
});

describe("issue_attachment_delete", () => {
  it("DELETE /issues/{key}/attachments/{id}。削除された添付を返す", async () => {
    const att = { id: 7, name: "a.png", size: 3 };
    const run = await callTool(
      "logbutler_issue_attachment_delete",
      { issue_key: "PROJ-1", attachment_id: 7 },
      { "DELETE /issues/PROJ-1/attachments/7": att },
    );
    expect(run.calls).toEqual(["DELETE /issues/PROJ-1/attachments/7"]);
    expect(run.json).toEqual(att);
    const zero = await callTool(
      "logbutler_issue_attachment_delete",
      { issue_key: "PROJ-1", attachment_id: 0 },
      {},
    );
    expect(zero.json.error.code).toBe("argument_error");
  });
});

describe("document_create", () => {
  const doc = { id: "d1", title: "T" };
  it("POST /documents に projectId・title・content（parent_id は指定したときだけ parentId）", async () => {
    const run = await callTool(
      "logbutler_document_create",
      { project_id: 10, title: "T", content: "# 本文", parent_id: "abc" },
      { "POST /documents": doc },
    );
    expect(run.json).toEqual(doc);
    expect(formPairs(run.recorded[0])).toEqual([
      "content=# 本文",
      "parentId=abc",
      "projectId=10",
      "title=T",
    ]);
    const bare = await callTool(
      "logbutler_document_create",
      { project_id: 10, title: "T", content: "c", parent_id: "" },
      { "POST /documents": doc },
    );
    expect(formPairs(bare.recorded[0])).toEqual(["content=c", "projectId=10", "title=T"]);
  });

  it("必須が欠ける・空なら argument_error", async () => {
    for (const args of [
      { project_id: 0, title: "T", content: "c" },
      { project_id: 10, title: "", content: "c" },
      { project_id: 10, title: "T", content: "" },
      { title: "T", content: "c" },
    ]) {
      const run = await callTool("logbutler_document_create", args, {});
      expect(run.json.error.code, JSON.stringify(args)).toBe("argument_error");
      expect(run.calls).toEqual([]);
    }
  });
});
