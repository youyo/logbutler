/**
 * プロジェクト設定ツール 12 個(ADR 0013): カテゴリー・バージョン(マイルストーン)・状態・カスタム属性の
 * 追加・更新・削除。仕様は Backlog API の公式 docs(https://developer.nulab.com/docs/backlog/api/2/)。
 * 出力は Backlog の生データ(camelCase)。管理者権限がなければ Backlog が 403 を返し、permission_error になる。
 * docs から読み取れない仕様は推測せず、Backlog に任せる(docs/adr/0013 の「未確定の点」)。
 */
import { z } from "zod";
import { ArgumentError } from "../../errors";
import { optBool, optInt, optStr, parseCsvInts, parseDate, reqInt, reqStr, seg } from "../args";
import { defineTool } from "../registry";

const toolset = "project_settings" as const;

/** 1 以上の整数 ID。0 や負数は argument_error(Backlog を呼ぶ前に弾く)。 */
function positiveId(name: string, value: number): number {
  if (value < 1) throw new ArgumentError(`${name} must be a positive integer, got ${value}`);
  return value;
}

const optNumber = (description: string) => z.number().describe(description).optional();
const optStrList = (description: string) => z.array(z.string()).describe(description).optional();

const PROJECT_KEY = "Project key (e.g. PROJECT). Requires project administrator permission";

// --- カテゴリー ---

export const categoryAdd = defineTool({
  name: "logbutler_category_add",
  title: "カテゴリー追加",
  description: "Add a category to a project (requires administrator permission)",
  category: "WriteNonIdempotent",
  toolset,
  inputSchema: z.object({
    project_key: reqStr(PROJECT_KEY),
    name: reqStr("Category name"),
  }),
  handler: ({ project_key, name }, { client }) =>
    client.request("POST", `/projects/${seg(project_key)}/categories`, { form: { name } }),
});

export const categoryUpdate = defineTool({
  name: "logbutler_category_update",
  title: "カテゴリー更新",
  description: "Rename a category of a project (requires administrator permission)",
  category: "WriteIdempotent",
  toolset,
  inputSchema: z.object({
    project_key: reqStr(PROJECT_KEY),
    category_id: reqInt("Category ID (see logbutler_meta_categories)"),
    name: reqStr("New category name"),
  }),
  handler: ({ project_key, category_id, name }, { client }) =>
    client.request(
      "PATCH",
      `/projects/${seg(project_key)}/categories/${seg(positiveId("category_id", category_id))}`,
      { form: { name } },
    ),
});

export const categoryDelete = defineTool({
  name: "logbutler_category_delete",
  title: "カテゴリー削除",
  description:
    "Delete a category of a project (requires administrator permission). This cannot be undone",
  category: "Destructive",
  toolset,
  inputSchema: z.object({
    project_key: reqStr(PROJECT_KEY),
    category_id: reqInt("Category ID to delete (see logbutler_meta_categories)"),
  }),
  handler: ({ project_key, category_id }, { client }) =>
    client.request(
      "DELETE",
      `/projects/${seg(project_key)}/categories/${seg(positiveId("category_id", category_id))}`,
    ),
});

// --- バージョン / マイルストーン ---

/** 開始日 <= 期限日。形式が `YYYY-MM-DD` なので文字列比較でよい。 */
function versionDates(a: { start_date?: string; release_due_date?: string }) {
  const startDate = a.start_date === undefined ? undefined : parseDate("start_date", a.start_date);
  const releaseDueDate =
    a.release_due_date === undefined
      ? undefined
      : parseDate("release_due_date", a.release_due_date);
  if (startDate && releaseDueDate && startDate > releaseDueDate) {
    throw new ArgumentError("start_date must not be later than release_due_date");
  }
  return { startDate, releaseDueDate };
}

