import { afterEach, describe, expect, it, vi } from "vitest";
import { createBacklogClient } from "../../src/backlog/client";
import { resolveEngagement } from "../../src/conventions/engagement";
import { GLOSSARY } from "../../src/conventions/show";
import { jsonResponse, mockOutboundFetch, type RecordedCall } from "../helpers/mock-fetch";
import { BACKLOG_API, callTool, describeCall } from "../helpers/tool-call";

afterEach(() => vi.restoreAllMocks());

const ENGAGEMENT = "顧客A 基盤更改";
const RULE_YAML = `schema_version: 1
project:
  key: PROJ
  name: Project
issue_types:
  - name: 規約
    color: '#666665'
  - name: 案件
    color: '#7ea800'
initiatives:
  - name: 運用保守
engagements:
  - name: ${ENGAGEMENT}
    lead: 山田 太郎
    initiative: 運用保守
    start_date: "2026-10-01"
    due_date: "2026-10-31"
`;
/** logvalet の BuildRuleIssueDescription と同じ形（ガイド + 用語 + yaml ブロック）。 */
const description = (yaml: string) =>
  `このプロジェクトの運用規約です。\n\n## 用語\n\n| 用語 | 意味 |\n|---|---|\n| a | b |\n\n## 規約 (conventions.yaml)\n\n\`\`\`yaml\n${yaml}\`\`\`\n`;

const ISSUE_TYPES = [
  { id: 10, name: "規約" },
  { id: 11, name: "案件" },
];
const ruleIssue = (desc = description(RULE_YAML), key = "PROJ-1") => ({
  id: 100,
  issueKey: key,
  summary: "[規約] 運用規約",
  issueType: { id: 10, name: "規約" },
  description: desc,
});
const parentIssue = {
  id: 101,
  issueKey: "PROJ-2",
  summary: `[案件] ${ENGAGEMENT}`,
  issueType: { id: 11, name: "案件" },
};

/** クエリの issueTypeId で応答を分ける課題一覧のハンドラ。 */
function issuesBy(byType: Record<string, unknown[] | ((c: RecordedCall) => unknown)>) {
  return (call: RecordedCall) => {
    const q = new URL(call.url).searchParams;
    const v = byType[q.get("issueTypeId[]") ?? ""] ?? [];
    return typeof v === "function" ? v(call) : v;
  };
}

