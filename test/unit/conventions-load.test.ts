import { describe, expect, it } from "vitest";
import {
  loadConventions,
  loadFromIssueDescription,
  RULE_ISSUE_TYPE,
} from "../../src/conventions/load";
import skeleton from "../fixtures/conventions_skeleton.yaml?raw";

const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("例外が投げられるはずだった");
};

describe("loadConventions(logvalet internal/conventions/load_test.go の入力を流用)", () => {
  it("最小の YAML: 未指定のリストは null、文字列は空、low_untouched_days は null", () => {
    const c = loadConventions("schema_version: 1\nproject:\n  key: FILE\n");
    expect(c).toEqual({
      schema_version: 1,
      project: { key: "FILE" },
      priority: { high: "", normal: "", low: "" },
      close_policy: { low_untouched_days: null },
      statuses: null,
      issue_types: null,
      initiatives: null,
      engagements: null,
    });
  });

  it("未知のフィールドはエラー(logvalet の KnownFields(true))", () => {
    const m = message(() =>
      loadConventions("schema_version: 1\nproject:\n  key: DEMO\n  typo: true\n"),
    );
    expect(m).toContain("typo");
    expect(() => loadConventions("schema_version: 1\nextra: 1\n")).toThrow(/extra/);
  });

  it("型が違う値・空の文書・壊れた YAML はエラー", () => {
    expect(() => loadConventions("schema_version: x\n")).toThrow(/schema_version/);
    expect(() => loadConventions("statuses: 5\n")).toThrow(/statuses/);
    expect(() => loadConventions("")).toThrow();
    expect(() => loadConventions("a: [1,\n")).toThrow();
  });

  it("logvalet の skeleton（YAML 見本）を読める", () => {
    const c = loadConventions(skeleton);
    expect(c.schema_version).toBe(1);
    expect(c.project).toEqual({ key: "SANDBOX", name: "Sandbox" });
    expect(c.priority.high).toBe("契約・SLA 上、他案件を止めてでも対応する");
    expect(c.close_policy.low_untouched_days).toBe(90);
    expect(c.statuses).toEqual([{ name: "レビュー中", color: "#e87758" }]);
    expect(c.issue_types?.map((t) => t.name)).toEqual([RULE_ISSUE_TYPE, "案件"]);
    expect(c.issue_types?.[1]?.template_description).toContain("## Context & Goals");
    expect(c.issue_types?.[1]?.template_description?.endsWith("\n")).toBe(true);
    expect(c.initiatives?.[0]?.name).toBe("運用保守");
    expect(c.engagements).toEqual([]);
  });

  it("案件の日付は YAML の日付型にせず文字列のまま", () => {
    const c = loadConventions(
      "engagements:\n  - name: 顧客A\n    lead: 山田\n    initiative: 運用保守\n    start_date: 2026-10-01\n    due_date: '2026-10-31'\n",
    );
    expect(c.engagements).toEqual([
      {
        name: "顧客A",
        lead: "山田",
        initiative: "運用保守",
        start_date: "2026-10-01",
        due_date: "2026-10-31",
      },
    ]);
  });
});

describe("loadFromIssueDescription", () => {
  it("YAML コードブロック 1 つ", () => {
    const d = "運用ガイド\n\n```yaml\nschema_version: 1\nproject:\n  key: ONE\n```\n";
    expect(loadFromIssueDescription(d).project.key).toBe("ONE");
  });
  it("ブロックがなければエラー", () => {
    expect(message(() => loadFromIssueDescription("運用ガイドのみ"))).toContain("yaml");
  });
  it("複数あれば最後のブロック", () => {
    const d =
      "```yaml\nschema_version: 1\nproject:\n  key: FIRST\n```\n\n```yaml\nschema_version: 1\nproject:\n  key: LAST\n```";
    expect(loadFromIssueDescription(d).project.key).toBe("LAST");
  });
  it("言語指定のないフェンスは対象にしない", () => {
    expect(() =>
      loadFromIssueDescription("```\nschema_version: 1\nproject:\n  key: NOPE\n```"),
    ).toThrow();
  });
  it("CRLF の説明欄でも読める（Backlog は CRLF で保存することがある）", () => {
    const d = "ガイド\r\n```yaml\r\nschema_version: 1\r\nproject:\r\n  key: CRLF\r\n```\r\n";
    expect(loadFromIssueDescription(d).project.key).toBe("CRLF");
  });
  it("閉じられていないブロックは無視する", () => {
    expect(() => loadFromIssueDescription("```yaml\nschema_version: 1\n")).toThrow();
  });
});
