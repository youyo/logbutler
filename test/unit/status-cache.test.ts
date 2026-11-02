import { describe, expect, it } from "vitest";
import { API_BUDGET, MAX_STATUS_PROJECTS } from "../../src/analysis/budget";
import { myTasks } from "../../src/mcp/tools/analysis";
import { issueList } from "../../src/mcp/tools/issue";
import { endless, issue, NOW } from "../helpers/analysis-fixtures";
import { FakeKv } from "../helpers/fake-kv";
import type { RecordedCall } from "../helpers/mock-fetch";
import { callTool, type Respond } from "../helpers/tool-call";

/** 状態一覧の KV キャッシュ(ADR 0016 §1)。 */

const st = (id: number, name: string) => ({
  id,
  projectId: 10,
  name,
  color: "#fff",
  displayOrder: id,
});
const STANDARD = [st(1, "未対応"), st(2, "処理中"), st(3, "処理済み"), st(4, "完了")];
const KEY = (userId: number) => `statuses:${userId}`;
const T0 = new Date("2026-10-28T01:00:00Z");
const plus = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const listNotClosed = (
  respond: Record<string, Respond>,
  kv: FakeKv | undefined,
  o: { now?: Date; userId?: number; args?: Record<string, unknown> } = {},
) =>
  callTool(
    "logbutler_issue_list",
    { status_id: "not-closed", ...(o.args ?? {}) },
    { "GET /issues": [], ...respond },
    {
      now: o.now ?? T0,
      statusCache: kv ? { kv, userId: o.userId ?? 42 } : undefined,
    },
  );
const statusCalls = (calls: string[]) => calls.filter((c) => c.endsWith("/statuses"));
const ONE = {
  "GET /projects": [{ id: 10, projectKey: "PROJ" }],
  "GET /projects/PROJ/statuses": STANDARD,
};

