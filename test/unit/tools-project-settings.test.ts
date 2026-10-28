import { describe, expect, it } from "vitest";
import { callTool, formPairs } from "../helpers/tool-call";

/**
 * プロジェクト設定ツール 12 個(ADR 0013)。仕様は Backlog API の公式 docs:
 * https://developer.nulab.com/docs/backlog/ の Add/Update/Delete Category・Version/Milestone・Status・Custom Field。
 */

const category = { id: 1, projectId: 5, name: "Development", displayOrder: 0 };
const version = {
  id: 3,
  projectId: 1,
  name: "v1",
  description: "",
  startDate: null,
  releaseDueDate: null,
  archived: false,
  displayOrder: 0,
};
const status = { id: 101, projectId: 1, name: "Waiting", color: "#e87758", displayOrder: 3999 };
const field = {
  id: 2,
  projectId: 5,
  typeId: 1,
  name: "F",
  description: "",
  required: false,
  applicableIssueTypes: [1],
};

const annotationsOf = async (name: string) => {
  const { createMcpServer } = await import("../../src/mcp/server");
  const { rpcTo } = await import("../helpers/mcp");
  const { fakeClient } = await import("../helpers/mcp");
  const { result } = await rpcTo(
    () => createMcpServer({ getClient: () => fakeClient(), onBacklogUnauthorized: () => {} }),
    "tools/list",
  );
  const tool = (
    (result?.tools ?? []) as { name: string; annotations: Record<string, unknown> }[]
  ).find((t) => t.name === name);
  return tool?.annotations;
};

describe("注釈", () => {
  const writeNonIdem = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };
  const writeIdem = { ...writeNonIdem, idempotentHint: true };
  const destructive = { ...writeNonIdem, destructiveHint: true, idempotentHint: true };
  for (const r of ["category", "version", "status", "custom_field"]) {
    it(`${r}: add は非冪等の書き込み、update は冪等の書き込み、delete は破壊的`, async () => {
      expect(await annotationsOf(`logbutler_${r}_add`)).toMatchObject(writeNonIdem);
      expect(await annotationsOf(`logbutler_${r}_update`)).toMatchObject(writeIdem);
      expect(await annotationsOf(`logbutler_${r}_delete`)).toMatchObject(destructive);
    });
  }
});

const argError = async (tool: string, args: Record<string, unknown>) => {
  const run = await callTool(tool, args, {});
  expect(run.isError, JSON.stringify(args)).toBe(true);
  expect(run.json.error.code, `${tool} ${JSON.stringify(args)}: ${run.text}`).toBe(
    "argument_error",
  );
  expect(run.calls, "Backlog を呼ばない").toEqual([]);
};

