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
 * M06: 応答サイズの上限(ツール引数 max_response_tokens)を付けた、logvalet にもある読み取りツール 55 個。
 * ReadOnly のうちダウンロード系 2 個(issue_attachment_download / shared_file_download)を除く。
 */
export const RESPONSE_LIMIT_TOOLS: readonly string[] = [
  "logbutler_activity_digest",
  "logbutler_activity_list",
  "logbutler_activity_stats",
  "logbutler_digest_daily",
  "logbutler_digest_unified",
  "logbutler_digest_weekly",
  "logbutler_document_digest",
  "logbutler_document_get",
  "logbutler_document_list",
  "logbutler_document_search",
  "logbutler_document_tree",
  "logbutler_issue_attachment_list",
  "logbutler_issue_comment_list",
  "logbutler_issue_context",
  "logbutler_issue_get",
  "logbutler_issue_list",
  "logbutler_issue_related_list",
  "logbutler_issue_stale",
  "logbutler_issue_timeline",
  "logbutler_issue_triage_materials",
  "logbutler_meta_categories",
  "logbutler_meta_custom_field",
  "logbutler_meta_issue_types",
  "logbutler_meta_statuses",
  "logbutler_meta_version",
  "logbutler_my_tasks",
  "logbutler_project_blockers",
  "logbutler_project_conventions",
  "logbutler_project_get",
  "logbutler_project_health",
  "logbutler_project_list",
  "logbutler_search",
  "logbutler_shared_file_list",
  "logbutler_space_digest",
  "logbutler_space_disk_usage",
  "logbutler_space_info",
  "logbutler_team_get",
  "logbutler_team_list",
  "logbutler_team_project",
  "logbutler_user_activity",
  "logbutler_user_get",
  "logbutler_user_list",
  "logbutler_user_me",
  "logbutler_user_workload",
  "logbutler_watching_count",
  "logbutler_watching_get",
  "logbutler_watching_list",
  "logbutler_wiki_attachment_list",
  "logbutler_wiki_count",
  "logbutler_wiki_get",
  "logbutler_wiki_history",
  "logbutler_wiki_list",
  "logbutler_wiki_sharedfile_list",
  "logbutler_wiki_stars",
  "logbutler_wiki_tags",
];

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
  {
    tool: "logbutler_star_add",
    fields: ["annotations"],
    reason:
      "idempotentHint を true から false に変更。実 Backlog は同じ対象に 2 回スターを付けると 2 個になる(2026-10-29 実環境 E2E で確認)ので、冪等とは言えない。カテゴリは WriteIdempotent のまま(冪等キャッシュは付けない)で、注釈だけを実態に合わせた。差分の範囲は test/unit/tools-list-snapshot.test.ts で annotations.idempotentHint だけに固定している。",
  },
  {
    tool: "logbutler_issue_list",
    fields: ["inputSchema"],
    reason:
      "status_id の説明文を変更。logvalet は not-closed を「ID 1,2,3」と説明していたが、Logbutler はプロジェクトの状態一覧から完了集合以外の状態(カスタム状態を含む)の ID を決めるので、説明を実態に合わせた(ADR 0012)。差分の範囲は test/unit/tools-list-snapshot.test.ts で properties.status_id.description だけに固定している。timezone / max_response_tokens の追加は別の許容項目。",
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
  ...RESPONSE_LIMIT_TOOLS.map(
    (tool): AllowedChange => ({
      tool,
      fields: ["inputSchema"],
      reason:
        "max_response_tokens 引数(任意・整数・0 で無効・既定 50000)の追加。巨大な応答で AI のコンテキストを溢れさせない最後の安全網で、環境変数ではなくクライアントが呼び出しごとに決める（M06 の決定済み事項）。ダウンロード系 2 個は対象外。差分の範囲は test/unit/tools-list-snapshot.test.ts で properties.max_response_tokens の追加だけに固定している。",
    }),
  ),
];

export const ALLOWED_MISSING: readonly string[] = [];
/** logvalet に無い追加ツール(docs/tool-diff-from-logvalet.md)。M06: Nulab 公式 MCP から取り込んだ 3 ツール。ADR 0013: プロジェクト設定 12 ツール。 */
export const ALLOWED_EXTRA: readonly string[] = [
  "logbutler_notification_list",
  "logbutler_notification_count",
  "logbutler_project_users",
  // ADR 0013: プロジェクト設定ツール 12 個(カテゴリー・バージョン・状態・カスタム属性の追加・更新・削除)。
  // logvalet に無い。M06 で「ツール数を増やさない」として見送った判断を、ユーザーが覆した(2026-10-29)。
  // 既定の toolsets=all で公開し、read_only=true で隠す。
  ...["category", "version", "status", "custom_field"].flatMap((r) =>
    ["add", "update", "delete"].map((a) => `logbutler_${r}_${a}`),
  ),
];

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