describe("状態一覧のキャッシュ(issue_list not-closed)", () => {
  it("初回は Backlog から引いて KV に 1 回だけ書く(statuses:<ユーザーID>、TTL 600 秒、{id,name} だけ)。2 回目は状態一覧を引かず KV の読み取り 1 回だけ", async () => {
    const kv = new FakeKv();
    const first = await listNotClosed(ONE, kv);
    expect(first.isError, first.text).toBe(false);
    expect(statusCalls(first.calls)).toEqual(["GET /projects/PROJ/statuses"]);
    expect(kv.gets).toEqual([KEY(42)]);
    expect(kv.puts).toEqual([KEY(42)]);
    const stored = kv.store.get(KEY(42));
    expect(stored?.expirationTtl).toBe(600);
    expect(JSON.parse(stored?.value ?? "")).toEqual({
      PROJ: {
        fetched_at: expect.any(Number),
        statuses: STANDARD.map(({ id, name }) => ({ id, name })),
      },
    });

    const second = await listNotClosed({ "GET /projects": ONE["GET /projects"] }, kv, {
      now: plus(60),
    });
    expect(second.isError, second.text).toBe(false);
    expect(statusCalls(second.calls)).toEqual([]);
    expect(second.calls.at(-1)).toBe("GET /issues?statusId[]=1&statusId[]=2&statusId[]=3");
    expect(kv.gets).toHaveLength(2);
    expect(kv.puts).toHaveLength(1); // 引き直しがないので書かない
  });

  it("fetched_at が 600 秒より古い項目は引き直す(ちょうど 600 秒はまだ有効)", async () => {
    const kv = new FakeKv();
    await listNotClosed(ONE, kv);
    const edge = await listNotClosed({ "GET /projects": ONE["GET /projects"] }, kv, {
      now: plus(600),
    });
    expect(statusCalls(edge.calls)).toEqual([]);
    const stale = await listNotClosed(ONE, kv, { now: plus(601) });
    expect(statusCalls(stale.calls)).toEqual(["GET /projects/PROJ/statuses"]);
    expect(kv.puts).toHaveLength(2);
    const fetchedAt = JSON.parse(kv.store.get(KEY(42))?.value ?? "").PROJ.fetched_at;
    expect(fetchedAt).toBe(plus(601).getTime());
  });

  it("一部のプロジェクトだけキャッシュにあれば、無い分だけ引き、書き込みは 1 回(古い項目は捨てる)", async () => {
    const kv = new FakeKv();
    await listNotClosed(
      { "GET /projects": [{ id: 1, projectKey: "A" }], "GET /projects/A/statuses": STANDARD },
      kv,
    );
    const run = await listNotClosed(
      {
        "GET /projects": [
          { id: 1, projectKey: "A" },
          { id: 2, projectKey: "B" },
        ],
        "GET /projects/B/statuses": [st(1, "未対応"), st(301, "検証中")],
      },
      kv,
      { now: plus(30) },
    );
    expect(statusCalls(run.calls)).toEqual(["GET /projects/B/statuses"]);
    expect(kv.gets).toHaveLength(2);
    expect(kv.puts).toHaveLength(2);
    expect(Object.keys(JSON.parse(kv.store.get(KEY(42))?.value ?? "")).sort()).toEqual(["A", "B"]);
    expect(run.calls.at(-1)).toBe(
      "GET /issues?statusId[]=1&statusId[]=2&statusId[]=3&statusId[]=301",
    );
  });

  it("別ユーザーのキャッシュは共有しない(キーにユーザー ID。参加していないプロジェクトの状態名を見せない)", async () => {
    const kv = new FakeKv();
    await listNotClosed(ONE, kv, { userId: 42 });
    const other = await listNotClosed(ONE, kv, { userId: 43 });
    expect(statusCalls(other.calls)).toEqual(["GET /projects/PROJ/statuses"]);
    expect([...kv.store.keys()].sort()).toEqual([KEY(42), KEY(43)]);
  });

  it("KV の読み取りが失敗してもツールは止まらず、Backlog から引く(書き込みも試みる)", async () => {
    const kv = new FakeKv();
    kv.failGet = true;
    const run = await listNotClosed(ONE, kv);
    expect(run.isError, run.text).toBe(false);
    expect(statusCalls(run.calls)).toEqual(["GET /projects/PROJ/statuses"]);
    expect(run.calls.at(-1)).toBe("GET /issues?statusId[]=1&statusId[]=2&statusId[]=3");
  });

  it("KV の書き込みが失敗してもツールは止まらない", async () => {
    const kv = new FakeKv();
    kv.failPut = true;
    const run = await listNotClosed(ONE, kv);
    expect(run.isError, run.text).toBe(false);
    expect(run.calls.at(-1)).toBe("GET /issues?statusId[]=1&statusId[]=2&statusId[]=3");
  });

  it("壊れた値(JSON でない・形が違う)はキャッシュなしとして引き直す。形が正しい項目は使う", async () => {
    for (const bad of ["not json", "[]", "null", '{"PROJ":{"fetched_at":"x","statuses":[]}}']) {
      const kv = new FakeKv();
      kv.store.set(KEY(42), { value: bad });
      const run = await listNotClosed(ONE, kv);
      expect(run.isError, bad).toBe(false);
      expect(statusCalls(run.calls), bad).toEqual(["GET /projects/PROJ/statuses"]);
    }
    const kv = new FakeKv();
    kv.store.set(KEY(42), {
      value: JSON.stringify({
        PROJ: { fetched_at: T0.getTime(), statuses: [{ id: 9, name: "確認中" }] },
        BAD: { fetched_at: T0.getTime(), statuses: [{ id: "x" }] },
      }),
    });
    const run = await listNotClosed(
      {
        "GET /projects": [
          { id: 10, projectKey: "PROJ" },
          { id: 11, projectKey: "BAD" },
        ],
        "GET /projects/BAD/statuses": [st(1, "未対応")],
      },
      kv,
    );
    expect(statusCalls(run.calls)).toEqual(["GET /projects/BAD/statuses"]);
    expect(run.calls.at(-1)).toBe("GET /issues?statusId[]=9&statusId[]=1");
  });

  it("statusCache が無ければ(未設定)従来どおり毎回引く", async () => {
    const a = await listNotClosed(ONE, undefined);
    const b = await listNotClosed(ONE, undefined);
    expect(statusCalls(a.calls)).toHaveLength(1);
    expect(statusCalls(b.calls)).toHaveLength(1);
  });

  it("状態一覧の取得が失敗したらツールエラー。キャッシュには書かない", async () => {
    const kv = new FakeKv();
    const run = await listNotClosed(
      {
        ...ONE,
        "GET /projects/PROJ/statuses": new Response(
          JSON.stringify({ errors: [{ message: "x", code: 11 }] }),
          { status: 403 },
        ),
      },
      kv,
    );
    expect(run.json.error.code).toBe("permission_error");
    expect(kv.puts).toEqual([]);
  });
});