export const versionAdd = defineTool({
  name: "logbutler_version_add",
  title: "バージョン追加",
  description:
    "Add a version (milestone) to a project (requires administrator permission). Dates are YYYY-MM-DD",
  category: "WriteNonIdempotent",
  toolset,
  inputSchema: z.object({
    project_key: reqStr(PROJECT_KEY),
    name: reqStr("Version name"),
    description: optStr("Version description"),
    start_date: optStr("Start date in YYYY-MM-DD format"),
    release_due_date: optStr("Release due date in YYYY-MM-DD format"),
  }),
  handler: ({ project_key, name, description, ...dates }, { client }) =>
    client.request("POST", `/projects/${seg(project_key)}/versions`, {
      form: { name, description, ...versionDates(dates) },
    }),
});

export const versionUpdate = defineTool({
  name: "logbutler_version_update",
  title: "バージョン更新",
  description:
    "Update a version (milestone) of a project (requires administrator permission). name is required by Backlog; other fields are changed only when given. Dates are YYYY-MM-DD",
  category: "WriteIdempotent",
  toolset,
  inputSchema: z.object({
    project_key: reqStr(PROJECT_KEY),
    version_id: reqInt("Version ID (see logbutler_meta_version)"),
    name: reqStr("Version name"),
    description: optStr("Version description"),
    start_date: optStr("Start date in YYYY-MM-DD format"),
    release_due_date: optStr("Release due date in YYYY-MM-DD format"),
    archived: optBool("true to archive the version"),
  }),
  handler: ({ project_key, version_id, name, description, archived, ...dates }, { client }) =>
    client.request(
      "PATCH",
      `/projects/${seg(project_key)}/versions/${seg(positiveId("version_id", version_id))}`,
      { form: { name, description, archived, ...versionDates(dates) } },
    ),
});

export const versionDelete = defineTool({
  name: "logbutler_version_delete",
  title: "バージョン削除",
  description:
    "Delete a version (milestone) of a project (requires administrator permission). This cannot be undone",
  category: "Destructive",
  toolset,
  inputSchema: z.object({
    project_key: reqStr(PROJECT_KEY),
    version_id: reqInt("Version ID to delete (see logbutler_meta_version)"),
  }),
  handler: ({ project_key, version_id }, { client }) =>
    client.request(
      "DELETE",
      `/projects/${seg(project_key)}/versions/${seg(positiveId("version_id", version_id))}`,
    ),
});

// --- 状態(ステータス) ---

/** Backlog が受け付ける状態の背景色(Add Status / Update Status の docs にある 10 色)。 */
export const STATUS_COLORS = [
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
] as const;

const COLOR_DESCRIPTION = `Background color. Must be one of: ${STATUS_COLORS.join(", ")}`;

function statusColor(value: string): string {
  const color = value.trim().toLowerCase();
  if (!(STATUS_COLORS as readonly string[]).includes(color)) {
    throw new ArgumentError(`color must be one of: ${STATUS_COLORS.join(", ")}, got "${value}"`);
  }
  return color;
}

export const statusAdd = defineTool({
  name: "logbutler_status_add",
  title: "ステータス追加",
  description:
    "Add a custom status to a project (requires administrator permission). A project can have up to 8 custom statuses in addition to the 4 default ones. color is required and must be one of the allowed colors",
  category: "WriteNonIdempotent",
  toolset,
  inputSchema: z.object({
    project_key: reqStr("Project key (e.g. PROJECT). Requires administrator permission"),
    name: reqStr("Status name"),
    color: reqStr(COLOR_DESCRIPTION),
  }),
  handler: ({ project_key, name, color }, { client }) =>
    client.request("POST", `/projects/${seg(project_key)}/statuses`, {
      form: { name, color: statusColor(color) },
    }),
});

export const statusUpdate = defineTool({
  name: "logbutler_status_update",
  title: "ステータス更新",
  description:
    "Update the name and/or color of a project status (requires administrator permission). Specify at least one of name and color",
  category: "WriteIdempotent",
  toolset,
  inputSchema: z.object({
    project_key: reqStr("Project key (e.g. PROJECT). Requires administrator permission"),
    status_id: reqInt("Status ID (see logbutler_meta_statuses)"),
    name: z
      .string()
      .refine((s) => s.trim() !== "", "must not be empty")
      .describe("New status name")
      .optional(),
    color: z.string().describe(COLOR_DESCRIPTION).optional(),
  }),
  handler: ({ project_key, status_id, name, color }, { client }) => {
    positiveId("status_id", status_id);
    if (name === undefined && color === undefined) {
      throw new ArgumentError("at least one of name and color is required");
    }
    return client.request("PATCH", `/projects/${seg(project_key)}/statuses/${seg(status_id)}`, {
      form: { name, color: color === undefined ? undefined : statusColor(color) },
    });
  },
});

