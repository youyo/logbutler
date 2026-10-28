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

/** キーを辞書順に並べ替える(配列の順序は保つ)。 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
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

export interface CompareResult {
  missing: string[];
  extra: string[];
  changed: { name: string; fields: ComparedField[] }[];
}

/**
 * logvalet の差分として許容している項目。M03 以降、移植時に差分が出たらここへ理由つきで足す。
 * M02 では差分なし。
 */
export const ALLOWED_CHANGES: readonly AllowedChange[] = [];
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
    const fields = COMPARED_FIELDS.filter(
      (f) => !allowed.has(f) && JSON.stringify(tool[f]) !== JSON.stringify(base[f]),
    );
    if (fields.length > 0) changed.push({ name, fields });
  }
  return { missing, extra, changed };
}
