import { describe, expect, it } from "vitest";
import {
  compareWithBaseline,
  formatCompareResult,
  fromLogvaletBaseline,
  type McpToolListing,
  normalizeTools,
} from "../helpers/baseline";

const tool = (over: Partial<McpToolListing> = {}): McpToolListing => ({
  name: "logbutler_issue_get",
  description: "Get issue details by issue key",
  inputSchema: {
    type: "object",
    properties: { issue_key: { type: "string" } },
    required: ["issue_key"],
  },
  annotations: { title: "課題詳細取得", readOnlyHint: true },
  ...over,
});

describe("normalizeTools", () => {
  it("名前でソートし、zod 由来の \\$schema と additionalProperties:false を落とし、required を補う", () => {
    const out = normalizeTools([
      tool({ name: "logbutler_b_x" }),
      tool({
        name: "logbutler_a_x",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      }),
    ]);
    expect(out.map((t) => t.name)).toEqual(["logbutler_a_x", "logbutler_b_x"]);
    expect(out[0]?.inputSchema).toEqual({ type: "object", properties: {}, required: [] });
  });

  it("キーの順序に依存しない(プロパティ名順に並べ替える)", () => {
    const a = normalizeTools([
      tool({
        inputSchema: {
          type: "object",
          properties: { b: { type: "string" }, a: { type: "string" } },
        },
      }),
    ]);
    const schema = a[0]?.inputSchema as { properties: Record<string, unknown> } | undefined;
    expect(Object.keys(schema?.properties ?? {})).toEqual(["a", "b"]);
  });
});

describe("fromLogvaletBaseline", () => {
  it("result.tools を取り出し、名前の logvalet_ を logbutler_ に置換する", () => {
    const tools = fromLogvaletBaseline({
      result: { tools: [{ ...tool(), name: "logvalet_issue_get" }] },
    });
    expect(tools.map((t) => t.name)).toEqual(["logbutler_issue_get"]);
  });
});

describe("compareWithBaseline", () => {
  it("同じなら差分なし", () => {
    expect(compareWithBaseline([tool()], [tool()])).toEqual({
      missing: [],
      extra: [],
      changed: [],
    });
  });

  it("欠けているツール・余分なツール・内容の違いを報告する", () => {
    const r = compareWithBaseline(
      [tool({ name: "logbutler_x_new" }), tool({ description: "changed" })],
      [tool(), tool({ name: "logbutler_y_old" })],
    );
    expect(r.missing).toEqual(["logbutler_y_old"]);
    expect(r.extra).toEqual(["logbutler_x_new"]);
    expect(r.changed).toMatchObject([{ name: "logbutler_issue_get", fields: ["description"] }]);
  });

  it("annotations と inputSchema の違いも検出する", () => {
    const r = compareWithBaseline(
      [
        tool({
          annotations: { title: "x" },
          inputSchema: { type: "object", properties: {}, required: [] },
        }),
      ],
      [tool()],
    );
    expect(r.changed).toMatchObject([
      { name: "logbutler_issue_get", fields: ["inputSchema", "annotations"] },
    ]);
  });

  it("許容リストにある差分は報告しない(理由つき)", () => {
    const r = compareWithBaseline([tool({ description: "changed" })], [tool()], {
      allowedChanges: [
        { tool: "logbutler_issue_get", fields: ["description"], reason: "説明を改善" },
      ],
    });
    expect(r.changed).toEqual([]);
  });

  it("only を指定すると、その名前のツールだけを比べる", () => {
    const r = compareWithBaseline(
      [tool(), tool({ name: "logbutler_z_other" })],
      [tool(), tool({ name: "logbutler_y_old" })],
      { only: ["logbutler_issue_get"] },
    );
    expect(r).toEqual({ missing: [], extra: [], changed: [] });
  });

  it("allowedMissing / allowedExtra は報告から外す", () => {
    const r = compareWithBaseline(
      [tool({ name: "logbutler_n_new" })],
      [tool({ name: "logbutler_o_old" })],
      {
        allowedMissing: ["logbutler_o_old"],
        allowedExtra: ["logbutler_n_new"],
      },
    );
    expect(r).toEqual({ missing: [], extra: [], changed: [] });
  });
});

