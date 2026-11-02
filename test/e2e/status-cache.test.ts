import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";
import {
  BACKLOG_HOST,
  firstText,
  mcpRequest,
  readRpc,
  runAuthorizationFlow,
  setupMocks,
  type TokenSet,
} from "../helpers/oauth-flow";

afterEach(() => {
  vi.restoreAllMocks();
});

// KV はテスト間で残るので、毎回キャッシュを空にしてから始める。
beforeEach(async () => {
  await env.OAUTH_KV.delete("statuses:42");
});

const API = `${BACKLOG_HOST}/api/v2`;

async function loggedIn(handlers: Parameters<typeof mockOutboundFetch>[0]) {
  await setupMocks();
  const flow = await runAuthorizationFlow();
  const { access_token } = (await flow.tokenResponse.json()) as TokenSet;
  vi.restoreAllMocks();
  return { token: access_token, ...mockOutboundFetch(handlers) };
}

const call = (token: string, name: string, args: Record<string, unknown>) =>
  mcpRequest(token, "tools/call", { name, arguments: args });
const pathsOf = (calls: { method: string; url: string }[]) =>
  calls.map((c) => `${c.method} ${new URL(c.url).pathname.replace("/api/v2", "")}`);
const statusLists = (calls: { method: string; url: string }[]) =>
  pathsOf(calls).filter((p) => p.startsWith("GET ") && p.endsWith("/statuses"));

const STATUSES = [
  { id: 1, projectId: 10, name: "未対応", color: "#ea2c00" },
  { id: 2, projectId: 10, name: "処理中", color: "#3b9dbd" },
  { id: 4, projectId: 10, name: "完了", color: "#393939" },
];

