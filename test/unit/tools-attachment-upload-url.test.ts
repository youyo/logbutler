// 添付アップロードの URL 経路(ADR 0018): prepare → PUT /uploads/<id> → issue_attachment_upload(upload_id)。
// 完了処理の状態(claim)の遷移を、Backlog への呼び出しと応答で固定する。
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/app";
import type { Env } from "../../src/env";
import type { UploadDeps } from "../../src/uploads/attach";
import {
  CLAIM_LEASE_MS,
  COMPLETE_WINDOW_MS,
  MAX_URL_UPLOAD_BYTES,
  UPLOAD_PUT_WINDOW_MS,
  uploadKeys,
} from "../../src/uploads/store";
import { jsonResponse } from "../helpers/mock-fetch";
import { callTool, formPairs, type Respond, type ToolRun } from "../helpers/tool-call";

const PREPARE = "logbutler_issue_attachment_upload_prepare";
const UPLOAD = "logbutler_issue_attachment_upload";
const UID = 42;
/** ツールの時刻(ToolContext.now)。PUT /uploads は実時刻で ticket の期限を見るので、実時刻に合わせる。 */
const T0 = new Date();
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const uploaded = { id: 77, name: "hello.txt", size: 5 };
const issue = { id: 1, issueKey: "PROJ-1" };
const OK: Record<string, Respond> = {
  "POST /space/attachment": uploaded,
  "PATCH /issues/PROJ-1": issue,
};

function bucket(): R2Bucket {
  const b = (env as unknown as Env).UPLOAD_BUCKET;
  if (!b) throw new Error("UPLOAD_BUCKET の binding がない");
  return b;
}

function deps(userId = UID): UploadDeps {
  return { bucket: bucket(), userId, baseUrl: "https://logbutler.test" };
}

async function prepare(now = new Date(), userId = UID): Promise<ToolRun> {
  return callTool(PREPARE, {}, {}, { uploads: deps(userId), now });
}

/** prepare して upload_id を返す。 */
async function prepareId(now = new Date(), userId = UID): Promise<string> {
  const run = await prepare(now, userId);
  expect(run.isError, run.text).toBe(false);
  return run.json.upload_id as string;
}

/** 実際の HTTP の入口(PUT /uploads/<id>)で本文を送る。 */
async function putFile(id: string, content: string): Promise<Response> {
  const body = new TextEncoder().encode(content);
  return app.fetch(
    new Request(`https://logbutler.test/uploads/${id}`, {
      method: "PUT",
      body,
      headers: { "Content-Length": String(body.length) },
    }),
    env as unknown as Env,
    ctx,
  );
}

async function readyId(content = "hello", now = new Date()): Promise<string> {
  const id = await prepareId(now);
  expect((await putFile(id, content)).status).toBe(201);
  return id;
}

function complete(
  id: string,
  respond: Record<string, Respond> = OK,
  opts: { now?: Date; userId?: number; issueKey?: string; fileName?: string } = {},
): Promise<ToolRun> {
  return callTool(
    UPLOAD,
    {
      issue_key: opts.issueKey ?? "PROJ-1",
      file_name: opts.fileName ?? "hello.txt",
      upload_id: id,
    },
    respond,
    { uploads: deps(opts.userId ?? UID), now: opts.now ?? new Date() },
  );
}

/** 仕様で決まっている claim の本文(`claim/<id>`)。 */
async function readClaim(id: string): Promise<Record<string, unknown> | null> {
  const obj = await bucket().get(uploadKeys(id).claim);
  return obj ? (JSON.parse(await obj.text()) as Record<string, unknown>) : null;
}

/** 別の Worker が claim を取ったまま止まった状態を作る(claimedAt を指定)。 */
async function writeClaimed(id: string, claimedAt: Date, uid = UID) {
  await bucket().put(
    uploadKeys(id).claim,
    JSON.stringify({
      uid,
      issue_key: "PROJ-1",
      file_name: "hello.txt",
      state: "claimed",
      claimedAt: claimedAt.getTime(),
      nonce: crypto.randomUUID(),
    }),
  );
}

