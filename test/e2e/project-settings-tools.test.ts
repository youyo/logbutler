/**
 * プロジェクト設定ツール 12 個(ADR 0013)。OAuth 済みトークンで /mcp(Worker 全体への HTTP)から呼び、
 * 公開(既定 all で見える・toolsets=project_settings で 12 個だけ・read_only=true で消える)と
 * Backlog への写像を固定する。Backlog はモック。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";
import {
  BACKLOG_HOST,
  firstText,
  MCP_URL,
  mcpRequest,
  modernRequest,
  readRpc,
  runAuthorizationFlow,
  setupMocks,
  type TokenSet,
} from "../helpers/oauth-flow";

afterEach(() => vi.restoreAllMocks());

const API = `${BACKLOG_HOST}/api/v2`;

async function loggedIn(handlers: Parameters<typeof mockOutboundFetch>[0] = {}) {
  await setupMocks();
  const flow = await runAuthorizationFlow();
  const { access_token } = (await flow.tokenResponse.json()) as TokenSet;
  vi.restoreAllMocks();
  return { token: access_token, ...mockOutboundFetch(handlers) };
}

const SETTINGS_TOOLS = ["category", "version", "status", "custom_field"]
  .flatMap((r) => ["add", "update", "delete"].map((a) => `logbutler_${r}_${a}`))
  .sort();

/**
 * tools/list の結果。応答が成功(200 で result.tools あり)でなければ失敗させる。
 * `?.tools ?? []` で握りつぶすと、404 などのエラー応答も「空」に見えて通ってしまう(過去にそれで見逃した)。
 */
async function listedTools(token: string, query: string) {
  const res = await mcpRequest(token, "tools/list", {}, `${MCP_URL}${query}`);
  expect(res.status, `tools/list ${query}`).toBe(200);
  const tools = (await readRpc(res)).result?.tools;
  expect(tools, `tools/list ${query} に result.tools がない`).toBeDefined();
  return tools ?? [];
}

const toolNames = async (token: string, query = "") =>
  (await listedTools(token, query)).map((t) => t.name).sort();

describe("E2E 16: プロジェクト設定ツールの公開", () => {
  it("既定(toolsets=all)で 12 個とも tools/list に出る", async () => {
    const { token } = await loggedIn();
    const names = await toolNames(token);
    for (const n of SETTINGS_TOOLS) expect(names, n).toContain(n);
    expect(names).toHaveLength(86);
  });

  it("toolsets=project_settings で、この 12 個だけになる", async () => {
    const { token } = await loggedIn();
    expect(await toolNames(token, "?toolsets=project_settings")).toEqual(SETTINGS_TOOLS);
  });

  it("read_only=true では 12 個とも tools/list に出ない", async () => {
    const { token } = await loggedIn();
    const ro = await toolNames(token, "?read_only=true");
    for (const n of SETTINGS_TOOLS) expect(ro, n).not.toContain(n);
    expect(ro).toContain("logbutler_meta_statuses"); // 読み取りは残る
  });

  it("toolsets=project_settings&read_only=true は公開ツールが 0 個になるので、両レーンとも 400 で理由を返す(空の 200 や 404 ではない)", async () => {
    const { token, calls } = await loggedIn();
    const url = `${MCP_URL}?toolsets=project_settings&read_only=true`;
    for (const pending of [
      mcpRequest(token, "tools/list", {}, url),
      modernRequest(token, "tools/list", {}, { url }),
    ]) {
      const res = await pending;
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("invalid_query");
      expect(text).toContain("toolsets=project_settings");
      expect(text).toContain("read_only=true");
      expect(text).toContain("ツールがありません");
    }
    expect(calls).toHaveLength(0);
  });

  it("read_only=true では呼び出しも拒否され、Backlog には何も送らない", async () => {
    const { token, calls } = await loggedIn();
    for (const [name, args] of [
      ["logbutler_category_add", { project_key: "PROJ", name: "x" }],
      ["logbutler_category_update", { project_key: "PROJ", category_id: 1, name: "x" }],
      ["logbutler_category_delete", { project_key: "PROJ", category_id: 1 }],
      ["logbutler_version_add", { project_key: "PROJ", name: "x" }],
      ["logbutler_version_update", { project_key: "PROJ", version_id: 1, name: "x" }],
      ["logbutler_version_delete", { project_key: "PROJ", version_id: 1 }],
      ["logbutler_status_add", { project_key: "PROJ", name: "x", color: "#ea2c00" }],
      ["logbutler_status_update", { project_key: "PROJ", status_id: 5, name: "x" }],
      ["logbutler_status_delete", { project_key: "PROJ", status_id: 5, substitute_status_id: 1 }],
      ["logbutler_custom_field_add", { project_key: "PROJ", type_id: 1, name: "x" }],
      ["logbutler_custom_field_update", { project_key: "PROJ", custom_field_id: 1, name: "x" }],
      ["logbutler_custom_field_delete", { project_key: "PROJ", custom_field_id: 1 }],
    ] as const) {
      const res = await mcpRequest(
        token,
        "tools/call",
        { name, arguments: args },
        `${MCP_URL}?read_only=true`,
      );
      const rpc = await readRpc(res);
      expect(rpc.error !== undefined || rpc.result?.isError === true, name).toBe(true);
    }
    expect(calls).toEqual([]);
  });
});

type Case = {
  tool: string;
  args: Record<string, unknown>;
  method: string;
  path: string;
  form: string[];
  response: unknown;
};

const category = { id: 1, projectId: 5, name: "Dev", displayOrder: 0 };
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