describe("状態一覧のキャッシュ(my_tasks)", () => {
  const ME = { id: 1, userId: "a", name: "Alice" };
  const base = {
    "GET /users/myself": ME,
    "GET /users/1/watchings": [],
    "GET /issues": [],
    "GET /projects": [{ id: 10, projectKey: "PROJ" }],
  };
  const run = (kv: FakeKv, extra: Record<string, Respond> = {}) =>
    callTool(
      "logbutler_my_tasks",
      {},
      { ...base, ...extra },
      {
        now: NOW,
        statusCache: { kv, userId: 42 },
      },
    );

  it("2 回目は状態一覧を引かず、同じ statusId で課題を取る", async () => {
    const kv = new FakeKv();
    const first = await run(kv, { "GET /projects/PROJ/statuses": STANDARD });
    expect(statusCalls(first.calls)).toHaveLength(1);
    const second = await run(kv);
    expect(second.isError, second.text).toBe(false);
    expect(statusCalls(second.calls)).toEqual([]);
    expect(
      second.calls.filter((c) => c.includes("statusId[]=1&statusId[]=2&statusId[]=3")),
    ).toHaveLength(2);
    expect(kv.gets).toHaveLength(2);
    expect(kv.puts).toHaveLength(1);
  });

  it("KV が壊れていても warning なしで続行する", async () => {
    const kv = new FakeKv();
    kv.failGet = true;
    kv.failPut = true;
    const r = await run(kv, { "GET /projects/PROJ/statuses": STANDARD });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.warnings).toEqual([]);
  });
});

describe("上限 100 プロジェクト", () => {
  const projects = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: i + 1, projectKey: `P${i}` }));
  const statuses = (n: number) =>
    Object.fromEntries(
      projects(n).map((p) => [`GET /projects/${p.projectKey}/statuses`, STANDARD]),
    );

  it("MAX_STATUS_PROJECTS は 100", () => {
    expect(MAX_STATUS_PROJECTS).toBe(100);
  });

  it("issue_list not-closed(指定なし): 21〜100 プロジェクトでも argument_error にならず、全プロジェクトの状態一覧を引く", async () => {
    for (const n of [21, 100]) {
      const r = await listNotClosed({ "GET /projects": projects(n), ...statuses(n) }, undefined);
      expect(r.isError, `${n}: ${r.text}`).toBe(false);
      expect(statusCalls(r.calls)).toHaveLength(n);
    }
  });

  it("issue_list not-closed(指定なし): 101 プロジェクトは argument_error(課題一覧は呼ばない)", async () => {
    const r = await listNotClosed({ "GET /projects": projects(101) }, undefined);
    expect(r.json.error.code).toBe("argument_error");
    expect(r.json.error.message).toContain("project_key");
    expect(r.calls).toEqual(["GET /projects?archived=false"]);
  });

  it("issue_list not-closed: project_keys は 100 まで通り、101 は Backlog を呼ぶ前に argument_error", async () => {
    const keys = (n: number) =>
      projects(n)
        .map((p) => p.projectKey)
        .join(",");
    const bad = await listNotClosed({}, undefined, { args: { project_keys: keys(101) } });
    expect(bad.json.error.code).toBe("argument_error");
    expect(bad.calls).toEqual([]);
    const get = Object.fromEntries(
      projects(100).map((p) => [`GET /projects/${p.projectKey}`, { id: p.id }]),
    );
    const ok = await listNotClosed({ ...get, ...statuses(100) }, undefined, {
      args: { project_keys: keys(100) },
    });
    expect(ok.isError, ok.text).toBe(false);
  });

  it("my_tasks: 100 プロジェクトまでは truncated にならず、101 では先頭 100 件だけ使い truncated と warning", async () => {
    const base = {
      "GET /users/myself": { id: 1, userId: "a", name: "A" },
      "GET /users/1/watchings": [],
      "GET /issues": [],
    };
    const ok = await callTool(
      "logbutler_my_tasks",
      {},
      { ...base, "GET /projects": projects(100), ...statuses(100) },
      { now: NOW },
    );
    expect(statusCalls(ok.calls)).toHaveLength(100);
    expect(ok.json.analysis.truncated).toBe(false);
    expect(ok.json.warnings).toEqual([]);
    const over = await callTool(
      "logbutler_my_tasks",
      {},
      { ...base, "GET /projects": projects(101), ...statuses(101) },
      { now: NOW },
    );
    expect(statusCalls(over.calls)).toHaveLength(100);
    expect(over.json.analysis.truncated).toBe(true);
    expect(over.json.warnings.map((w: { code: string }) => w.code)).toEqual([
      "status_projects_truncated",
    ]);
  });
});

