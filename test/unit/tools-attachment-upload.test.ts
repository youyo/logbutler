import { describe, expect, it } from "vitest";
import { jsonResponse } from "../helpers/mock-fetch";
import { callTool, formPairs } from "../helpers/tool-call";

const MAX = 4 * 1024 * 1024;
const uploaded = { id: 77, name: "hello.txt", size: 5 };
const issue = { id: 1, issueKey: "PROJ-1" };
const respond = {
  "POST /space/attachment": uploaded,
  "PATCH /issues/PROJ-1": issue,
};
const b64 = (text: string) => btoa(text);
const b64OfSize = (n: number) => btoa("a".repeat(n));

describe("issue_attachment_upload(base64 のみ)", () => {
  it("multipart（field file）で一時領域へ送り、attachmentId[] で課題を更新する。返却は課題", async () => {
    const run = await callTool(
      "logbutler_issue_attachment_upload",
      { issue_key: "PROJ-1", file_name: "hello.txt", file_content_base64: b64("hello") },
      respond,
    );
    expect(run.isError, run.text).toBe(false);
    expect(run.calls).toEqual(["POST /space/attachment", "PATCH /issues/PROJ-1"]);
    expect(run.json).toEqual(issue);
    const upload = run.recorded[0];
    expect(upload?.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(upload?.body).toContain('name="file"; filename="hello.txt"');
    expect(upload?.body).toContain("\r\n\r\nhello\r\n");
    expect(formPairs(run.recorded[1])).toEqual(["attachmentId[]=77"]);
  });

  it("file_name はベース名にする（/ と \\ の両方）", async () => {
    for (const [given, expected] of [
      ["../../etc/passwd.txt", "passwd.txt"],
      ["C:\\Users\\me\\a b.png", "a b.png"],
      ["dir/sub\\x.txt", "x.txt"],
      ["日本語.txt", "日本語.txt"],
    ]) {
      const run = await callTool(
        "logbutler_issue_attachment_upload",
        { issue_key: "PROJ-1", file_name: given, file_content_base64: b64("x") },
        respond,
      );
      expect(run.isError, run.text).toBe(false);
      expect(run.recorded[0]?.body, given).toContain(`filename="${expected}"`);
    }
  });

  it("mime_type は受け取るが送らない（参考情報）", async () => {
    const run = await callTool(
      "logbutler_issue_attachment_upload",
      {
        issue_key: "PROJ-1",
        file_name: "a.png",
        file_content_base64: b64("x"),
        mime_type: "image/png",
      },
      respond,
    );
    expect(run.isError, run.text).toBe(false);
    expect(run.recorded[0]?.body).not.toContain("image/png");
  });

  it("0 バイトのファイル（空の base64）も有効", async () => {
    const run = await callTool(
      "logbutler_issue_attachment_upload",
      { issue_key: "PROJ-1", file_name: "empty.txt", file_content_base64: "" },
      respond,
    );
    expect(run.isError, run.text).toBe(false);
    expect(run.calls).toEqual(["POST /space/attachment", "PATCH /issues/PROJ-1"]);
  });

  it("上限はデコード後の実サイズ: ちょうど 4 MiB は通り、4 MiB + 1 は argument_error（Backlog を呼ばない）", async () => {
    const ok = await callTool(
      "logbutler_issue_attachment_upload",
      { issue_key: "PROJ-1", file_name: "big.bin", file_content_base64: b64OfSize(MAX) },
      respond,
    );
    expect(ok.isError, ok.text.slice(0, 200)).toBe(false);
    expect(ok.calls).toEqual(["POST /space/attachment", "PATCH /issues/PROJ-1"]);

    const over = await callTool(
      "logbutler_issue_attachment_upload",
      { issue_key: "PROJ-1", file_name: "big.bin", file_content_base64: b64OfSize(MAX + 1) },
      respond,
    );
    expect(over.isError).toBe(true);
    expect(over.json.error.code).toBe("argument_error");
    expect(over.json.error.message).toContain("4194304");
    expect(over.calls).toEqual([]);
  });

  it("base64 長が桁違いに大きい入力はデコードせずに弾く", async () => {
    const run = await callTool(
      "logbutler_issue_attachment_upload",
      {
        issue_key: "PROJ-1",
        file_name: "x",
        file_content_base64: "A".repeat(Math.ceil(MAX / 3) * 4 * 1.25 + 4),
      },
      respond,
    );
    expect(run.json.error.code).toBe("argument_error");
    expect(run.calls).toEqual([]);
  });

  it("argument_error: base64 が不正、file_name がない・空、file_content_base64 がない、issue_key が空", async () => {
    const cases: Record<string, unknown>[] = [
      { issue_key: "PROJ-1", file_name: "a.txt", file_content_base64: "!!!not base64!!!" },
      { issue_key: "PROJ-1", file_content_base64: b64("x") },
      { issue_key: "PROJ-1", file_name: "", file_content_base64: b64("x") },
      { issue_key: "PROJ-1", file_name: "dir/", file_content_base64: b64("x") },
      { issue_key: "PROJ-1", file_name: "..", file_content_base64: b64("x") },
      { issue_key: "PROJ-1", file_name: "a.txt" },
      { issue_key: "PROJ-1" },
      { issue_key: "", file_name: "a.txt", file_content_base64: b64("x") },
    ];
    for (const args of cases) {
      const run = await callTool("logbutler_issue_attachment_upload", args, respond);
      expect(run.isError, JSON.stringify(args)).toBe(true);
      expect(run.json.error.code, JSON.stringify(args)).toBe("argument_error");
      expect(run.calls, JSON.stringify(args)).toEqual([]);
    }
  });

  it("file_paths はスキーマから削除した（渡しても無視されず、アップロードされない）", async () => {
    const run = await callTool(
      "logbutler_issue_attachment_upload",
      { issue_key: "PROJ-1", file_paths: "/etc/passwd" },
      respond,
    );
    expect(run.json.error.code).toBe("argument_error");
    expect(run.calls).toEqual([]);
  });

  it("一時領域への送信が失敗したら課題は更新しない", async () => {
    const run = await callTool(
      "logbutler_issue_attachment_upload",
      { issue_key: "PROJ-1", file_name: "a.txt", file_content_base64: b64("x") },
      {
        "POST /space/attachment": jsonResponse({ errors: [{ message: "bad", code: 1 }] }, 400),
        "PATCH /issues/PROJ-1": issue,
      },
    );
    expect(run.isError).toBe(true);
    expect(run.calls).toEqual(["POST /space/attachment"]);
  });
});