const CASES: Case[] = [
  {
    tool: "category_add",
    args: { project_key: "PROJ", name: "Dev" },
    method: "POST",
    path: "/projects/PROJ/categories",
    form: ["name=Dev"],
    response: category,
  },
  {
    tool: "category_update",
    args: { project_key: "PROJ", category_id: 1, name: "Dev2" },
    method: "PATCH",
    path: "/projects/PROJ/categories/1",
    form: ["name=Dev2"],
    response: category,
  },
  {
    tool: "category_delete",
    args: { project_key: "PROJ", category_id: 1 },
    method: "DELETE",
    path: "/projects/PROJ/categories/1",
    form: [],
    response: category,
  },
  {
    tool: "version_add",
    args: { project_key: "PROJ", name: "v1", start_date: "2026-11-01" },
    method: "POST",
    path: "/projects/PROJ/versions",
    form: ["name=v1", "startDate=2026-11-01"],
    response: version,
  },
  {
    tool: "version_update",
    args: { project_key: "PROJ", version_id: 3, name: "v1", archived: true },
    method: "PATCH",
    path: "/projects/PROJ/versions/3",
    form: ["archived=true", "name=v1"],
    response: version,
  },
  {
    tool: "version_delete",
    args: { project_key: "PROJ", version_id: 3 },
    method: "DELETE",
    path: "/projects/PROJ/versions/3",
    form: [],
    response: version,
  },
  {
    tool: "status_add",
    args: { project_key: "PROJ", name: "Waiting", color: "#e87758" },
    method: "POST",
    path: "/projects/PROJ/statuses",
    form: ["color=#e87758", "name=Waiting"],
    response: status,
  },
  {
    tool: "status_update",
    args: { project_key: "PROJ", status_id: 101, color: "#3b9dbd" },
    method: "PATCH",
    path: "/projects/PROJ/statuses/101",
    form: ["color=#3b9dbd"],
    response: status,
  },
  {
    tool: "status_delete",
    args: { project_key: "PROJ", status_id: 101, substitute_status_id: 1 },
    method: "DELETE",
    path: "/projects/PROJ/statuses/101",
    form: ["substituteStatusId=1"],
    response: status,
  },
  {
    tool: "custom_field_add",
    args: {
      project_key: "PROJ",
      type_id: 5,
      name: "L",
      items: ["a", "b"],
      applicable_issue_type_ids: "1",
    },
    method: "POST",
    path: "/projects/PROJ/customFields",
    form: ["applicableIssueTypes[]=1", "items[]=a", "items[]=b", "name=L", "typeId=5"],
    response: field,
  },
  {
    tool: "custom_field_update",
    args: { project_key: "PROJ", custom_field_id: 2, required: true },
    method: "PATCH",
    path: "/projects/PROJ/customFields/2",
    form: ["required=true"],
    response: field,
  },
  {
    tool: "custom_field_delete",
    args: { project_key: "PROJ", custom_field_id: 2 },
    method: "DELETE",
    path: "/projects/PROJ/customFields/2",
    form: [],
    response: field,
  },
];

describe("E2E 16: プロジェクト設定ツールの呼び出し", () => {
  it.each(CASES)("$tool: $method $path に写像し、Backlog の生データをそのまま返す", async (c) => {
    const { token, calls } = await loggedIn({
      [`${c.method} ${API}${c.path}`]: () => jsonResponse(c.response),
    });
    const res = await mcpRequest(token, "tools/call", {
      name: `logbutler_${c.tool}`,
      arguments: c.args,
    });
    const rpc = await readRpc(res);
    expect(rpc.result?.isError, firstText(rpc)).toBeFalsy();
    expect(JSON.parse(firstText(rpc))).toEqual(c.response);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe(c.method);
    expect(call?.headers.get("authorization")).toMatch(/^Bearer backlog-at-/);
    const pairs = [...new URLSearchParams(call?.body ?? "").entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort();
    expect(pairs).toEqual(c.form);
  });

  it("管理者権限がない(Backlog が 403)と permission_error のエンベロープ", async () => {
    const { token } = await loggedIn({
      [`POST ${API}/projects/PROJ/categories`]: () =>
        jsonResponse({ errors: [{ message: "No permission.", code: 6 }] }, 403),
    });
    const rpc = await readRpc(
      await mcpRequest(token, "tools/call", {
        name: "logbutler_category_add",
        arguments: { project_key: "PROJ", name: "x" },
      }),
    );
    expect(rpc.result?.isError).toBe(true);
    const body = JSON.parse(firstText(rpc));
    expect(body.schema_version).toBe("1");
    expect(body.error.code).toBe("permission_error");
  });

  it("不正な引数(状態の削除で substitute_status_id なし)は argument_error で Backlog を呼ばない", async () => {
    const { token, calls } = await loggedIn();
    const rpc = await readRpc(
      await mcpRequest(token, "tools/call", {
        name: "logbutler_status_delete",
        arguments: { project_key: "PROJ", status_id: 101 },
      }),
    );
    expect(rpc.result?.isError).toBe(true);
    expect(JSON.parse(firstText(rpc)).error.code).toBe("argument_error");
    expect(calls).toEqual([]);
  });

  it("add は非冪等: 同じ引数の再送は Backlog に 1 回しか届かない(冪等キャッシュ)", async () => {
    const { token, calls } = await loggedIn({
      [`POST ${API}/projects/PROJ/categories`]: () => jsonResponse(category),
    });
    const args = { project_key: "PROJ", name: "Dev (idempotency)" };
    const call = async () =>
      readRpc(
        await mcpRequest(token, "tools/call", { name: "logbutler_category_add", arguments: args }),
      );
    const first = await call();
    const again = await call();
    expect(firstText(again)).toBe(firstText(first));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});