describe("project_conventions(show)", () => {
  it("規約課題がなければ adopted=false で用語集だけ返す（課題一覧は呼ばない）", async () => {
    const run = await callTool(
      "logbutler_project_conventions",
      { project_key: "PROJ" },
      {
        "GET /projects/PROJ": { id: 1, projectKey: "PROJ" },
        "GET /projects/PROJ/issueTypes": [{ id: 11, name: "案件" }],
      },
    );
    expect(run.isError, run.text).toBe(false);
    expect(run.calls).toEqual(["GET /projects/PROJ", "GET /projects/PROJ/issueTypes"]);
    expect(run.json).toEqual({
      project_key: "PROJ",
      issue_key: "",
      adopted: false,
      glossary: GLOSSARY,
    });
    expect(run.json.glossary).toHaveLength(7);
    expect(Object.keys(run.json.glossary[0])).toEqual(["term", "meaning", "backlog_form"]);
  });

  it("規約課題の説明欄の yaml を読み、issueTypeId で絞った課題一覧から探す", async () => {
    const run = await callTool(
      "logbutler_project_conventions",
      { project_key: "  PROJ " },
      {
        "GET /projects/PROJ": { id: 1, projectKey: "PROJ" },
        "GET /projects/PROJ/issueTypes": ISSUE_TYPES,
        "GET /issues": [ruleIssue()],
      },
    );
    expect(run.isError, run.text).toBe(false);
    expect(run.calls).toEqual([
      "GET /projects/PROJ",
      "GET /projects/PROJ/issueTypes",
      "GET /issues?count=100&issueTypeId[]=10&projectId[]=1",
    ]);
    expect(run.json.adopted).toBe(true);
    expect(run.json.project_key).toBe("PROJ");
    expect(run.json.issue_key).toBe("PROJ-1");
    expect(run.json.conventions.project).toEqual({ key: "PROJ", name: "Project" });
    expect(run.json.conventions.engagements[0].name).toBe(ENGAGEMENT);
    expect(run.json.glossary).toEqual(GLOSSARY);
    expect(Object.keys(run.json)).toEqual([
      "project_key",
      "issue_key",
      "adopted",
      "conventions",
      "glossary",
    ]);
  });

  it("規約課題が 1 ページ目にない場合もページングして見つける（logvalet は 1 回しか呼ばず見落としうる）", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      issueKey: `PROJ-${1000 + i}`,
      issueType: { id: 99, name: "その他" },
      description: "",
    }));
    const run = await callTool(
      "logbutler_project_conventions",
      { project_key: "PROJ" },
      {
        "GET /projects/PROJ": { id: 1 },
        "GET /projects/PROJ/issueTypes": ISSUE_TYPES,
        "GET /issues": (call: RecordedCall) =>
          new URL(call.url).searchParams.get("offset") === "100" ? [ruleIssue()] : filler,
      },
    );
    expect(run.calls.slice(2)).toEqual([
      "GET /issues?count=100&issueTypeId[]=10&projectId[]=1",
      "GET /issues?count=100&issueTypeId[]=10&offset=100&projectId[]=1",
    ]);
    expect(run.json.adopted).toBe(true);
    expect(run.json.issue_key).toBe("PROJ-1");
  });

  it("規約課題が複数あればエラー（generic_error）", async () => {
    const run = await callTool(
      "logbutler_project_conventions",
      { project_key: "PROJ" },
      {
        "GET /projects/PROJ": { id: 1 },
        "GET /projects/PROJ/issueTypes": ISSUE_TYPES,
        "GET /issues": [ruleIssue("first", "PROJ-1"), ruleIssue("second", "PROJ-2")],
      },
    );
    expect(run.isError).toBe(true);
    expect(run.json.error.code).toBe("generic_error");
    expect(run.json.error.message).toContain("複数");
    expect(run.json.error.message).toContain("2");
  });

  it("規約課題に yaml がなければエラー。課題キーを含める", async () => {
    const run = await callTool(
      "logbutler_project_conventions",
      { project_key: "PROJ" },
      {
        "GET /projects/PROJ": { id: 1 },
        "GET /projects/PROJ/issueTypes": ISSUE_TYPES,
        "GET /issues": [ruleIssue("規約本文のみ")],
      },
    );
    expect(run.isError).toBe(true);
    expect(run.json.error.message).toContain("yaml");
    expect(run.json.error.message).toContain("PROJ-1");
  });

  it("課題種別・課題一覧が 404 のときは規約なしとして扱う（logvalet の ErrNotFound と同じ）", async () => {
    const run = await callTool(
      "logbutler_project_conventions",
      { project_key: "PROJ" },
      {
        "GET /projects/PROJ": { id: 1 },
        "GET /projects/PROJ/issueTypes": ISSUE_TYPES,
        "GET /issues": jsonResponse({ errors: [{ message: "no", code: 6 }] }, 404),
      },
    );
    expect(run.isError, run.text).toBe(false);
    expect(run.json.adopted).toBe(false);
  });

  it("存在しないプロジェクト(404)は not_found のエンベロープ。空のキーは argument_error", async () => {
    const nf = await callTool(
      "logbutler_project_conventions",
      { project_key: "NOPE" },
      {
        "GET /projects/NOPE": jsonResponse({ errors: [{ message: "No project.", code: 6 }] }, 404),
      },
    );
    expect(nf.json.error.code).toBe("not_found");
    const empty = await callTool("logbutler_project_conventions", { project_key: "  " }, {});
    expect(empty.json.error.code).toBe("argument_error");
    expect(empty.calls).toEqual([]);
  });
});

