// PUT /uploads/:id(添付アップロードの URL 経路。ADR 0018)。Hono アプリに直接 HTTP を渡して確かめる(OAuth の外側)。
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/app";
import type { Env } from "../../src/env";
import { handleUploadPut } from "../../src/uploads/put";
import {
  createUploadTicket,
  MAX_URL_UPLOAD_BYTES,
  UPLOAD_PUT_WINDOW_MS,
  uploadKeys,
} from "../../src/uploads/store";

const ORIGIN = "https://logbutler.test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function bucket(): R2Bucket {
  const b = (env as unknown as Env).UPLOAD_BUCKET;
  if (!b) throw new Error("UPLOAD_BUCKET の binding がない");
  return b;
}

/**
 * workerd で組み立てた Request には Content-Length が付かない(実際の curl -T は付ける)。
 * 文字列の本文には、実際のクライアントと同じ Content-Length を付けて送る。
 */
function put(id: string, init: RequestInit & { headers?: Record<string, string> }, e?: Env) {
  const headers =
    typeof init.body === "string"
      ? { "Content-Length": String(new TextEncoder().encode(init.body).length), ...init.headers }
      : init.headers;
  return app.fetch(
    new Request(`${ORIGIN}/uploads/${id}`, { method: "PUT", ...init, headers }),
    e ?? (env as unknown as Env),
    ctx,
  );
}

/** 長さの分からない本文(Content-Length が付かない)。 */
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

async function newTicket(now = new Date()) {
  return createUploadTicket(bucket(), 42, now);
}

/** どのメソッドを呼んでも失敗する R2(R2 を読まずに返すことの確認用)。 */
const untouchable = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`R2 に触れた: ${String(prop)}`);
    },
  },
) as R2Bucket;