describe("category_*", () => {
  it("add: POST /projects/{key}/categories に name。生データを返す", async () => {
    const run = await callTool(
      "logbutler_category_add",
      { project_key: "PROJ", name: "Development" },
      { "POST /projects/PROJ/categories": category },
    );
    expect(run.isError, run.text).toBe(false);
    expect(run.calls).toEqual(["POST /projects/PROJ/categories"]);
    expect(formPairs(run.recorded[0])).toEqual(["name=Development"]);
    expect(run.json).toEqual(category);
  });

  it("update: PATCH /projects/{key}/categories/{id} に name", async () => {
    const run = await callTool(
      "logbutler_category_update",
      { project_key: "PROJ", category_id: 1, name: "Dev2" },
      { "PATCH /projects/PROJ/categories/1": category },
    );
    expect(run.calls).toEqual(["PATCH /projects/PROJ/categories/1"]);
    expect(formPairs(run.recorded[0])).toEqual(["name=Dev2"]);
    expect(run.json).toEqual(category);
  });

  it("delete: DELETE /projects/{key}/categories/{id}。削除したカテゴリを返す", async () => {
    const run = await callTool(
      "logbutler_category_delete",
      { project_key: "PROJ", category_id: 1 },
      { "DELETE /projects/PROJ/categories/1": category },
    );
    expect(run.calls).toEqual(["DELETE /projects/PROJ/categories/1"]);
    expect(run.json).toEqual(category);
  });

  it("不正な引数は Backlog を呼ぶ前に argument_error", async () => {
    await argError("logbutler_category_add", { project_key: "PROJ", name: "" });
    await argError("logbutler_category_add", { project_key: "", name: "x" });
    await argError("logbutler_category_update", { project_key: "PROJ", category_id: 0, name: "x" });
    await argError("logbutler_category_update", { project_key: "PROJ", category_id: 1, name: " " });
    await argError("logbutler_category_delete", { project_key: "PROJ", category_id: 0 });
    await argError("logbutler_category_delete", { project_key: "PROJ", category_id: -3 });
  });

  it("project_key のパス区切りはエスケープされ、.. は拒否される", async () => {
    await argError("logbutler_category_delete", { project_key: "..", category_id: 1 });
  });

  it("管理者権限がない 403 は permission_error", async () => {
    const run = await callTool(
      "logbutler_category_add",
      { project_key: "PROJ", name: "x" },
      {
        "POST /projects/PROJ/categories": new Response(
          JSON.stringify({ errors: [{ message: "no permission", code: 6 }] }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      },
    );
    expect(run.isError).toBe(true);
    expect(run.json.error.code).toBe("permission_error");
  });
});

describe("version_*", () => {
  it("add: name 必須、description / startDate / releaseDueDate は指定したものだけ送る", async () => {
    const run = await callTool(
      "logbutler_version_add",
      {
        project_key: "PROJ",
        name: "v1",
        description: "d",
        start_date: "2026-11-01",
        release_due_date: "2026-12-01",
      },
      { "POST /projects/PROJ/versions": version },
    );
    expect(run.isError, run.text).toBe(false);
    expect(formPairs(run.recorded[0])).toEqual([
      "description=d",
      "name=v1",
      "releaseDueDate=2026-12-01",
      "startDate=2026-11-01",
    ]);
    expect(run.json).toEqual(version);
    const bare = await callTool(
      "logbutler_version_add",
      { project_key: "PROJ", name: "v1" },
      { "POST /projects/PROJ/versions": version },
    );
    expect(formPairs(bare.recorded[0])).toEqual(["name=v1"]);
  });

  it("update: PATCH /versions/{id}。name 必須。archived は false も送る。description の空文字も送る", async () => {
    const run = await callTool(
      "logbutler_version_update",
      {
        project_key: "PROJ",
        version_id: 3,
        name: "v1.1",
        description: "",
        archived: false,
        release_due_date: "2026-12-31",
      },
      { "PATCH /projects/PROJ/versions/3": version },
    );
    expect(run.calls).toEqual(["PATCH /projects/PROJ/versions/3"]);
    expect(formPairs(run.recorded[0])).toEqual([
      "archived=false",
      "description=",
      "name=v1.1",
      "releaseDueDate=2026-12-31",
    ]);
  });

  it("delete: DELETE /versions/{id}", async () => {
    const run = await callTool(
      "logbutler_version_delete",
      { project_key: "PROJ", version_id: 3 },
      { "DELETE /projects/PROJ/versions/3": version },
    );
    expect(run.calls).toEqual(["DELETE /projects/PROJ/versions/3"]);
    expect(run.json).toEqual(version);
  });

  it("不正な引数は argument_error(name 欠落・日付形式・存在しない日付・ID)", async () => {
    await argError("logbutler_version_add", { project_key: "PROJ", name: "" });
    await argError("logbutler_version_add", {
      project_key: "PROJ",
      name: "v",
      start_date: "2026/11/01",
    });
    await argError("logbutler_version_add", {
      project_key: "PROJ",
      name: "v",
      release_due_date: "2026-02-30",
    });
    await argError("logbutler_version_add", {
      project_key: "PROJ",
      name: "v",
      start_date: "2026-12-01",
      release_due_date: "2026-11-01",
    });
    await argError("logbutler_version_update", { project_key: "PROJ", version_id: 3, name: "" });
    await argError("logbutler_version_update", { project_key: "PROJ", version_id: 0, name: "v" });
    await argError("logbutler_version_update", {
      project_key: "PROJ",
      version_id: 3,
      name: "v",
      start_date: "bad",
    });
    await argError("logbutler_version_delete", { project_key: "PROJ", version_id: 0 });
  });
});

describe("status_*", () => {
  it("add: POST /statuses に name と color。色は小文字に揃えて送る", async () => {
    const run = await callTool(
      "logbutler_status_add",
      { project_key: "PROJ", name: "Waiting", color: "#E87758" },
      { "POST /projects/PROJ/statuses": status },
    );
    expect(run.isError, run.text).toBe(false);
    expect(formPairs(run.recorded[0])).toEqual(["color=#e87758", "name=Waiting"]);
    expect(run.json).toEqual(status);
  });

  it("add: docs にある 10 色はすべて受け付ける", async () => {
    for (const color of [
      "#ea2c00",
      "#e87758",
      "#e07b9a",
      "#868cb7",
      "#3b9dbd",
      "#4caf93",
      "#b0be3c",
      "#eda62a",
      "#f42858",
      "#393939",
    ]) {
      const run = await callTool(
        "logbutler_status_add",
        { project_key: "PROJ", name: "S", color },
        { "POST /projects/PROJ/statuses": status },
      );
      expect(run.isError, color).toBe(false);
      expect(run.calls, color).toEqual(["POST /projects/PROJ/statuses"]);
    }
  });

  it("add: 色の欠落・docs にない色・name 空は argument_error", async () => {
    await argError("logbutler_status_add", { project_key: "PROJ", name: "S" });
    await argError("logbutler_status_add", { project_key: "PROJ", name: "S", color: "#ffffff" });
    await argError("logbutler_status_add", { project_key: "PROJ", name: "S", color: "red" });
    await argError("logbutler_status_add", { project_key: "PROJ", name: "", color: "#ea2c00" });
  });

  it("update: PATCH /statuses/{id}。name と color のどちらか(または両方)", async () => {
    const run = await callTool(
      "logbutler_status_update",
      { project_key: "PROJ", status_id: 101, color: "#3b9dbd" },
      { "PATCH /projects/PROJ/statuses/101": status },
    );
    expect(run.calls).toEqual(["PATCH /projects/PROJ/statuses/101"]);
    expect(formPairs(run.recorded[0])).toEqual(["color=#3b9dbd"]);
    const both = await callTool(
      "logbutler_status_update",
      { project_key: "PROJ", status_id: 101, name: "N", color: "#3b9dbd" },
      { "PATCH /projects/PROJ/statuses/101": status },
    );
    expect(formPairs(both.recorded[0])).toEqual(["color=#3b9dbd", "name=N"]);
  });

  it("update: 変更内容なし・不正な色・ID 0 は argument_error", async () => {
    await argError("logbutler_status_update", { project_key: "PROJ", status_id: 101 });
    await argError("logbutler_status_update", {
      project_key: "PROJ",
      status_id: 101,
      color: "#000000",
    });
    await argError("logbutler_status_update", { project_key: "PROJ", status_id: 0, name: "N" });
    await argError("logbutler_status_update", { project_key: "PROJ", status_id: 101, name: "" });
  });

  it("delete: substitute_status_id 必須。DELETE に substituteStatusId を form で送る", async () => {
    const run = await callTool(
      "logbutler_status_delete",
      { project_key: "PROJ", status_id: 101, substitute_status_id: 1 },
      { "DELETE /projects/PROJ/statuses/101": status },
    );
    expect(run.calls).toEqual(["DELETE /projects/PROJ/statuses/101"]);
    expect(formPairs(run.recorded[0])).toEqual(["substituteStatusId=1"]);
    expect(run.json).toEqual(status);
  });

  it("delete: substitute_status_id の欠落・0・削除対象と同じは argument_error", async () => {
    await argError("logbutler_status_delete", { project_key: "PROJ", status_id: 101 });
    await argError("logbutler_status_delete", {
      project_key: "PROJ",
      status_id: 101,
      substitute_status_id: 0,
    });
    await argError("logbutler_status_delete", {
      project_key: "PROJ",
      status_id: 101,
      substitute_status_id: 101,
    });
    await argError("logbutler_status_delete", {
      project_key: "PROJ",
      status_id: 0,
      substitute_status_id: 1,
    });
  });
});

describe("custom_field_*", () => {
  const POST = "POST /projects/PROJ/customFields";

  it("add(テキスト型): typeId と name だけ。任意項目は指定したものだけ送る", async () => {
    const run = await callTool(
      "logbutler_custom_field_add",
      { project_key: "PROJ", type_id: 1, name: "F" },
      { [POST]: field },
    );
    expect(run.isError, run.text).toBe(false);
    expect(formPairs(run.recorded[0])).toEqual(["name=F", "typeId=1"]);
    expect(run.json).toEqual(field);
    const full = await callTool(
      "logbutler_custom_field_add",
      {
        project_key: "PROJ",
        type_id: 2,
        name: "F",
        description: "d",
        required: true,
        applicable_issue_type_ids: "1, 2",
      },
      { [POST]: field },
    );
    expect(formPairs(full.recorded[0])).toEqual([
      "applicableIssueTypes[]=1",
      "applicableIssueTypes[]=2",
      "description=d",
      "name=F",
      "required=true",
      "typeId=2",
    ]);
  });

  it("add(数値型): min / max / initialValue / unit", async () => {
    const run = await callTool(
      "logbutler_custom_field_add",
      {
        project_key: "PROJ",
        type_id: 3,
        name: "N",
        number_min: 0,
        number_max: 100,
        initial_value: 5,
        unit: "pt",
      },
      { [POST]: field },
    );
    expect(formPairs(run.recorded[0])).toEqual([
      "initialValue=5",
      "max=100",
      "min=0",
      "name=N",
      "typeId=3",
      "unit=pt",
    ]);
  });

  it("add(日付型): min / max / initialValueType / initialDate / initialShift", async () => {
    const run = await callTool(
      "logbutler_custom_field_add",
      {
        project_key: "PROJ",
        type_id: 4,
        name: "D",
        date_min: "2026-01-01",
        date_max: "2026-12-31",
        initial_value_type: 3,
        initial_date: "2026-06-01",
      },
      { [POST]: field },
    );
    expect(formPairs(run.recorded[0])).toEqual([
      "initialDate=2026-06-01",
      "initialValueType=3",
      "max=2026-12-31",
      "min=2026-01-01",
      "name=D",
      "typeId=4",
    ]);
    const shift = await callTool(
      "logbutler_custom_field_add",
      { project_key: "PROJ", type_id: 4, name: "D", initial_value_type: 2, initial_shift: 7 },
      { [POST]: field },
    );
    expect(formPairs(shift.recorded[0])).toEqual([
      "initialShift=7",
      "initialValueType=2",
      "name=D",
      "typeId=4",
    ]);
    const today = await callTool(
      "logbutler_custom_field_add",
      { project_key: "PROJ", type_id: 4, name: "D", initial_value_type: 1 },
      { [POST]: field },
    );
    expect(formPairs(today.recorded[0])).toEqual(["initialValueType=1", "name=D", "typeId=4"]);
  });

  it("add(リスト型 5〜8): items[] / allowInput / allowAddItem", async () => {
    for (const type_id of [5, 6, 7, 8]) {
      const run = await callTool(
        "logbutler_custom_field_add",
        {
          project_key: "PROJ",
          type_id,
          name: "L",
          items: ["A", "B,C"],
          allow_input: true,
          allow_add_item: false,
        },
        { [POST]: field },
      );
      expect(run.isError, String(type_id)).toBe(false);
      expect(formPairs(run.recorded[0]), String(type_id)).toEqual([
        "allowAddItem=false",
        "allowInput=true",
        "items[]=A",
        "items[]=B,C",
        "name=L",
        `typeId=${type_id}`,
      ]);
    }
  });

  it("add: 必須欠落・typeId 範囲外・型に合わない引数は argument_error", async () => {
    const base = { project_key: "PROJ", name: "F" };
    await argError("logbutler_custom_field_add", { ...base, type_id: 0 });
    await argError("logbutler_custom_field_add", { ...base, type_id: 9 });
    await argError("logbutler_custom_field_add", { ...base, type_id: 1.5 });
    await argError("logbutler_custom_field_add", { project_key: "PROJ", type_id: 1, name: "" });
    // 数値型専用の引数が他の型にある
    for (const extra of [
      { number_min: 1 },
      { number_max: 1 },
      { initial_value: 1 },
      { unit: "x" },
    ]) {
      await argError("logbutler_custom_field_add", { ...base, type_id: 1, ...extra });
      await argError("logbutler_custom_field_add", { ...base, type_id: 4, ...extra });
    }
    // 日付型専用
    for (const extra of [
      { date_min: "2026-01-01" },
      { date_max: "2026-01-01" },
      { initial_value_type: 1 },
      { initial_date: "2026-01-01" },
      { initial_shift: 1 },
    ]) {
      await argError("logbutler_custom_field_add", { ...base, type_id: 3, ...extra });
      await argError("logbutler_custom_field_add", { ...base, type_id: 5, ...extra });
    }
    // リスト専用
    for (const extra of [{ items: ["a"] }, { allow_input: true }, { allow_add_item: true }]) {
      await argError("logbutler_custom_field_add", { ...base, type_id: 1, ...extra });
      await argError("logbutler_custom_field_add", { ...base, type_id: 2, ...extra });
      await argError("logbutler_custom_field_add", { ...base, type_id: 3, ...extra });
      await argError("logbutler_custom_field_add", { ...base, type_id: 4, ...extra });
    }
  });

  it("add: 範囲・日付・初期値の組み合わせの不正は argument_error", async () => {
    const n = { project_key: "PROJ", name: "N", type_id: 3 };
    await argError("logbutler_custom_field_add", { ...n, number_min: 10, number_max: 1 });
    const d = { project_key: "PROJ", name: "D", type_id: 4 };
    await argError("logbutler_custom_field_add", { ...d, date_min: "2026-13-01" });
    await argError("logbutler_custom_field_add", {
      ...d,
      date_min: "2026-12-01",
      date_max: "2026-01-01",
    });
    await argError("logbutler_custom_field_add", { ...d, initial_value_type: 4 });
    await argError("logbutler_custom_field_add", { ...d, initial_value_type: 0 });
    await argError("logbutler_custom_field_add", { ...d, initial_value_type: 2 }); // initial_shift が必要
    await argError("logbutler_custom_field_add", { ...d, initial_value_type: 3 }); // initial_date が必要
    await argError("logbutler_custom_field_add", {
      ...d,
      initial_value_type: 1,
      initial_date: "2026-01-01",
    });
    await argError("logbutler_custom_field_add", {
      ...d,
      initial_value_type: 3,
      initial_date: "x",
    });
    await argError("logbutler_custom_field_add", { ...d, initial_value_type: 1, initial_shift: 1 });
    await argError("logbutler_custom_field_add", { ...d, initial_shift: 1 }); // initial_value_type なし
    await argError("logbutler_custom_field_add", {
      ...d,
      initial_value_type: 2,
      initial_shift: 1.5,
    });
    const l = { project_key: "PROJ", name: "L", type_id: 5 };
    await argError("logbutler_custom_field_add", { ...l, items: [""] });
    await argError("logbutler_custom_field_add", { ...l, items: ["a", " "] });
    await argError("logbutler_custom_field_add", {
      project_key: "PROJ",
      name: "T",
      type_id: 1,
      applicable_issue_type_ids: "a",
    });
  });

  it("update: PATCH /customFields/{id}。指定した項目だけ送る。変更なしは argument_error", async () => {
    const run = await callTool(
      "logbutler_custom_field_update",
      {
        project_key: "PROJ",
        custom_field_id: 2,
        name: "G",
        required: false,
        applicable_issue_type_ids: "3",
        allow_input: true,
      },
      { "PATCH /projects/PROJ/customFields/2": field },
    );
    expect(run.calls).toEqual(["PATCH /projects/PROJ/customFields/2"]);
    expect(formPairs(run.recorded[0])).toEqual([
      "allowInput=true",
      "applicableIssueTypes[]=3",
      "name=G",
      "required=false",
    ]);
    expect(run.json).toEqual(field);
    await argError("logbutler_custom_field_update", { project_key: "PROJ", custom_field_id: 2 });
    await argError("logbutler_custom_field_update", {
      project_key: "PROJ",
      custom_field_id: 0,
      name: "x",
    });
    await argError("logbutler_custom_field_update", {
      project_key: "PROJ",
      custom_field_id: 2,
      name: "",
    });
    await argError("logbutler_custom_field_update", {
      project_key: "PROJ",
      custom_field_id: 2,
      number_min: 5,
      number_max: 1,
    });
    await argError("logbutler_custom_field_update", {
      project_key: "PROJ",
      custom_field_id: 2,
      initial_value_type: 3,
    });
    await argError("logbutler_custom_field_update", {
      project_key: "PROJ",
      custom_field_id: 2,
      date_min: "bad",
    });
    await argError("logbutler_custom_field_update", {
      project_key: "PROJ",
      custom_field_id: 2,
      applicable_issue_type_ids: "",
    });
  });

  it("update: 数値型・日付型・リスト型の引数は 1 つの型の分だけ(混在は argument_error)", async () => {
    const base = { project_key: "PROJ", custom_field_id: 2 };
    await argError("logbutler_custom_field_update", {
      ...base,
      number_min: 1,
      date_max: "2026-01-01",
    });
    await argError("logbutler_custom_field_update", { ...base, unit: "x", allow_input: true });
    await argError("logbutler_custom_field_update", {
      ...base,
      initial_shift: 1,
      initial_value_type: 2,
      initial_value: 3,
    });
  });

  it("update(日付): initialValueType と initialDate", async () => {
    const run = await callTool(
      "logbutler_custom_field_update",
      {
        project_key: "PROJ",
        custom_field_id: 2,
        initial_value_type: 3,
        initial_date: "2026-06-01",
        date_max: "2026-12-31",
      },
      { "PATCH /projects/PROJ/customFields/2": field },
    );
    expect(formPairs(run.recorded[0])).toEqual([
      "initialDate=2026-06-01",
      "initialValueType=3",
      "max=2026-12-31",
    ]);
  });

  it("delete: DELETE /customFields/{id}。削除したフィールドを返す", async () => {
    const run = await callTool(
      "logbutler_custom_field_delete",
      { project_key: "PROJ", custom_field_id: 2 },
      { "DELETE /projects/PROJ/customFields/2": field },
    );
    expect(run.calls).toEqual(["DELETE /projects/PROJ/customFields/2"]);
    expect(run.json).toEqual(field);
    await argError("logbutler_custom_field_delete", { project_key: "PROJ", custom_field_id: 0 });
  });
});
