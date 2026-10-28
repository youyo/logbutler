/**
 * tools/list の正規化と、logvalet の baseline(test/fixtures/logvalet_tools_list_baseline.json)との比較。
 * M03 以降、ツールを移植するたびにここで logvalet との差分を確認する。
 */

export interface McpToolListing {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const COMPARED_FIELDS = ["description", "inputSchema", "annotations"] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number];

/** 順序に意味のない配列(JSON Schema の集合)。Go 版は辞書順、zod は定義順に出すため、順序を無視して比べる。 */
const UNORDERED_ARRAY_KEYS = new Set(["required", "enum"]);

/** キーを辞書順に並べ替える。配列の順序は保つ(`required` と `enum` の文字列配列だけは辞書順にそろえる)。 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [
          k,
          UNORDERED_ARRAY_KEYS.has(k) && Array.isArray(v) && v.every((x) => typeof x === "string")
            ? [...(v as string[])].sort()
            : sortKeys(v),
        ]),
    );
  }
  return value;
}

/** zod(JSON Schema 2020-12)と Go 版の出力の表記ゆれを揃える。 */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  if (rest.additionalProperties === false) delete rest.additionalProperties;
  if (rest.type === "object" && rest.required === undefined) rest.required = [];
  return sortKeys(rest) as Record<string, unknown>;
}

export function normalizeTools(tools: readonly McpToolListing[]): McpToolListing[] {
  return [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({
      name: t.name,
      ...(t.description === undefined ? {} : { description: t.description }),
      inputSchema: normalizeSchema(t.inputSchema),
      ...(t.annotations === undefined
        ? {}
        : { annotations: sortKeys(t.annotations) as Record<string, unknown> }),
    }));
}

/** logvalet の baseline(JSON-RPC 応答の形)から、名前を logbutler_ に置換したツール一覧を作る。 */
export function fromLogvaletBaseline(baseline: {
  result: { tools: McpToolListing[] };
}): McpToolListing[] {
  return normalizeTools(
    baseline.result.tools.map((t) => ({ ...t, name: t.name.replace(/^logvalet_/, "logbutler_") })),
  );
}

export interface AllowedChange {
  tool: string;
  fields: readonly ComparedField[];
  /** なぜ logvalet と違ってよいのか。 */
  reason: string;
}

export interface CompareOptions {
  /** 指定すると、これらの名前のツールだけを比べる(M02 は user_me のみ)。 */
  only?: readonly string[];
  allowedChanges?: readonly AllowedChange[];
  /** baseline にあるが logbutler にないことを許すツール。 */
  allowedMissing?: readonly string[];
  /** baseline になく logbutler にあることを許すツール(Nulab 公式から取り込む分など)。 */
  allowedExtra?: readonly string[];
}

/** 1 か所の差分。path は inputSchema / annotations の中の位置(`properties.count.type` など。description は空)。 */
export interface PropertyDiff {
  field: ComparedField;
  path: string;
  /** baseline(logvalet)の値。なければ undefined。 */
  expected: unknown;
  /** logbutler の値。なければ undefined。 */
  actual: unknown;
}

export interface CompareResult {
  missing: string[];
  extra: string[];
  changed: { name: string; fields: ComparedField[]; diffs: PropertyDiff[] }[];
}

function diffValues(
  field: ComparedField,
  path: string,
  expected: unknown,
  actual: unknown,
  out: PropertyDiff[],
): void {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (isObj(expected) && isObj(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const k of keys) {
      diffValues(field, path === "" ? k : `${path}.${k}`, expected[k], actual[k], out);
    }
    return;
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    out.push({ field, path, expected, actual });
  }
}

/** 失敗メッセージ用。差分を 1 行ずつ(`tool: field.path: expected X, actual Y`)にする。 */
export function formatCompareResult(r: CompareResult): string {
  const lines: string[] = [];
  for (const n of r.missing) lines.push(`missing: ${n}`);
  for (const n of r.extra) lines.push(`extra: ${n}`);
  for (const c of r.changed) {
    for (const d of c.diffs) {
      const where = d.path === "" ? d.field : `${d.field}.${d.path}`;
      lines.push(
        `${c.name}: ${where}: expected ${JSON.stringify(d.expected)}, actual ${JSON.stringify(d.actual)}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * logvalet の差分として許容している項目。M03 以降、移植時に差分が出たらここへ理由つきで足す。
 * M04 で issue_attachment_upload の file_paths 削除を足した（docs/tool-diff-from-logvalet.md にも記載）。
 */
export const ALLOWED_CHANGES: readonly AllowedChange[] = [
  {
    tool: "logbutler_issue_attachment_upload",
    fields: ["description", "inputSchema"],
    reason:
      "file_paths（サーバー上のファイルパス）は Workers にファイルシステムがないためスキーマから削除し、base64 のみにした（M04 の決定済み事項）。説明文と file_content_base64 の説明から file_paths への言及も除いた。差分の範囲は test/unit/tools-list-snapshot.test.ts で固定している。",
  },
  ...[
    "logbutler_issue_list",
    "logbutler_my_tasks",
    "logbutler_digest_daily",
    "logbutler_digest_weekly",
    "logbutler_activity_stats",
    "logbutler_issue_timeline",
    // M05B: 日付を解釈する digest 系
    "logbutler_activity_digest",
    "logbutler_user_activity",
    "logbutler_digest_unified",
  ].map(
    (tool): AllowedChange => ({
      tool,
      fields: ["inputSchema"],
      reason:
        "timezone 引数（任意・IANA 名・省略時 Asia/Tokyo）の追加。タイムゾーンの環境変数を廃止し、「今日」の基準をクライアントが呼び出しごとに決められるようにした（M05.5 の決定済み事項）。Workers は UTC で動くため logvalet のローカル時刻依存の代わりに必要。差分の範囲は test/unit/tools-list-snapshot.test.ts で properties.timezone の追加だけに固定している。",
    }),
  ),
];
export const ALLOWED_MISSING: readonly string[] = [];
export const ALLOWED_EXTRA: readonly string[] = [];

export function compareWithBaseline(
  actual: readonly McpToolListing[],
  baseline: readonly McpToolListing[],
  options: CompareOptions = {},
): CompareResult {
  const only = options.only ? new Set(options.only) : undefined;
  const pick = (tools: readonly McpToolListing[]) =>
    normalizeTools(tools.filter((t) => !only || only.has(t.name)));
  const a = new Map(pick(actual).map((t) => [t.name, t]));
  const b = new Map(pick(baseline).map((t) => [t.name, t]));

  const missing = [...b.keys()].filter((n) => !a.has(n) && !options.allowedMissing?.includes(n));
  const extra = [...a.keys()].filter((n) => !b.has(n) && !options.allowedExtra?.includes(n));
  const changed: CompareResult["changed"] = [];
  for (const [name, tool] of a) {
    const base = b.get(name);
    if (!base) continue;
    const allowed = new Set(
      options.allowedChanges?.filter((c) => c.tool === name).flatMap((c) => c.fields) ?? [],
    );
    const diffs: PropertyDiff[] = [];
    for (const f of COMPARED_FIELDS) {
      if (!allowed.has(f)) diffValues(f, "", base[f], tool[f], diffs);
    }
    const fields = COMPARED_FIELDS.filter((f) => diffs.some((d) => d.field === f));
    if (fields.length > 0) changed.push({ name, fields, diffs });
  }
  return { missing, extra, changed };
}