export const statusDelete = defineTool({
  name: "logbutler_status_delete",
  title: "ステータス削除",
  description:
    "Delete a project status (requires administrator permission). Issues that have the deleted status are moved to the substitute status. substitute_status_id is required. This cannot be undone",
  category: "Destructive",
  toolset,
  inputSchema: z.object({
    project_key: reqStr("Project key (e.g. PROJECT). Requires administrator permission"),
    status_id: reqInt("Status ID to delete (see logbutler_meta_statuses)"),
    substitute_status_id: reqInt(
      "Status ID that replaces the deleted status on its issues (must be another existing status of the project)",
    ),
  }),
  handler: ({ project_key, status_id, substitute_status_id }, { client }) => {
    positiveId("status_id", status_id);
    positiveId("substitute_status_id", substitute_status_id);
    if (substitute_status_id === status_id) {
      throw new ArgumentError("substitute_status_id must differ from status_id");
    }
    return client.request("DELETE", `/projects/${seg(project_key)}/statuses/${seg(status_id)}`, {
      form: { substituteStatusId: substitute_status_id },
    });
  },
});

// --- カスタム属性 ---

/** typeId: 1 テキスト 2 文章 3 数値 4 日付 5 単一選択リスト 6 複数選択リスト 7 チェックボックス 8 ラジオ。 */
const TYPE_NUMBER = 3;
const TYPE_DATE = 4;
const LIST_TYPES: readonly number[] = [5, 6, 7, 8];

interface CustomFieldArgs {
  name?: string | undefined;
  description?: string | undefined;
  required?: boolean | undefined;
  applicable_issue_type_ids?: string | undefined;
  number_min?: number | undefined;
  number_max?: number | undefined;
  initial_value?: number | undefined;
  unit?: string | undefined;
  date_min?: string | undefined;
  date_max?: string | undefined;
  initial_value_type?: number | undefined;
  initial_date?: string | undefined;
  initial_shift?: number | undefined;
  items?: string[] | undefined;
  allow_input?: boolean | undefined;
  allow_add_item?: boolean | undefined;
}

const NUMBER_ARGS = ["number_min", "number_max", "initial_value", "unit"] as const;
const DATE_ARGS = [
  "date_min",
  "date_max",
  "initial_value_type",
  "initial_date",
  "initial_shift",
] as const;
const LIST_ARGS = ["items", "allow_input", "allow_add_item"] as const;

const givenOf = (a: CustomFieldArgs, names: readonly (keyof CustomFieldArgs)[]) =>
  names.filter((n) => a[n] !== undefined);