const unreachable = () => {
  throw new TypeError("network connection lost");
};

describe("logbutler_issue_attachment_upload_prepare", () => {
  it("upload_id(43 文字)・upload_url・expires_at(PUT を始める期限 = 60 秒後)・max_bytes・curl と次の手順を返し、Backlog は呼ばない", async () => {
    const run = await prepare(T0);
    expect(run.isError, run.text).toBe(false);
    expect(run.calls).toEqual([]);
    const id = run.json.upload_id as string;
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(run.json.upload_url).toBe(`https://logbutler.test/uploads/${id}`);
    expect(run.json.expires_at).toBe(new Date(T0.getTime() + UPLOAD_PUT_WINDOW_MS).toISOString());
    expect(run.json.max_bytes).toBe(MAX_URL_UPLOAD_BYTES);
    expect(run.json.curl).toBe(`curl -sS --fail -T <path> 'https://logbutler.test/uploads/${id}'`);
    expect(run.json.instructions).toMatch(/60 seconds/);
    expect(run.json.instructions).toMatch(/404.*prepare/);
    expect(run.json.instructions).toMatch(/15 minutes/);
    expect(run.json.instructions).toContain("secret");
    expect(run.json.instructions).toContain("logbutler_issue_attachment_upload");
    expect(run.json.instructions).toMatch(/issue_key.*file_name.*upload_id/);
  });

  it("2 回呼ぶと別の upload_id が返る(冪等キャッシュで同じ URL を返さない)", async () => {
    const a = await prepareId();
    const b = await prepareId();
    expect(a).not.toBe(b);
  });

  it("binding が無い(uploads なし)なら、Backlog を呼ばずにエラー", async () => {
    const run = await callTool(PREPARE, {}, {});
    expect(run.isError).toBe(true);
    expect(run.json.error.code).toBe("argument_error");
    expect(run.calls).toEqual([]);
  });
});