describe("呼び出し回数の上限(ADR 0016)", () => {
  it("my_tasks は 132 = GetMyself 1 + プロジェクト一覧 1 + 状態一覧 100 + 10 + 10 + 10", () => {
    expect(API_BUDGET.myTasks).toBe(132);
    expect(myTasks.maxApiCalls).toBe(132);
  });

  it("issue_list は 204 = GetProject 100 + GetMyself 1 + 状態一覧 100 + 子の収集 2 + 一覧 1", () => {
    expect(issueList.maxApiCalls).toBe(204);
  });

  it("my_tasks: 100 プロジェクトで 3 つとも上限まで続いても 132 回で止まる", async () => {
    const projects = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, projectKey: `P${i}` }));
    const r = await callTool(
      "logbutler_my_tasks",
      { max_response_tokens: 0 },
      {
        "GET /users/myself": { id: 1, userId: "a", name: "A" },
        "GET /projects": projects,
        ...Object.fromEntries(
          projects.map((p) => [`GET /projects/${p.projectKey}/statuses`, STANDARD]),
        ),
        "GET /issues": endless((n) => issue({ key: `P-${n}`, dueDate: "2026-10-01T00:00:00Z" })),
        "GET /users/1/watchings": endless((n) => ({
          id: n,
          type: "issue",
          resourceAlreadyRead: false,
          lastContentUpdated: null,
          issue: issue({ key: `W-${n}`, updated: "2026-10-27T00:00:00Z" }),
        })),
      },
      { now: NOW },
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toHaveLength(132);
  });

  it("issue_list: 100 プロジェクト指定 + assignee me + not-closed + include_descendants の最悪ケースが 204 回で通る", async () => {
    const keys = Array.from({ length: 100 }, (_, i) => `P${i}`);
    const respond: Record<string, Respond> = {
      "GET /users/myself": { id: 1, userId: "a", name: "A" },
      ...Object.fromEntries(keys.map((k, i) => [`GET /projects/${k}`, { id: i + 1 }])),
      ...Object.fromEntries(keys.map((k) => [`GET /projects/${k}/statuses`, STANDARD])),
      "GET /issues": (call: RecordedCall) => {
        const q = new URL(call.url).searchParams;
        if (q.get("sort") !== "created") return []; // 最後の一覧
        return Array.from({ length: q.get("offset") ? 99 : 100 }, (_, i) => ({ id: 1000 + i }));
      },
    };
    const r = await callTool(
      "logbutler_issue_list",
      {
        project_keys: keys.join(","),
        assignee_id: "me",
        status_id: "not-closed",
        parent_issue_ids: "5",
        include_descendants: true,
        max_response_tokens: 0,
      },
      respond,
      { now: NOW },
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.calls).toHaveLength(204);
  });
});

describe("状態の変更で、そのユーザーのキャッシュを消す", () => {
  const cases: [string, Record<string, unknown>, Record<string, Respond>][] = [
    [
      "logbutler_status_add",
      { project_key: "PROJ", name: "S", color: "#ea2c00" },
      { "POST /projects/PROJ/statuses": { id: 101 } },
    ],
    [
      "logbutler_status_update",
      { project_key: "PROJ", status_id: 101, name: "N" },
      { "PATCH /projects/PROJ/statuses/101": { id: 101 } },
    ],
    [
      "logbutler_status_delete",
      { project_key: "PROJ", status_id: 101, substitute_status_id: 1 },
      { "DELETE /projects/PROJ/statuses/101": { id: 101 } },
    ],
  ];
  const seeded = () => {
    const kv = new FakeKv();
    kv.store.set(KEY(42), { value: "{}" });
    kv.store.set(KEY(43), { value: "{}" });
    return kv;
  };

  for (const [tool, args, respond] of cases) {
    it(`${tool} が成功したら statuses:<自分> だけ削除する(他ユーザーの値は残る)`, async () => {
      const kv = seeded();
      const run = await callTool(tool, args, respond, { statusCache: { kv, userId: 42 } });
      expect(run.isError, run.text).toBe(false);
      expect(kv.deletes).toEqual([KEY(42)]);
      expect([...kv.store.keys()]).toEqual([KEY(43)]);
    });

    it(`${tool} が失敗(argument_error / Backlog のエラー)したら削除しない`, async () => {
      const kv = seeded();
      const bad = await callTool(
        tool,
        { project_key: "PROJ" },
        {},
        { statusCache: { kv, userId: 42 } },
      );
      expect(bad.isError).toBe(true);
      const failing = Object.fromEntries(
        Object.keys(respond).map((k) => [
          k,
          new Response(JSON.stringify({ errors: [{ message: "x", code: 11 }] }), { status: 403 }),
        ]),
      );
      const run = await callTool(tool, args, failing, { statusCache: { kv, userId: 42 } });
      expect(run.isError).toBe(true);
      expect(kv.deletes).toEqual([]);
    });

    it(`${tool}: KV の削除が失敗しても、変更自体は成功として返す。キャッシュ未設定でも動く`, async () => {
      const kv = seeded();
      kv.failDelete = true;
      const run = await callTool(tool, args, respond, { statusCache: { kv, userId: 42 } });
      expect(run.isError, run.text).toBe(false);
      const none = await callTool(tool, args, respond);
      expect(none.isError, none.text).toBe(false);
    });
  }
});