/** 型に依存しない検証と、Backlog へ送る form の組み立て。 */
function customFieldForm(
  a: CustomFieldArgs,
): Record<string, string | number | boolean | string[] | number[] | undefined> {
  const issueTypes = parseCsvInts("applicable_issue_type_ids", a.applicable_issue_type_ids);
  if (a.applicable_issue_type_ids !== undefined && !issueTypes) {
    throw new ArgumentError(
      "applicable_issue_type_ids must contain at least one issue type ID (omit it to apply to all issue types)",
    );
  }
  if (issueTypes?.some((id) => id < 1)) {
    throw new ArgumentError("applicable_issue_type_ids must be positive integers");
  }
  const groups = [NUMBER_ARGS, DATE_ARGS, LIST_ARGS].filter((g) => givenOf(a, g).length > 0);
  if (groups.length > 1) {
    throw new ArgumentError(
      "number-type, date-type and list-type arguments cannot be combined (a custom field has one type)",
    );
  }
  if (a.number_min !== undefined && a.number_max !== undefined && a.number_min > a.number_max) {
    throw new ArgumentError("number_min must not be greater than number_max");
  }
  const dateMin = a.date_min === undefined ? undefined : parseDate("date_min", a.date_min);
  const dateMax = a.date_max === undefined ? undefined : parseDate("date_max", a.date_max);
  if (dateMin && dateMax && dateMin > dateMax) {
    throw new ArgumentError("date_min must not be later than date_max");
  }
  const initialDate =
    a.initial_date === undefined ? undefined : parseDate("initial_date", a.initial_date);
  const kind = a.initial_value_type;
  if (kind !== undefined && ![1, 2, 3].includes(kind)) {
    throw new ArgumentError(
      "initial_value_type must be 1 (today), 2 (today + initial_shift) or 3 (initial_date)",
    );
  }
  if (kind === 2 && a.initial_shift === undefined) {
    throw new ArgumentError("initial_shift is required when initial_value_type is 2");
  }
  if (kind === 3 && initialDate === undefined) {
    throw new ArgumentError("initial_date is required when initial_value_type is 3");
  }
  if (a.initial_shift !== undefined && kind !== 2) {
    throw new ArgumentError("initial_shift can be used only with initial_value_type 2");
  }
  if (initialDate !== undefined && kind !== 3) {
    throw new ArgumentError("initial_date can be used only with initial_value_type 3");
  }
  if (a.items?.some((s) => s.trim() === "")) {
    throw new ArgumentError("items must not contain empty strings");
  }
  // 数値型の min/max と日付型の min/max は Backlog では同じ名前(min / max)。
  return {
    name: a.name,
    description: a.description,
    required: a.required,
    applicableIssueTypes: issueTypes,
    min: a.number_min ?? dateMin,
    max: a.number_max ?? dateMax,
    initialValue: a.initial_value,
    unit: a.unit,
    initialValueType: kind,
    initialDate,
    initialShift: a.initial_shift,
    items: a.items,
    allowInput: a.allow_input,
    allowAddItem: a.allow_add_item,
  };
}

const NUMBER_FIELDS = {
  number_min: optNumber("Number type (type_id 3) only: minimum value"),
  number_max: optNumber("Number type (type_id 3) only: maximum value"),
  initial_value: optNumber("Number type (type_id 3) only: initial value"),
  unit: optStr("Number type (type_id 3) only: unit label"),
};
const DATE_FIELDS = {
  date_min: optStr("Date type (type_id 4) only: minimum date in YYYY-MM-DD format"),
  date_max: optStr("Date type (type_id 4) only: maximum date in YYYY-MM-DD format"),
  initial_value_type: optInt(
    "Date type (type_id 4) only: 1 = today, 2 = today + initial_shift days, 3 = the date in initial_date",
  ),
  initial_date: optStr(
    "Date type (type_id 4) only: initial date in YYYY-MM-DD format (with initial_value_type 3)",
  ),
  initial_shift: optInt(
    "Date type (type_id 4) only: days offset from today (with initial_value_type 2)",
  ),
};
const ISSUE_TYPES_FIELD = optStr(
  'Comma-separated issue type IDs the field is enabled for (e.g. "1,2"). Omit to enable it for all issue types',
);