describe("issue_attachment_upload(upload_id)", () => {
  it("正常系: POST /space/attachment(R2 の本文)→ PATCH。返却は課題。ticket と data は消える", async () => {
    const id = await readyId("hello");
    const run = await complete(id);
    expect(run.isError, run.text).toBe(false);
    expect(run.calls).toEqual(["POST /space/attachment", "PATCH /issues/PROJ-1"]);
    expect(run.json).toEqual(issue);
    expect(run.recorded[0]?.headers.get("content-type")).toMatch(/^multipart\/form-data/);
    expect(run.recorded[0]?.body).toContain('name="file"; filename="hello.txt"');
    expect(run.recorded[0]?.body).toContain("\r\n\r\nhello\r\n");
    expect(formPairs(run.recorded[1])).toEqual(["attachmentId[]=77"]);
    expect(await bucket().head(uploadKeys(id).ticket)).toBeNull();
    expect(await bucket().head(uploadKeys(id).data)).toBeNull();
    expect((await readClaim(id))?.state).toBe("done");
  });

  it("file_name はベース名にして送る(base64 の経路と同じ)", async () => {
    const id = await readyId();
    const run = await complete(id, OK, { fileName: "../dir\\a b.txt" });
    expect(run.isError, run.text).toBe(false);
    expect(run.recorded[0]?.body).toContain('filename="a b.txt"');
  });

  it("done の後の再呼び出しは「完了済み」のエラー(Backlog を呼ばない)", async () => {
    const id = await readyId();
    expect((await complete(id)).isError).toBe(false);
    const again = await complete(id);
    expect(again.isError).toBe(true);
    expect(again.json.error.code).toBe("argument_error");
    expect(again.json.error.retryable).toBe(false);
    expect(again.json.error.message).toMatch(/already/i);
    expect(again.calls).toEqual([]);
  });

  describe("引数", () => {
    it.each([
      [
        "upload_id と file_content_base64 の両方",
        { upload_id: "A".repeat(43), file_content_base64: btoa("x") },
      ],
      ["どちらも無い", {}],
    ])("%s は argument_error(Backlog を呼ばない)", async (_l, extra) => {
      const run = await callTool(
        UPLOAD,
        { issue_key: "PROJ-1", file_name: "a.txt", ...extra },
        OK,
        { uploads: deps() },
      );
      expect(run.isError).toBe(true);
      expect(run.json.error.code).toBe("argument_error");
      expect(run.calls).toEqual([]);
    });

    it("upload_id でも file_name は必須(無い・空・ベース名にならない)", async () => {
      const id = await readyId();
      for (const fileName of [undefined, "", "dir/", ".."]) {
        const run = await callTool(
          UPLOAD,
          {
            issue_key: "PROJ-1",
            upload_id: id,
            ...(fileName === undefined ? {} : { file_name: fileName }),
          },
          OK,
          { uploads: deps() },
        );
        expect(run.json.error.code, String(fileName)).toBe("argument_error");
        expect(run.calls).toEqual([]);
      }
      // 引数の誤りでは claim を作らない(正しい引数でそのまま完了できる)
      expect((await complete(id)).isError).toBe(false);
    });

    it("binding が無い(uploads なし)なら、Backlog を呼ばずに明確なエラー", async () => {
      const run = await callTool(
        UPLOAD,
        { issue_key: "PROJ-1", file_name: "a.txt", upload_id: "A".repeat(43) },
        OK,
      );
      expect(run.isError).toBe(true);
      expect(run.json.error.code).toBe("argument_error");
      expect(run.json.error.message).toContain("file_content_base64");
      expect(run.calls).toEqual([]);
    });
  });

  describe("存在しない・期限切れ・所有者違い(どれも同じエラーにし、存在を教えない)", () => {
    async function notFoundEnvelope() {
      const run = await complete("C".repeat(43));
      expect(run.isError).toBe(true);
      expect(run.json.error.code).toBe("not_found");
      expect(run.calls).toEqual([]);
      return run.json;
    }

    it("形式が不正な upload_id も、発行していない upload_id と同じ", async () => {
      const expected = await notFoundEnvelope();
      const run = await complete("not-an-id");
      expect(run.json).toEqual(expected);
      expect(run.calls).toEqual([]);
    });

    it("data が無く、ticket が期限切れ(claim が無いとき)", async () => {
      const expected = await notFoundEnvelope();
      const now = new Date();
      const id = await prepareId(now);
      const run = await complete(id, OK, { now: new Date(now.getTime() + UPLOAD_PUT_WINDOW_MS) });
      expect(run.json).toEqual(expected);
      expect(run.calls).toEqual([]);
      expect(await readClaim(id)).toBeNull();
    });

    it("data の保存から 15 分を過ぎた完了(claim が無いとき)", async () => {
      const expected = await notFoundEnvelope();
      const id = await readyId();
      const saved = (await bucket().head(uploadKeys(id).data))?.uploaded.getTime() ?? 0;
      const run = await complete(id, OK, { now: new Date(saved + COMPLETE_WINDOW_MS + 1) });
      expect(run.json).toEqual(expected);
      expect(run.calls).toEqual([]);
      expect(await readClaim(id)).toBeNull();
      expect(COMPLETE_WINDOW_MS).toBe(15 * 60 * 1000);
    });

    it("uid の不一致(claim が無いときは ticket.uid と照合)", async () => {
      const expected = await notFoundEnvelope();
      const id = await readyId();
      const run = await complete(id, OK, { userId: UID + 1 });
      expect(run.json).toEqual(expected);
      expect(run.calls).toEqual([]);
      expect(await readClaim(id)).toBeNull();
    });

    it("uid の不一致(claim があれば claim.uid と照合)", async () => {
      const expected = await notFoundEnvelope();
      const id = await readyId();
      await complete(id, { ...OK, "POST /space/attachment": unreachable });
      expect((await readClaim(id))?.state).toBe("released");
      const run = await complete(id, OK, { userId: UID + 1 });
      expect(run.json).toEqual(expected);
      expect(run.calls).toEqual([]);
    });
  });

  it("data が無い(PUT がまだ)なら再試行できる「未アップロード」のエラー。claim は作らず、PUT 後に完了できる", async () => {
    const id = await prepareId();
    const early = await complete(id);
    expect(early.isError).toBe(true);
    expect(early.json.error.retryable).toBe(true);
    expect(early.json.error.message).toMatch(/upload_url/);
    expect(early.calls).toEqual([]);
    expect(await readClaim(id)).toBeNull();

    expect((await putFile(id, "hello")).status).toBe(201);
    const run = await complete(id);
    expect(run.isError, run.text).toBe(false);
    expect(run.calls).toEqual(["POST /space/attachment", "PATCH /issues/PROJ-1"]);
  });

  it("data があれば、ticket(PUT の受付 60 秒)が期限切れでも、保存から 15 分以内なら完了できる", async () => {
    const id = await readyId();
    const saved = (await bucket().head(uploadKeys(id).data))?.uploaded.getTime() ?? 0;
    const run = await complete(id, OK, { now: new Date(saved + COMPLETE_WINDOW_MS) });
    expect(run.isError, run.text).toBe(false);
    expect(run.calls).toEqual(["POST /space/attachment", "PATCH /issues/PROJ-1"]);
  });

  it("再試行で issue_key・file_name が claim と違えば argument_error", async () => {
    const id = await readyId();
    await complete(id, { ...OK, "POST /space/attachment": unreachable });
    for (const opts of [{ issueKey: "PROJ-2" }, { fileName: "other.txt" }]) {
      const run = await complete(id, OK, opts);
      expect(run.json.error.code, JSON.stringify(opts)).toBe("argument_error");
      expect(run.calls).toEqual([]);
    }
  });

  describe("POST /space/attachment の失敗 → released → 再試行で引き継ぐ", () => {
    it.each([
      ["応答不明(通信の例外)", unreachable],
      ["明確なエラー応答(400)", () => jsonResponse({ errors: [{ message: "bad", code: 1 }] }, 400)],
      ["5xx", () => jsonResponse({}, 503)],
    ])(
      "%s: 再試行できるエラーにし、課題は更新しない。再試行は POST からやり直す",
      async (_l, failing) => {
        const id = await readyId();
        const first = await complete(id, { ...OK, "POST /space/attachment": failing });
        expect(first.isError).toBe(true);
        expect(first.json.error.retryable).toBe(true);
        expect(first.calls).toEqual(["POST /space/attachment"]);
        expect((await readClaim(id))?.state).toBe("released");

        // ticket の期限は claim があれば見ない(released は lease に関係なく引き継げる)
        const later = new Date(Date.now() + COMPLETE_WINDOW_MS + 60_000);
        const retry = await complete(id, OK, { now: later });
        expect(retry.isError, retry.text).toBe(false);
        expect(retry.calls).toEqual(["POST /space/attachment", "PATCH /issues/PROJ-1"]);
        expect((await readClaim(id))?.state).toBe("done");
      },
    );

    it("Backlog の 401 は元のエラーのまま返し(MCP の 401 に変換させる)、claim は released", async () => {
      const id = await readyId();
      const run = await complete(id, {
        ...OK,
        "POST /space/attachment": () => jsonResponse({ errors: [{ message: "x", code: 11 }] }, 401),
      });
      expect(run.json.error.code).toBe("authentication_error");
      expect((await readClaim(id))?.state).toBe("released");
    });
  });

  it("引き継がれた側(attached への put が不成立)は PATCH を呼ばず、再試行できるエラー", async () => {
    const id = await readyId();
    const run = await complete(id, {
      ...OK,
      // POST の最中に、別の呼び出しが claim を引き継いだ(etag が変わる)
      "POST /space/attachment": async () => {
        await writeClaimed(id, new Date(T0.getTime() + CLAIM_LEASE_MS + 1));
        return jsonResponse(uploaded);
      },
    });
    expect(run.isError).toBe(true);
    expect(run.json.error.retryable).toBe(true);
    expect(run.calls).toEqual(["POST /space/attachment"]);
    expect((await readClaim(id))?.state).toBe("claimed");
  });

  describe("初回の PATCH が明確な 4xx", () => {
    it("コードと retryable は Backlog のまま、文面で「添付されていない・この upload_id はもう使えない・prepare からやり直す」と伝える", async () => {
      const id = await readyId();
      const run = await complete(id, {
        ...OK,
        "PATCH /issues/PROJ-1": () =>
          jsonResponse({ errors: [{ message: "No issue.", code: 6 }] }, 404),
      });
      expect(run.isError).toBe(true);
      expect(run.calls).toEqual(["POST /space/attachment", "PATCH /issues/PROJ-1"]);
      expect(run.json.error.code).toBe("not_found");
      expect(run.json.error.retryable).toBe(false);
      expect(run.json.error.message).toMatch(/not attached/i);
      expect(run.json.error.message).toMatch(/can no longer be used/i);
      expect(run.json.error.message).toContain("logbutler_issue_attachment_upload_prepare");
      expect((await readClaim(id))?.state).toBe("attached");
    });

    it("401 は包まずにそのまま返す(文面を足さない)", async () => {
      const id = await readyId();
      const run = await complete(id, {
        ...OK,
        "PATCH /issues/PROJ-1": () => jsonResponse({ errors: [{ message: "x", code: 11 }] }, 401),
      });
      expect(run.json.error.code).toBe("authentication_error");
      expect(run.json.error.message).not.toContain("logbutler_issue_attachment_upload_prepare");
    });
  });

  describe("attached からの再試行", () => {
    async function attachedId(): Promise<string> {
      const id = await readyId();
      const first = await complete(id, { ...OK, "PATCH /issues/PROJ-1": unreachable });
      expect(first.isError).toBe(true);
      expect(first.json.error.retryable).toBe(true);
      expect(first.calls).toEqual(["POST /space/attachment", "PATCH /issues/PROJ-1"]);
      const claim = await readClaim(id);
      expect(claim?.state).toBe("attached");
      expect(claim?.attachmentId).toBe(77);
      return id;
    }

    it("POST を飛ばし、同じ attachmentId で PATCH だけ。lease も ticket の期限も見ない", async () => {
      const id = await attachedId();
      const muchLater = new Date(T0.getTime() + 24 * 60 * 60 * 1000);
      const retry = await complete(id, OK, { now: muchLater });
      expect(retry.isError, retry.text).toBe(false);
      expect(retry.calls).toEqual(["PATCH /issues/PROJ-1"]);
      expect(formPairs(retry.recorded[0])).toEqual(["attachmentId[]=77"]);
      expect(retry.json).toEqual(issue);
      expect((await readClaim(id))?.state).toBe("done");
    });

    it("lease 内の再試行でも PATCH だけ(attached は lease を見ない)", async () => {
      const id = await attachedId();
      const retry = await complete(id, OK, { now: new Date(T0.getTime() + 1000) });
      expect(retry.isError, retry.text).toBe(false);
      expect(retry.calls).toEqual(["PATCH /issues/PROJ-1"]);
    });

    it("PATCH の応答が再び不明なら、attached のまま再試行できるエラー", async () => {
      const id = await attachedId();
      const retry = await complete(id, {
        ...OK,
        "PATCH /issues/PROJ-1": () => jsonResponse({}, 500),
      });
      expect(retry.json.error.retryable).toBe(true);
      expect(retry.calls).toEqual(["PATCH /issues/PROJ-1"]);
      expect((await readClaim(id))?.state).toBe("attached");
    });

    it("再試行の PATCH を Backlog が 4xx で拒否したら、添付済みの可能性と issue_attachment_list での確認を案内する", async () => {
      const id = await attachedId();
      const retry = await complete(id, {
        ...OK,
        "PATCH /issues/PROJ-1": () => jsonResponse({ errors: [{ message: "bad", code: 7 }] }, 400),
      });
      expect(retry.isError).toBe(true);
      expect(retry.json.error.retryable).toBe(false);
      expect(retry.json.error.message).toContain("logbutler_issue_attachment_list");
      expect(retry.json.error.message).toMatch(/already/i);
      expect(retry.calls).toEqual(["PATCH /issues/PROJ-1"]);
    });
  });

  describe("lease(claimedAt から 2 分)", () => {
    it("lease 内の 2 人目は「処理中」の再試行できるエラー(Backlog を呼ばない)", async () => {
      const id = await readyId();
      await writeClaimed(id, T0);
      const run = await complete(id, OK, { now: new Date(T0.getTime() + CLAIM_LEASE_MS - 1) });
      expect(run.isError).toBe(true);
      expect(run.json.error.retryable).toBe(true);
      expect(run.json.error.message).toMatch(/in progress/i);
      expect(run.calls).toEqual([]);
    });

    it("lease が切れた claimed は引き継いで完了する(Worker が途中で終了した場合の回復)", async () => {
      const id = await readyId();
      await writeClaimed(id, T0);
      const run = await complete(id, OK, { now: new Date(T0.getTime() + CLAIM_LEASE_MS) });
      expect(run.isError, run.text).toBe(false);
      expect(run.calls).toEqual(["POST /space/attachment", "PATCH /issues/PROJ-1"]);
      expect((await readClaim(id))?.state).toBe("done");
    });
  });

  it("冪等キャッシュは upload_id ごと(同じ issue_key・file_name でも別の upload_id は別の呼び出し)", async () => {
    const store = new Map<string, string>();
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
    };
    const a = await readyId("aaa");
    const b = await readyId("bbb");
    for (const id of [a, b]) {
      const run = await callTool(
        UPLOAD,
        { issue_key: "PROJ-1", file_name: "hello.txt", upload_id: id },
        OK,
        { uploads: deps(), now: T0, idempotency: { kv, userId: UID } },
      );
      expect(run.calls, id).toEqual(["POST /space/attachment", "PATCH /issues/PROJ-1"]);
    }
    // KV のキーにも値にも upload_id(秘密の capability)を残さない
    for (const [k, v] of store) {
      expect(k).not.toContain(a);
      expect(v).not.toContain(a);
    }
  });
});