describe("compareWithBaseline の診断(property 単位の差分)", () => {
  const withProps = (properties: Record<string, unknown>, required: string[] = []) =>
    tool({ inputSchema: { type: "object", properties, required } });

  it("description の差は期待値と実際の値を返す", () => {
    const r = compareWithBaseline(
      [tool({ description: "actual" })],
      [tool({ description: "expected" })],
    );
    expect(r.changed[0]?.diffs).toEqual([
      { field: "description", path: "", expected: "expected", actual: "actual" },
    ]);
  });

  it("inputSchema の差は property 単位のパスで返す(型の違い・minimum の混入・欠けた property)", () => {
    const r = compareWithBaseline(
      [withProps({ count: { type: "integer", minimum: 0 }, extra: { type: "string" } })],
      [withProps({ count: { type: "number" }, gone: { type: "string" } })],
    );
    const diffs = r.changed[0]?.diffs ?? [];
    expect(diffs).toContainEqual({
      field: "inputSchema",
      path: "properties.count.type",
      expected: "number",
      actual: "integer",
    });
    expect(diffs).toContainEqual({
      field: "inputSchema",
      path: "properties.count.minimum",
      expected: undefined,
      actual: 0,
    });
    expect(diffs).toContainEqual({
      field: "inputSchema",
      path: "properties.gone",
      expected: { type: "string" },
      actual: undefined,
    });
    expect(diffs).toContainEqual({
      field: "inputSchema",
      path: "properties.extra",
      expected: undefined,
      actual: { type: "string" },
    });
  });

  it("annotations の差も key 単位で返す", () => {
    const r = compareWithBaseline(
      [tool({ annotations: { title: "課題詳細取得", readOnlyHint: false } })],
      [tool()],
    );
    expect(r.changed[0]?.diffs).toEqual([
      { field: "annotations", path: "readOnlyHint", expected: true, actual: false },
    ]);
  });

  it("許容した差分は diffs にも出ない", () => {
    const r = compareWithBaseline([tool({ description: "changed" })], [tool()], {
      allowedChanges: [{ tool: "logbutler_issue_get", fields: ["description"], reason: "x" }],
    });
    expect(r.changed).toEqual([]);
  });

  it("required と enum は順序を無視して比べる(Go 版は辞書順、zod は定義順のため)", () => {
    const a = tool({
      inputSchema: {
        type: "object",
        properties: { k: { type: "string", enum: ["b", "a"] } },
        required: ["issue_key", "attachment_id"],
      },
    });
    const b = tool({
      inputSchema: {
        type: "object",
        properties: { k: { type: "string", enum: ["a", "b"] } },
        required: ["attachment_id", "issue_key"],
      },
    });
    expect(compareWithBaseline([a], [b])).toEqual({ missing: [], extra: [], changed: [] });
  });

  it("required の中身が違えば検出する(順序無視でも集合は比べる)", () => {
    const a = tool({ inputSchema: { type: "object", properties: {}, required: ["a"] } });
    const b = tool({ inputSchema: { type: "object", properties: {}, required: ["a", "b"] } });
    const r = compareWithBaseline([a], [b]);
    expect(r.changed[0]?.diffs?.[0]).toMatchObject({ field: "inputSchema", path: "required" });
  });

  it("formatCompareResult は差分を人が読める文字列にする", () => {
    const r = compareWithBaseline(
      [withProps({ count: { type: "integer" } })],
      [withProps({ count: { type: "number" } })],
    );
    const text = formatCompareResult(r);
    expect(text).toContain("logbutler_issue_get");
    expect(text).toContain("inputSchema.properties.count.type");
    expect(text).toContain('expected "number"');
    expect(text).toContain('actual "integer"');
    expect(formatCompareResult({ missing: [], extra: [], changed: [] })).toBe("");
  });
});
