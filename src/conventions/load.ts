/**
 * conventions(組織の運用規約)の型とローダー。logvalet の `internal/conventions/{schema,load}.go` の移植。
 * 規約課題(種別「規約」)の説明欄にある最後の ```yaml ブロックを読む。未知のフィールドはエラー。
 *
 * 出力は logvalet の JSON と同じ(snake_case、未指定のリストは null)。
 */
import { parse } from "yaml";
import { LogbutlerError } from "../errors";

/** 規約の正本を保存する規約課題の種別名。 */
export const RULE_ISSUE_TYPE = "規約";
/** 案件のヘッダーとなる親課題の種別名。 */
export const ENGAGEMENT_ISSUE_TYPE = "案件";

/** 規約課題の中身が読めない・状態が規約に合わないなど。利用者(AI)にそのまま見せる。 */
export class ConventionsError extends LogbutlerError {
  constructor(message: string) {
    super("generic_error", message, false);
  }
}

export interface Conventions {
  schema_version: number;
  project: { key: string; name?: string };
  priority: { high: string; normal: string; low: string };
  close_policy: { low_untouched_days: number | null };
  statuses: { name: string; color: string }[] | null;
  issue_types:
    | {
        name: string;
        color: string;
        template_summary?: string;
        template_description?: string;
      }[]
    | null;
  initiatives: { name: string; description?: string }[] | null;
  engagements:
    | { name: string; lead: string; initiative: string; start_date?: string; due_date?: string }[]
    | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** オブジェクトを読む。未知のキーはエラー。null(空の値)は未指定。 */
function asObject(path: string, v: unknown, known: readonly string[]): Obj {
  if (v === null || v === undefined) return {};
  if (!isObj(v)) throw new ConventionsError(`conventions: ${path} はマップで指定してください`);
  for (const k of Object.keys(v)) {
    if (!known.includes(k)) {
      throw new ConventionsError(
        `conventions YAML のデコードに失敗しました: ${path === "" ? "" : `${path}.`}${k} は未知のフィールドです`,
      );
    }
  }
  return v;
}

/** 文字列。数値・真偽値は文字列にする（yaml.v3 と同じ）。マップ・配列はエラー。 */
function str(path: string, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new ConventionsError(`conventions: ${path} は文字列で指定してください`);
}

function optStr(path: string, o: Obj, key: string): { [k: string]: string } {
  const v = o[key];
  return v === undefined || v === null || v === "" ? {} : { [key]: str(`${path}.${key}`, v) };
}

function int(path: string, v: unknown): number {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  throw new ConventionsError(`conventions: ${path} は整数で指定してください`);
}

function list<T>(path: string, v: unknown, item: (p: string, x: unknown) => T): T[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v))
    throw new ConventionsError(`conventions: ${path} はリストで指定してください`);
  return v.map((x, i) => item(`${path}[${i}]`, x));
}

/** YAML のテキストを Conventions にする。 */
export function loadConventions(text: string): Conventions {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    throw new ConventionsError(
      `conventions YAML のデコードに失敗しました: ${e instanceof Error ? e.message.split("\n")[0] : "不正な YAML"}`,
    );
  }
  if (doc === null || doc === undefined) {
    throw new ConventionsError("conventions YAML のデコードに失敗しました: 文書が空です");
  }
  const top = asObject("", doc, [
    "schema_version",
    "project",
    "priority",
    "close_policy",
    "statuses",
    "issue_types",
    "initiatives",
    "engagements",
  ]);
  const project = asObject("project", top.project, ["key", "name"]);
  const priority = asObject("priority", top.priority, ["high", "normal", "low"]);
  const close = asObject("close_policy", top.close_policy, ["low_untouched_days"]);

  return {
    schema_version:
      top.schema_version === undefined || top.schema_version === null
        ? 0
        : int("schema_version", top.schema_version),
    project: {
      key: str("project.key", project.key),
      ...optStr("project", project, "name"),
    },
    priority: {
      high: str("priority.high", priority.high),
      normal: str("priority.normal", priority.normal),
      low: str("priority.low", priority.low),
    },
    close_policy: {
      low_untouched_days:
        close.low_untouched_days === undefined || close.low_untouched_days === null
          ? null
          : int("close_policy.low_untouched_days", close.low_untouched_days),
    },
    statuses: list("statuses", top.statuses, (p, x) => {
      const o = asObject(p, x, ["name", "color"]);
      return { name: str(`${p}.name`, o.name), color: str(`${p}.color`, o.color) };
    }),
    issue_types: list("issue_types", top.issue_types, (p, x) => {
      const o = asObject(p, x, ["name", "color", "template_summary", "template_description"]);
      return {
        name: str(`${p}.name`, o.name),
        color: str(`${p}.color`, o.color),
        ...optStr(p, o, "template_summary"),
        ...optStr(p, o, "template_description"),
      };
    }),
    initiatives: list("initiatives", top.initiatives, (p, x) => {
      const o = asObject(p, x, ["name", "description"]);
      return { name: str(`${p}.name`, o.name), ...optStr(p, o, "description") };
    }),
    engagements: list("engagements", top.engagements, (p, x) => {
      const o = asObject(p, x, ["name", "lead", "initiative", "start_date", "due_date"]);
      return {
        name: str(`${p}.name`, o.name),
        lead: str(`${p}.lead`, o.lead),
        initiative: str(`${p}.initiative`, o.initiative),
        ...optStr(p, o, "start_date"),
        ...optStr(p, o, "due_date"),
      };
    }),
  };
}

/** 説明欄の最後の ```yaml ブロックの中身。言語指定のないフェンスや閉じていないブロックは対象外。 */
function lastYamlBlock(description: string): string | undefined {
  let inBlock = false;
  let lines: string[] = [];
  let last: string | undefined;
  for (const raw of description.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const marker = line.trim();
    if (!inBlock) {
      if (marker === "```yaml") {
        inBlock = true;
        lines = [];
      }
      continue;
    }
    if (marker === "```") {
      last = lines.join("\n");
      inBlock = false;
      lines = [];
      continue;
    }
    lines.push(line);
  }
  return last;
}

/** 規約課題の説明欄から YAML コードブロックを取り出して読む。 */
export function loadFromIssueDescription(description: string): Conventions {
  const block = lastYamlBlock(description);
  if (block === undefined) {
    throw new ConventionsError("規約課題の説明欄に yaml コードブロックがありません");
  }
  return loadConventions(block);
}