export const customFieldAdd = defineTool({
  name: "logbutler_custom_field_add",
  title: "カスタム属性追加",
  description:
    "Add a custom field to a project (requires administrator or project administrator permission). type_id: 1 text, 2 sentence, 3 number, 4 date, 5 single list, 6 multiple list, 7 checkbox, 8 radio. Type-specific arguments are accepted only for the matching types: number_min/number_max/initial_value/unit (3), date_min/date_max/initial_value_type/initial_date/initial_shift (4), items/allow_input/allow_add_item (5-8). Managing individual list items afterwards is not supported",
  category: "WriteNonIdempotent",
  toolset,
  inputSchema: z.object({
    project_key: reqStr("Project key (e.g. PROJECT). Requires administrator permission"),
    type_id: reqInt(
      "Custom field type: 1 text, 2 sentence, 3 number, 4 date, 5 single list, 6 multiple list, 7 checkbox, 8 radio",
    ),
    name: reqStr("Custom field name"),
    description: optStr("Description of the field"),
    required: optBool("true to make the field required"),
    applicable_issue_type_ids: ISSUE_TYPES_FIELD,
    ...NUMBER_FIELDS,
    ...DATE_FIELDS,
    items: optStrList("List types (type_id 5-8) only: initial list items"),
    allow_input: optBool('List types (type_id 5-8) only: true to allow an "Other" free-text input'),
    allow_add_item: optBool("List types (type_id 5-8) only: true to allow users to add list items"),
  }),
  handler: ({ project_key, type_id, ...rest }, { client }) => {
    if (type_id < 1 || type_id > 8) {
      throw new ArgumentError(`type_id must be between 1 and 8, got ${type_id}`);
    }
    const reject = (names: readonly (keyof CustomFieldArgs)[], accepted: string) => {
      const given = givenOf(rest, names);
      if (given.length > 0) {
        throw new ArgumentError(`${given.join(", ")} can be used only with ${accepted}`);
      }
    };
    if (type_id !== TYPE_NUMBER) reject(NUMBER_ARGS, "type_id 3 (number)");
    if (type_id !== TYPE_DATE) reject(DATE_ARGS, "type_id 4 (date)");
    if (!LIST_TYPES.includes(type_id)) reject(LIST_ARGS, "type_id 5-8 (list types)");
    return client.request("POST", `/projects/${seg(project_key)}/customFields`, {
      form: { typeId: type_id, ...customFieldForm(rest) },
    });
  },
});

export const customFieldUpdate = defineTool({
  name: "logbutler_custom_field_update",
  title: "カスタム属性更新",
  description:
    "Update a custom field of a project (requires administrator or project administrator permission). Only the given fields are sent; at least one is required. The field's type cannot be changed, and type-specific arguments must match the field's type (Backlog validates this). Updating list items is not supported",
  category: "WriteIdempotent",
  toolset,
  inputSchema: z.object({
    project_key: reqStr("Project key (e.g. PROJECT). Requires administrator permission"),
    custom_field_id: reqInt("Custom field ID (see logbutler_meta_custom_field)"),
    name: z
      .string()
      .refine((s) => s.trim() !== "", "must not be empty")
      .describe("Custom field name")
      .optional(),
    description: optStr("Description of the field"),
    required: optBool("true to make the field required"),
    applicable_issue_type_ids: ISSUE_TYPES_FIELD,
    ...NUMBER_FIELDS,
    ...DATE_FIELDS,
    allow_input: optBool('List types only: true to allow an "Other" free-text input'),
    allow_add_item: optBool("List types only: true to allow users to add list items"),
  }),
  handler: ({ project_key, custom_field_id, ...rest }, { client }) => {
    positiveId("custom_field_id", custom_field_id);
    const form = customFieldForm(rest);
    if (Object.values(form).every((v) => v === undefined)) {
      throw new ArgumentError("at least one field to update is required");
    }
    return client.request(
      "PATCH",
      `/projects/${seg(project_key)}/customFields/${seg(custom_field_id)}`,
      { form },
    );
  },
});

export const customFieldDelete = defineTool({
  name: "logbutler_custom_field_delete",
  title: "カスタム属性削除",
  description:
    "Delete a custom field of a project (requires administrator or project administrator permission). Its values on issues are lost. This cannot be undone",
  category: "Destructive",
  toolset,
  inputSchema: z.object({
    project_key: reqStr("Project key (e.g. PROJECT). Requires administrator permission"),
    custom_field_id: reqInt("Custom field ID to delete (see logbutler_meta_custom_field)"),
  }),
  handler: ({ project_key, custom_field_id }, { client }) =>
    client.request(
      "DELETE",
      `/projects/${seg(project_key)}/customFields/${seg(positiveId("custom_field_id", custom_field_id))}`,
    ),
});

export const PROJECT_SETTINGS_TOOLS = [
  categoryAdd,
  categoryUpdate,
  categoryDelete,
  versionAdd,
  versionUpdate,
  versionDelete,
  statusAdd,
  statusUpdate,
  statusDelete,
  customFieldAdd,
  customFieldUpdate,
  customFieldDelete,
] as const;