describe("resolveEngagement(logvalet engagement_test.go 相当)", () => {
  function setup(respond: Record<string, (c: RecordedCall) => unknown>) {
    const mocks = mockOutboundFetch(
      Object.fromEntries(
        Object.entries(respond).map(([k, v]) => {
          const [method, path] = k.split(" ");
          return [`${method} ${BACKLOG_API}${path}`, (c: RecordedCall) => jsonResponse(v(c))];
        }),
      ),
    );
    const client = createBacklogClient({ spaceHost: "example.backlog.com", accessToken: "t" });
    return { client, calls: () => mocks.calls.map(describeCall) };
  }
  const base = {
    "GET /projects/PROJ": () => ({ id: 1 }),
    "GET /projects/PROJ/issueTypes": () => ISSUE_TYPES,
    "GET /projects/PROJ/categories": () => [{ id: 20, name: ENGAGEMENT }],
    "GET /issues": issuesBy({ "10": [ruleIssue()], "11": [parentIssue] }),
  };

  it("案件名からカテゴリ ID と親課題 ID を解決する（名前の前後の空白は無視）", async () => {
    const { client, calls } = setup(base);
    const ref = await resolveEngagement(client, "PROJ", `  ${ENGAGEMENT}  `);
    expect(ref).toEqual({ name: ENGAGEMENT, categoryId: 20, parentIssueId: 101 });
    // プロジェクト・課題種別は 1 回ずつ。規約課題 → カテゴリ → 案件親課題（種別で絞る）の順。直列。
    expect(calls()).toEqual([
      "GET /projects/PROJ",
      "GET /projects/PROJ/issueTypes",
      "GET /issues?count=100&issueTypeId[]=10&projectId[]=1",
      "GET /projects/PROJ/categories",
      "GET /issues?count=100&issueTypeId[]=11&projectId[]=1",
    ]);
  });

  it("案件親課題が無くても成功し、parentIssueId は 0", async () => {
    const { client } = setup({ ...base, "GET /issues": issuesBy({ "10": [ruleIssue()] }) });
    expect(await resolveEngagement(client, "PROJ", ENGAGEMENT)).toEqual({
      name: ENGAGEMENT,
      categoryId: 20,
      parentIssueId: 0,
    });
  });

  it("件名が一致する案件親課題だけを選ぶ（別の案件の親課題は選ばない）", async () => {
    const other = { ...parentIssue, id: 555, summary: "[案件] 別の案件" };
    const { client } = setup({
      ...base,
      "GET /issues": issuesBy({ "10": [ruleIssue()], "11": [other, parentIssue] }),
    });
    expect((await resolveEngagement(client, "PROJ", ENGAGEMENT)).parentIssueId).toBe(101);
  });

  it("規約が導入されていなければエラー", async () => {
    const { client } = setup({ ...base, "GET /issues": issuesBy({}) });
    await expect(resolveEngagement(client, "PROJ", "顧客A")).rejects.toThrow(
      'プロジェクト "PROJ" には運用規約が導入されていません',
    );
  });

  it("規約にない案件は、使える案件名を添えて argument_error", async () => {
    const { client } = setup(base);
    const e = (await resolveEngagement(client, "PROJ", "存在しない案件").catch(
      (x: unknown) => x,
    )) as Error & { code: string };
    expect(e.code).toBe("argument_error");
    expect(e.message).toContain('案件 "存在しない案件" は規約にありません');
    expect(e.message).toContain(ENGAGEMENT);
  });

  it("案件に対応するカテゴリがプロジェクトになければエラー", async () => {
    const { client } = setup({ ...base, "GET /projects/PROJ/categories": () => [] });
    await expect(resolveEngagement(client, "PROJ", ENGAGEMENT)).rejects.toThrow(
      `案件 "${ENGAGEMENT}" に対応するカテゴリがプロジェクトにありません`,
    );
  });
});
