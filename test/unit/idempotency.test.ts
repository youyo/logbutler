import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ArgumentError } from "../../src/errors";
import { defineTool, type ToolCategory, type ToolDefinition } from "../../src/mcp/registry";
import { createMcpServer } from "../../src/mcp/server";
import { FakeKv } from "../helpers/fake-kv";
import { fakeClient, rpcTo } from "../helpers/mcp";
import { firstText } from "../helpers/oauth-flow";

afterEach(() => vi.restoreAllMocks());

/** 呼ばれた回数を数えるツール。実行のたびに違う値(n)を返す。 */
function counting(name: string, category: ToolCategory, opts: { failFirst?: boolean } = {}) {
  const state = { runs: 0 };
  const tool: ToolDefinition = defineTool({
    name,
    title: "t",
    description: "d",
    category,
    toolset: "issue",
    inputSchema: z.object({ summary: z.string(), tag: z.string().optional() }),
    handler: async (a) => {
      state.runs++;
      if (opts.failFirst && state.runs === 1) throw new ArgumentError("first run fails");
      return { n: state.runs, summary: a.summary };
    },
  });
  return { tool, state };
}

async function run(
  tools: ToolDefinition[],
  name: string,
  args: Record<string, unknown>,
  o: { kv?: FakeKv; userId?: number; meta?: Record<string, unknown> } = {},
) {
  const kv = o.kv ?? new FakeKv();
  const res = await rpcTo(
    () =>
      createMcpServer({
        tools,
        getClient: () => fakeClient(),
        onBacklogUnauthorized: () => {},
        idempotency: { kv, userId: o.userId ?? 42 },
      }),
    "tools/call",
    { name, arguments: args, ...(o.meta ? { _meta: o.meta } : {}) },
  );
  return { text: firstText(res), isError: res.result?.isError === true, kv };
}

const sha256hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const CREATE = "logbutler_issue_create";