describe("E2E 17: 状態一覧の KV キャッシュ(ADR 0016)", () => {
  it("issue_list(not-closed)の 2 回目は状態一覧を引かず、OAUTH_KV の statuses:<ユーザーID> に {id,name} だけが 600 秒の TTL で入る(トークンは入らない)", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects`]: () => jsonResponse([{ id: 10, projectKey: "PROJ" }]),
      [`GET ${API}/projects/PROJ/statuses`]: () => jsonResponse(STATUSES),
      [`GET ${API}/issues`]: () => jsonResponse([]),
    });
    for (let i = 0; i < 2; i++) {
      const rpc = await readRpc(
        await call(token, "logbutler_issue_list", { status_id: "not-closed" }),
      );
      expect(rpc.result?.isError, firstText(rpc)).toBeFalsy();
    }
    expect(statusLists(calls)).toEqual(["GET /projects/PROJ/statuses"]);
    const issueCalls = calls.filter((c) => new URL(c.url).pathname.endsWith("/issues"));
    expect(issueCalls).toHaveLength(2);
    for (const c of issueCalls) {
      expect(new URL(c.url).searchParams.getAll("statusId[]")).toEqual(["1", "2"]);
    }

    const raw = await env.OAUTH_KV.get("statuses:42");
    expect(JSON.parse(raw ?? "")).toEqual({
      PROJ: {
        fetched_at: expect.any(Number),
        statuses: [
          { id: 1, name: "未対応" },
          { id: 2, name: "処理中" },
          { id: 4, name: "完了" },
        ],
      },
    });
    expect(raw).not.toContain("backlog-at-");
    expect(raw).not.toContain("#ea2c00");
  });

  it("status_add が成功すると、そのユーザーのキャッシュが消え、次の issue_list は状態一覧を引き直す", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects`]: () => jsonResponse([{ id: 10, projectKey: "PROJ" }]),
      [`GET ${API}/projects/PROJ/statuses`]: () => jsonResponse(STATUSES),
      [`POST ${API}/projects/PROJ/statuses`]: () =>
        jsonResponse({ id: 101, projectId: 10, name: "検証中", color: "#ea2c00" }),
      [`GET ${API}/issues`]: () => jsonResponse([]),
    });
    await call(token, "logbutler_issue_list", { status_id: "not-closed" });
    expect(await env.OAUTH_KV.get("statuses:42")).not.toBeNull();

    const added = await readRpc(
      await call(token, "logbutler_status_add", {
        project_key: "PROJ",
        name: "検証中",
        color: "#ea2c00",
      }),
    );
    expect(added.result?.isError, firstText(added)).toBeFalsy();
    expect(await env.OAUTH_KV.get("statuses:42")).toBeNull();

    await call(token, "logbutler_issue_list", { status_id: "not-closed" });
    expect(statusLists(calls)).toHaveLength(2);
    expect(await env.OAUTH_KV.get("statuses:42")).not.toBeNull();
  });

  it("my_tasks も同じキャッシュを使う(issue_list で温まっていれば状態一覧を引かない)", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/users/myself`]: () => jsonResponse({ id: 42, userId: "u", name: "U" }),
      [`GET ${API}/projects`]: () => jsonResponse([{ id: 10, projectKey: "PROJ" }]),
      [`GET ${API}/projects/PROJ/statuses`]: () => jsonResponse(STATUSES),
      [`GET ${API}/issues`]: () => jsonResponse([]),
      [`GET ${API}/users/42/watchings`]: () => jsonResponse([]),
    });
    await call(token, "logbutler_issue_list", { status_id: "not-closed" });
    const rpc = await readRpc(await call(token, "logbutler_my_tasks", {}));
    expect(rpc.result?.isError, firstText(rpc)).toBeFalsy();
    expect(statusLists(calls)).toHaveLength(1);
  });
});

describe("E2E 17b: 状態一覧の上限 200 と途中 flush(ADR 0017)", () => {
  const projects = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: i + 1, projectKey: `P${i}` }));
  const statusHandlers = (n: number, failAt = -1) =>
    Object.fromEntries(
      projects(n).map((p, i) => [
        `GET ${API}/projects/${p.projectKey}/statuses`,
        () =>
          i === failAt
            ? jsonResponse({ errors: [{ message: "x", code: 11 }] }, 403)
            : jsonResponse(STATUSES),
      ]),
    );

  it("参加プロジェクトが 150 件でも issue_list(not-closed・指定なし)は全プロジェクトの状態一覧を引き、KV に 150 件入る", async () => {
    const { token, calls } = await loggedIn({
      [`GET ${API}/projects`]: () => jsonResponse(projects(150)),
      ...statusHandlers(150),
      [`GET ${API}/issues`]: () => jsonResponse([]),
    });
    const rpc = await readRpc(
      await call(token, "logbutler_issue_list", { status_id: "not-closed" }),
    );
    expect(rpc.result?.isError, firstText(rpc)).toBeFalsy();
    expect(statusLists(calls)).toHaveLength(150);
    const stored = JSON.parse((await env.OAUTH_KV.get("statuses:42")) ?? "{}");
    expect(Object.keys(stored)).toHaveLength(150);
  });

  it("201 件では argument_error。45 件目で失敗しても、引けた 44 件は実 KV に残り、次の呼び出しは続きから引く", async () => {
    const over = await loggedIn({ [`GET ${API}/projects`]: () => jsonResponse(projects(201)) });
    const tooMany = await readRpc(
      await call(over.token, "logbutler_issue_list", { status_id: "not-closed" }),
    );
    expect(tooMany.result?.isError).toBe(true);
    expect(JSON.parse(firstText(tooMany)).error.code).toBe("argument_error");

    const failing = await loggedIn({
      [`GET ${API}/projects`]: () => jsonResponse(projects(60)),
      ...statusHandlers(60, 44),
      [`GET ${API}/issues`]: () => jsonResponse([]),
    });
    const first = await readRpc(
      await call(failing.token, "logbutler_issue_list", { status_id: "not-closed" }),
    );
    expect(first.result?.isError).toBe(true);
    expect(statusLists(failing.calls)).toHaveLength(45);
    const kept = JSON.parse((await env.OAUTH_KV.get("statuses:42")) ?? "{}");
    expect(Object.keys(kept)).toHaveLength(44);
    expect(JSON.stringify(Object.keys(kept))).not.toContain("P44");

    const ok = await loggedIn({
      [`GET ${API}/projects`]: () => jsonResponse(projects(60)),
      ...statusHandlers(60),
      [`GET ${API}/issues`]: () => jsonResponse([]),
    });
    const second = await readRpc(
      await call(ok.token, "logbutler_issue_list", { status_id: "not-closed" }),
    );
    expect(second.result?.isError, firstText(second)).toBeFalsy();
    expect(statusLists(ok.calls)).toHaveLength(16);
    expect(statusLists(ok.calls)[0]).toBe("GET /projects/P44/statuses");
    expect(Object.keys(JSON.parse((await env.OAUTH_KV.get("statuses:42")) ?? "{}"))).toHaveLength(
      60,
    );
  });
});