describe("PUT /uploads/:id", () => {
  it("保存して 201、本文は {upload_id, size} だけ。no-store で、CORS のヘッダは付けない", async () => {
    const { id } = await newTicket();
    const res = await put(id, { body: "hello" });
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await res.json()).toEqual({ upload_id: id, size: 5 });
    const stored = await bucket().get(uploadKeys(id).data);
    expect(await stored?.text()).toBe("hello");
  });

  it("2 回目の PUT は 409(上書きしない)", async () => {
    const { id } = await newTicket();
    expect((await put(id, { body: "first" })).status).toBe(201);
    const second = await put(id, { body: "second" });
    expect(second.status).toBe(409);
    expect(await (await bucket().get(uploadKeys(id).data))?.text()).toBe("first");
  });

  it("binding が無い Worker では 404(ticket があっても)", async () => {
    const { id } = await newTicket();
    const { UPLOAD_BUCKET: _omit, ...rest } = env as unknown as Env;
    const res = await put(id, { body: "x" }, rest as Env);
    expect(res.status).toBe(404);
  });

  it.each([
    ["短い", "abc"],
    ["44 文字", "A".repeat(44)],
    ["42 文字", "A".repeat(42)],
    ["base64url 以外の文字", `${"A".repeat(42)}.`],
    ["base64 の + /", `${"A".repeat(41)}+/`],
  ])("ID の形式が不正(%s)なら R2 を読まずに 404", async (_label, id) => {
    const res = await put(
      encodeURIComponent(id),
      { body: "x" },
      {
        ...(env as unknown as Env),
        UPLOAD_BUCKET: untouchable,
      },
    );
    expect(res.status).toBe(404);
  });

  it("発行していない ID は 404", async () => {
    const id = "B".repeat(43);
    expect((await put(id, { body: "x" })).status).toBe(404);
    expect(await bucket().head(uploadKeys(id).data)).toBeNull();
  });

  it("PUT の受付は prepare から 60 秒: 59 秒は受け付け、60 秒は 404(本文を読む前に判定)", async () => {
    const t = Date.now();
    const req = () =>
      new Request(`${ORIGIN}/uploads/x`, {
        method: "PUT",
        body: "hello",
        headers: { "Content-Length": "5" },
      });
    const late = await createUploadTicket(bucket(), 42, new Date(t));
    expect((await handleUploadPut(req(), bucket(), late.id, t + UPLOAD_PUT_WINDOW_MS)).status).toBe(
      404,
    );
    expect(await bucket().head(uploadKeys(late.id).data)).toBeNull();
    const inTime = await createUploadTicket(bucket(), 42, new Date(t));
    expect((await handleUploadPut(req(), bucket(), inTime.id, t + 59_000)).status).toBe(201);
    expect(UPLOAD_PUT_WINDOW_MS).toBe(60_000);
  });

  it("期限切れの ticket は 404(保存しない)", async () => {
    const { id } = await newTicket(new Date(Date.now() - UPLOAD_PUT_WINDOW_MS - 1000));
    expect((await put(id, { body: "x" })).status).toBe(404);
    expect(await bucket().head(uploadKeys(id).data)).toBeNull();
  });

  it("Content-Length が無ければ 411", async () => {
    const { id } = await newTicket();
    const res = await put(id, { body: streamOf("hello") });
    expect(res.status).toBe(411);
    expect(await bucket().head(uploadKeys(id).data)).toBeNull();
  });

  it("Content-Length が 0 なら 400(0 バイトのファイルは添付できない)", async () => {
    const { id } = await newTicket();
    const res = await put(id, { body: "" });
    expect(res.status).toBe(400);
    expect(await bucket().head(uploadKeys(id).data)).toBeNull();
  });

  it("上限(20 MiB)を超える Content-Length は本文を読まずに 413", async () => {
    const { id } = await newTicket();
    const res = await put(id, {
      body: streamOf("x"),
      headers: { "Content-Length": String(MAX_URL_UPLOAD_BYTES + 1) },
    });
    expect(res.status).toBe(413);
    expect(await bucket().head(uploadKeys(id).data)).toBeNull();
  });

  it("保存した大きさが Content-Length と違えば、消して 400", async () => {
    const { id } = await newTicket();
    // 実際の R2 に保存したうえで、put が返す size だけをずらす(申告と実体の食い違いを再現する)
    const real = bucket();
    const skewed = new Proxy(real, {
      get(target, prop) {
        if (prop !== "put") return Reflect.get(target, prop).bind(target);
        return async (...args: Parameters<R2Bucket["put"]>) => {
          const obj = await target.put(...args);
          return (
            obj &&
            new Proxy(obj, { get: (o, p) => (p === "size" ? o.size + 1 : Reflect.get(o, p)) })
          );
        };
      },
    }) as R2Bucket;
    const res = await put(
      id,
      { body: "hello" },
      { ...(env as unknown as Env), UPLOAD_BUCKET: skewed },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "size_mismatch" });
    expect(await real.head(uploadKeys(id).data)).toBeNull();
  });

  it("put が例外(本文が Content-Length と食い違って途中で切れた、など)なら 503 で、何も書かれず再送できる", async () => {
    const { id } = await newTicket();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await put(id, { body: streamOf("hello"), headers: { "Content-Length": "3" } });
    expect(res.status).toBe(503);
    expect(await bucket().head(uploadKeys(id).data)).toBeNull();
    expect((await put(id, { body: "hello" })).status).toBe(201);
  });

  it("GET など他のメソッドは無い(404)", async () => {
    const { id } = await newTicket();
    await put(id, { body: "hello" });
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await app.fetch(
        new Request(`${ORIGIN}/uploads/${id}`, { method }),
        env as unknown as Env,
        ctx,
      );
      expect(res.status, method).toBe(404);
    }
  });

  it("R2 の想定外の失敗は 503。例外の文面(キー = upload_id を含みうる)はログにも応答にも出さない", async () => {
    const id = "D".repeat(43);
    const failing = new Proxy(
      {},
      {
        get() {
          return async () => {
            throw new Error(`R2 failure on ticket/${id}`);
          };
        },
      },
    ) as R2Bucket;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await put(
      id,
      { body: "x" },
      { ...(env as unknown as Env), UPLOAD_BUCKET: failing },
    );
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(id);
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("upload_storage_failed");
    expect(logged).not.toContain(id);
  });
});

afterEach(() => vi.restoreAllMocks());