describe("冪等キャッシュ(WriteNonIdempotent のみ)", () => {
  it("同じ引数の 2 回目は実行せず、初回と同じ結果を返す(重複の印は付けない)", async () => {
    const { tool, state } = counting(CREATE, "WriteNonIdempotent");
    const kv = new FakeKv();
    const first = await run([tool], CREATE, { summary: "s" }, { kv });
    const second = await run([tool], CREATE, { summary: "s" }, { kv });
    expect(state.runs).toBe(1);
    expect(second.text).toBe(first.text);
    expect(JSON.parse(second.text)).toEqual({ n: 1, summary: "s" });
  });

  it("引数が違えば別の呼び出し", async () => {
    const { tool, state } = counting(CREATE, "WriteNonIdempotent");
    const kv = new FakeKv();
    await run([tool], CREATE, { summary: "a" }, { kv });
    await run([tool], CREATE, { summary: "b" }, { kv });
    expect(state.runs).toBe(2);
  });

  it("キー形式 idem:<userId>:<tool>:hash:<sha256(canonical JSON)>、TTL 300 秒。引数のキー順は無関係", async () => {
    const { tool, state } = counting(CREATE, "WriteNonIdempotent");
    const kv = new FakeKv();
    await run([tool], CREATE, { summary: "s", tag: "t" }, { kv });
    const digest = await sha256hex('{"summary":"s","tag":"t"}');
    const key = `idem:42:${CREATE}:hash:${digest}`;
    expect([...kv.store.keys()]).toEqual([key]);
    expect(kv.store.get(key)?.expirationTtl).toBe(300);
    // キーの順序を入れ替えても同じ呼び出しとみなす
    await run([tool], CREATE, { tag: "t", summary: "s" }, { kv });
    expect(state.runs).toBe(1);
  });

  it("保存するのは結果の JSON だけ(トークンやクライアントの情報を含めない)", async () => {
    const { tool } = counting(CREATE, "WriteNonIdempotent");
    const kv = new FakeKv();
    await run([tool], CREATE, { summary: "s" }, { kv });
    const [entry] = [...kv.store.values()];
    expect(JSON.parse(entry?.value ?? "")).toEqual({ n: 1, summary: "s" });
  });

  it("ユーザーごとに分離する: 別ユーザーの同一引数は衝突しない", async () => {
    const { tool, state } = counting(CREATE, "WriteNonIdempotent");
    const kv = new FakeKv();
    await run([tool], CREATE, { summary: "s" }, { kv, userId: 1 });
    await run([tool], CREATE, { summary: "s" }, { kv, userId: 2 });
    expect(state.runs).toBe(2);
    expect([...kv.store.keys()].map((k) => k.split(":")[1]).sort()).toEqual(["1", "2"]);
  });

  it("ツールごとに分離する: 同じ明示キーでも別ツールは別の呼び出し", async () => {
    const a = counting("logbutler_issue_create", "WriteNonIdempotent");
    const b = counting("logbutler_issue_comment_add", "WriteNonIdempotent");
    const kv = new FakeKv();
    const meta = { idempotency_key: "k1" };
    await run([a.tool, b.tool], "logbutler_issue_create", { summary: "s" }, { kv, meta });
    await run([a.tool, b.tool], "logbutler_issue_comment_add", { summary: "s" }, { kv, meta });
    expect(a.state.runs).toBe(1);
    expect(b.state.runs).toBe(1);
  });

  it("params._meta.idempotency_key: 引数が違っても同じキーなら同一視。キーは explicit", async () => {
    const { tool, state } = counting(CREATE, "WriteNonIdempotent");
    const kv = new FakeKv();
    const meta = { idempotency_key: "req-1" };
    const first = await run([tool], CREATE, { summary: "a" }, { kv, meta });
    const second = await run([tool], CREATE, { summary: "b" }, { kv, meta });
    expect(state.runs).toBe(1);
    expect(second.text).toBe(first.text);
    expect([...kv.store.keys()]).toEqual([`idem:42:${CREATE}:explicit:req-1`]);
  });

  it("引数の idempotency_key も受け取る。_meta が優先", async () => {
    const { tool, state } = counting(CREATE, "WriteNonIdempotent");
    const kv = new FakeKv();
    await run([tool], CREATE, { summary: "a", idempotency_key: "arg-1" }, { kv });
    await run([tool], CREATE, { summary: "b", idempotency_key: "arg-1" }, { kv });
    expect(state.runs).toBe(1);
    expect([...kv.store.keys()]).toEqual([`idem:42:${CREATE}:explicit:arg-1`]);

    await run(
      [tool],
      CREATE,
      { summary: "c", idempotency_key: "arg-2" },
      { kv, meta: { idempotency_key: "meta-2" } },
    );
    expect([...kv.store.keys()]).toContain(`idem:42:${CREATE}:explicit:meta-2`);
    expect([...kv.store.keys()]).not.toContain(`idem:42:${CREATE}:explicit:arg-2`);
  });

  it("idempotency_key は inputSchema に宣言しない(未知の引数としてもエラーにならない)", async () => {
    const { tool } = counting(CREATE, "WriteNonIdempotent");
    expect(Object.keys(tool.inputSchema.shape)).not.toContain("idempotency_key");
    const r = await run([tool], CREATE, { summary: "s", idempotency_key: "k" });
    expect(r.isError).toBe(false);
  });

  it("空・文字列でない明示キーは無視してハッシュにフォールバック", async () => {
    const { tool } = counting(CREATE, "WriteNonIdempotent");
    const kv = new FakeKv();
    await run([tool], CREATE, { summary: "s" }, { kv, meta: { idempotency_key: "" } });
    await run([tool], CREATE, { summary: "s", idempotency_key: 5 }, { kv });
    expect([...kv.store.keys()].every((k) => k.includes(":hash:"))).toBe(true);
  });

  it("長すぎる明示キー(KV のキー上限を超えうる)は argument_error。実行しない", async () => {
    const { tool, state } = counting(CREATE, "WriteNonIdempotent");
    const r = await run(
      [tool],
      CREATE,
      { summary: "s" },
      { meta: { idempotency_key: "x".repeat(201) } },
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text).error.code).toBe("argument_error");
    expect(state.runs).toBe(0);
  });

  it("明示キーの上限は文字数ではなくバイト長（日本語は 1 文字 3 バイト。KV のキーは 512 バイトまで）", async () => {
    const { tool, state } = counting(CREATE, "WriteNonIdempotent");
    const tooLong = await run(
      [tool],
      CREATE,
      { summary: "s" },
      { meta: { idempotency_key: "あ".repeat(100) } }, // 100 文字 = 300 バイト
    );
    expect(JSON.parse(tooLong.text).error.code).toBe("argument_error");
    expect(state.runs).toBe(0);
    const ok = await run(
      [tool],
      CREATE,
      { summary: "s" },
      { meta: { idempotency_key: "a".repeat(200) } },
    );
    expect(ok.isError).toBe(false);
    const jp = await run(
      [tool],
      CREATE,
      { summary: "s" },
      { meta: { idempotency_key: "あ".repeat(66) } }, // 198 バイト
    );
    expect(jp.isError).toBe(false);
  });

  it("成功した結果だけ保存する: エラーは保存せず、再試行で再実行される", async () => {
    const { tool, state } = counting(CREATE, "WriteNonIdempotent", { failFirst: true });
    const kv = new FakeKv();
    const first = await run([tool], CREATE, { summary: "s" }, { kv });
    expect(first.isError).toBe(true);
    expect(kv.store.size).toBe(0);
    const second = await run([tool], CREATE, { summary: "s" }, { kv });
    expect(second.isError).toBe(false);
    expect(state.runs).toBe(2);
    expect(kv.store.size).toBe(1);
  });

  it("引数が不正（検証エラー）なら KV に触れない", async () => {
    const { tool } = counting(CREATE, "WriteNonIdempotent");
    const kv = new FakeKv();
    const r = await run([tool], CREATE, {}, { kv });
    expect(r.isError).toBe(true);
    expect(kv.gets).toEqual([]);
  });

  it("WriteNonIdempotent 以外(ReadOnly / WriteIdempotent / Destructive)はキャッシュしない", async () => {
    for (const category of ["ReadOnly", "WriteIdempotent", "Destructive"] as const) {
      const name = `logbutler_issue_${category.toLowerCase()}`;
      const { tool, state } = counting(name, category);
      const kv = new FakeKv();
      await run([tool], name, { summary: "s" }, { kv });
      await run([tool], name, { summary: "s" }, { kv });
      expect(state.runs, category).toBe(2);
      expect(kv.gets, category).toEqual([]);
      expect(kv.puts, category).toEqual([]);
    }
  });

  it("KV の読み取りが失敗しても実行する(best-effort)。書き込みの失敗は結果を妨げない", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { tool, state } = counting(CREATE, "WriteNonIdempotent");
    const kv = new FakeKv();
    kv.failGet = true;
    const a = await run([tool], CREATE, { summary: "s" }, { kv });
    expect(a.isError).toBe(false);
    kv.failGet = false;
    kv.failPut = true;
    const b = await run([tool], CREATE, { summary: "t" }, { kv });
    expect(b.isError).toBe(false);
    expect(state.runs).toBe(2);
  });

  it("冪等キャッシュの設定がなければ素通し(毎回実行)", async () => {
    const { tool, state } = counting(CREATE, "WriteNonIdempotent");
    const factory = () =>
      createMcpServer({
        tools: [tool],
        getClient: () => fakeClient(),
        onBacklogUnauthorized: () => {},
      });
    await rpcTo(factory, "tools/call", { name: CREATE, arguments: { summary: "s" } });
    await rpcTo(factory, "tools/call", { name: CREATE, arguments: { summary: "s" } });
    expect(state.runs).toBe(2);
  });
});