describe("R2 の想定外の失敗", () => {
  afterEach(() => vi.restoreAllMocks());

  it("再試行できる generic_error にし、upload_id をログにも応答にも出さない(prepare と完了)", async () => {
    const id = "E".repeat(43);
    const failing = new Proxy(
      {},
      {
        get() {
          return async () => {
            throw new Error(`R2 failure on claim/${id}`);
          };
        },
      },
    ) as R2Bucket;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const uploads = { bucket: failing, userId: UID, baseUrl: "https://logbutler.test" };
    const done = await callTool(
      UPLOAD,
      { issue_key: "PROJ-1", file_name: "a.txt", upload_id: id },
      OK,
      { uploads },
    );
    const prep = await callTool(PREPARE, {}, {}, { uploads });
    for (const run of [done, prep]) {
      expect(run.json.error.code).toBe("generic_error");
      expect(run.json.error.retryable).toBe(true);
      expect(run.text).not.toContain(id);
      expect(run.calls).toEqual([]);
    }
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("upload_storage_failed");
    expect(logged).not.toContain(id);
  });

  it("Backlog が attachment ID を返さなければ、再試行できるエラーにして released に戻す", async () => {
    const id = await readyId();
    const run = await complete(id, { ...OK, "POST /space/attachment": {} });
    expect(run.json.error.retryable).toBe(true);
    expect(run.calls).toEqual(["POST /space/attachment"]);
    expect((await readClaim(id))?.state).toBe("released");
  });
});
