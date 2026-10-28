import { describe, expect, it } from "vitest";
import { detectAmbiguities } from "../../src/analysis/ambiguity";
import type { BacklogIssue } from "../../src/analysis/issues";
import type { Conventions } from "../../src/conventions/load";

const NOW = new Date("2026-10-28T03:00:00Z");
const conventions = (over: Partial<Conventions> = {}): Conventions => ({
  schema_version: 1,
  project: { key: "P" },
  priority: { high: "h", normal: "n", low: "l" },
  close_policy: { low_untouched_days: 90 },
  statuses: null,
  issue_types: null,
  initiatives: [{ name: "運用保守" }],
  engagements: [{ name: "案件A", lead: "x", initiative: "運用保守" }],
  ...over,
});
const issue = (key: string, over: Partial<BacklogIssue> = {}): BacklogIssue => ({
  id: Number(key.split("-")[1]),
  issueKey: key,
  summary: `s ${key}`,
  issueType: { id: 1, name: "タスク" },
  category: [{ id: 1, name: "案件A" }],
  priority: { id: 3, name: "中" },
  updated: "2026-10-27T00:00:00Z",
  ...over,
});
const parent = (over: Partial<BacklogIssue> = {}): BacklogIssue =>
  issue("P-100", {
    summary: "[案件] 案件A",
    issueType: { id: 2, name: "案件" },
    assignee: { id: 1, name: "Lead" },
    dueDate: "2026-12-01T00:00:00Z",
    category: [],
    ...over,
  });
const detect = (c: Conventions, issues: BacklogIssue[], now = NOW) =>
  detectAmbiguities(c, issues, now);
const kinds = (r: ReturnType<typeof detectAmbiguities>) => r.map((a) => `${a.kind}:${a.target}`);

describe("detectAmbiguities(logvalet ambiguity.go の移植)", () => {
  it("案件カテゴリがちょうど 1 つなら明確。0 個は no_engagement、2 個以上は multiple_engagements", () => {
    const c = conventions({
      engagements: [
        { name: "案件A", lead: "x", initiative: "運用保守" },
        { name: "案件B", lead: "x", initiative: "運用保守" },
      ],
    });
    const parents = [parent(), parent({ issueKey: "P-101", summary: "[案件] 案件B" })];
    const r = detect(c, [
      issue("P-1"),
      issue("P-2", { category: [] }),
      issue("P-3", {
        category: [
          { id: 1, name: "案件A" },
          { id: 2, name: " 案件B " },
        ],
      }),
      issue("P-4", { category: [{ id: 9, name: "無関係" }] }),
      issue("P-5", {
        category: [
          { id: 1, name: "案件A" },
          { id: 1, name: "案件A" },
        ],
      }),
      ...parents,
    ]);
    expect(kinds(r)).toEqual([
      "no_engagement:P-2",
      "no_engagement:P-4",
      "multiple_engagements:P-3",
    ]);
    expect(r[2]).toEqual({
      kind: "multiple_engagements",
      target: "P-3",
      summary: "s P-3",
      detail: "案件カテゴリが 2 つ付いています",
    });
    expect(r[0]?.detail).toBe("案件カテゴリが付いていません");
  });

  it("種別「規約」「案件」の課題は no_engagement の対象にしない", () => {
    const r = detect(conventions(), [
      parent(),
      issue("P-1", { category: [], issueType: { id: 3, name: "規約" } }),
    ]);
    expect(r).toEqual([]);
  });

  it("案件ごとに親課題を確認する: 親がなければ missing_parent_issue、担当なしは missing_lead、期限なしは missing_due_date", () => {
    expect(kinds(detect(conventions(), []))).toEqual(["missing_parent_issue:案件A"]);
    const none = detect(conventions(), []);
    expect(none[0]).toEqual({
      kind: "missing_parent_issue",
      target: "案件A",
      summary: "[案件] 案件A",
      detail: "案件「案件A」に対応する親課題がありません",
    });
    const r = detect(conventions(), [parent({ assignee: null, dueDate: null })]);
    expect(kinds(r)).toEqual(["missing_lead:P-100", "missing_due_date:P-100"]);
  });

  it("親課題は種別「案件」で summary が `[案件] 名前` に完全一致するものだけ", () => {
    const r = detect(conventions(), [parent({ issueType: { id: 1, name: "タスク" } })]);
    expect(kinds(r)).toContain("missing_parent_issue:案件A");
  });

  it("unknown_initiative: 案件の initiative が定義されていない", () => {
    const r = detect(
      conventions({ engagements: [{ name: "案件A", lead: "x", initiative: "未定義" }] }),
      [parent()],
    );
    expect(r).toEqual([
      {
        kind: "unknown_initiative",
        target: "案件A",
        summary: "未定義",
        detail: "案件「案件A」のイニシアチブ「未定義」が定義されていません",
      },
    ]);
  });

  it("close_candidate: 優先度「低」で、更新が low_untouched_days を超えて古い(境界は含めない)", () => {
    const old = (days: number) => new Date(NOW.getTime() - days * 86400000).toISOString();
    const c = conventions();
    const at = (days: number, priority = "低") =>
      detect(
        c,
        [parent(), issue("P-1", { priority: { id: 4, name: priority }, updated: old(days) })],
        NOW,
      );
    expect(kinds(at(91))).toEqual(["close_candidate:P-1"]);
    expect(kinds(at(90))).toEqual([]);
    expect(kinds(at(91, "中"))).toEqual([]);
    expect(
      kinds(
        detect(
          conventions({ close_policy: { low_untouched_days: null } }),
          [parent(), issue("P-1", { priority: { id: 4, name: "低" }, updated: old(500) })],
          NOW,
        ),
      ),
    ).toEqual([]);
    expect(at(91)[0]?.detail).toBe("低優先度のまま長期間更新されていません");
  });

  it("並びは kind の順 → target → summary(安定)", () => {
    const c = conventions({
      engagements: [
        { name: "案件B", lead: "x", initiative: "未定義" },
        { name: "案件A", lead: "x", initiative: "未定義" },
      ],
    });
    const r = detect(c, [issue("P-9", { category: [] }), issue("P-10", { category: [] })]);
    expect(kinds(r)).toEqual([
      "no_engagement:P-10",
      "no_engagement:P-9",
      "missing_parent_issue:案件A",
      "missing_parent_issue:案件B",
      "unknown_initiative:案件A",
      "unknown_initiative:案件B",
    ]);
  });
});
