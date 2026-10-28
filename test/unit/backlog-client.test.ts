import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BacklogApiError,
  BacklogCallLimitError,
  BacklogUnauthorizedError,
  createBacklogClient,
  DEFAULT_MAX_API_CALLS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_RETRY_WAIT_SECONDS,
  DEFAULT_TIMEOUT_MS,
} from "../../src/backlog/client";
import { jsonResponse, mockOutboundFetch } from "../helpers/mock-fetch";

const MYSELF = "GET https://example.backlog.com/api/v2/users/myself";
const ISSUES = "GET https://example.backlog.com/api/v2/issues";
const POST_ISSUE = "POST https://example.backlog.com/api/v2/issues";
const PATCH_ISSUE = "PATCH https://example.backlog.com/api/v2/issues/PROJ-1";

type ClientOptions = Partial<Parameters<typeof createBacklogClient>[0]>;
const make = (opts: ClientOptions = {}) =>
  createBacklogClient({ spaceHost: "example.backlog.com", accessToken: "at-1", ...opts });

afterEach(() => vi.restoreAllMocks());

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("拒否されるはずだった");
    },
    (e: unknown) => e,
  );
}

describe("既定値", () => {
  it("タイムアウト 30 秒・リトライ 2 回・Retry-After 上限 10 秒・呼び出し上限 50 回", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_MAX_RETRIES).toBe(2);
    expect(DEFAULT_MAX_RETRY_WAIT_SECONDS).toBe(10);
    expect(DEFAULT_MAX_API_CALLS).toBe(50);
  });
});

describe("BacklogClient.getMyself", () => {
  it("Bearer 付きで /api/v2/users/myself を呼び、ユーザーを返す(camelCase のまま)", async () => {
    const m = mockOutboundFetch({
      [MYSELF]: () =>
        jsonResponse({
          id: 42,
          userId: "alice",
          name: "Alice",
          mailAddress: "a@example.com",
          roleType: 2,
        }),
    });
    const user = await make().getMyself();
    expect(user).toEqual({
      id: 42,
      userId: "alice",
      name: "Alice",
      mailAddress: "a@example.com",
      roleType: 2,
    });
    expect(m.calls[0]?.headers.get("authorization")).toBe("Bearer at-1");
  });
});

describe("request: 認証・クエリ・フォーム", () => {
  it("GET は Authorization: Bearer を付け、クエリを URL に載せる(配列は key[]=v)", async () => {
    const m = mockOutboundFetch({ [ISSUES]: () => jsonResponse([]) });
    await make().request("GET", "/issues", {
      query: {
        projectId: [1, 2],
        keyword: "検索 語",
        count: 20,
        parentChild: 0,
        skipped: undefined,
        nothing: null,
        flag: true,
      },
    });
    const call = m.calls[0];
    expect(call?.method).toBe("GET");
    expect(call?.headers.get("authorization")).toBe("Bearer at-1");
    expect(call?.headers.get("content-type")).toBeNull();
    expect(call?.body).toBe("");
    const url = new URL(call?.url ?? "");
    expect(url.searchParams.getAll("projectId[]")).toEqual(["1", "2"]);
    expect(url.searchParams.get("keyword")).toBe("検索 語");
    expect(url.searchParams.get("count")).toBe("20");
    expect(url.searchParams.get("parentChild")).toBe("0");
    expect(url.searchParams.get("flag")).toBe("true");
    expect(url.searchParams.has("skipped")).toBe(false);
    expect(url.searchParams.has("nothing")).toBe(false);
    expect(url.search).not.toContain("at-1");
  });

  it("POST は application/x-www-form-urlencoded の本文で送る(配列は key[]=v)", async () => {
    const m = mockOutboundFetch({ [POST_ISSUE]: () => jsonResponse({ id: 1 }) });
    await make().request("POST", "/issues", {
      form: { summary: "件名 & 本文", assigneeId: 7, categoryId: [3, 4], skipped: undefined },
    });
    const call = m.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("authorization")).toBe("Bearer at-1");
    expect(call?.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call?.body);
    expect(form.get("summary")).toBe("件名 & 本文");
    expect(form.get("assigneeId")).toBe("7");
    expect(form.getAll("categoryId[]")).toEqual(["3", "4"]);
    expect(form.has("skipped")).toBe(false);
    expect(new URL(call?.url ?? "").search).toBe("");
  });

  it("PATCH も form 本文で送る", async () => {
    const m = mockOutboundFetch({ [PATCH_ISSUE]: () => jsonResponse({ id: 1 }) });
    await make().request("PATCH", "/issues/PROJ-1", { form: { statusId: 3 } });
    expect(m.calls[0]?.method).toBe("PATCH");
    expect(new URLSearchParams(m.calls[0]?.body).get("statusId")).toBe("3");
  });

  it("応答本文が空(204)なら undefined を返す", async () => {
    mockOutboundFetch({ [PATCH_ISSUE]: () => new Response(null, { status: 204 }) });
    await expect(make().request("PATCH", "/issues/PROJ-1")).resolves.toBeUndefined();
  });
});

describe("request: HTTP ステータスからエラーへの変換", () => {
  const body = { errors: [{ message: "No such issue.", code: 6, moreInfo: "" }] };
  const cases: [number, string, boolean][] = [
    [401, "authentication_error", false],
    [403, "permission_error", false],
    [404, "not_found", false],
    [422, "argument_error", false],
    [400, "api_error", false],
    [409, "api_error", false],
    [500, "api_error", true],
    [503, "api_error", true],
  ];
  for (const [status, code, retryable] of cases) {
    it(`${status} は ${code}(retryable=${retryable})。Backlog の code と message を保持する`, async () => {
      mockOutboundFetch({ [MYSELF]: () => jsonResponse(body, status) });
      const err = await caught(make().request("GET", "/users/myself"));
      expect(err).toBeInstanceOf(BacklogApiError);
      const e = err as BacklogApiError;
      expect(e.status).toBe(status);
      expect(e.code).toBe(code);
      expect(e.retryable).toBe(retryable);
      expect(e.backlogCode).toBe(6);
      expect(e.backlogMessage).toBe("No such issue.");
      expect(e.message).toContain("No such issue.");
      expect(e.message).toContain(String(status));
    });
  }

  it("401 は BacklogUnauthorizedError(MCP の HTTP 401 に変換する合図)", async () => {
    mockOutboundFetch({ [MYSELF]: () => jsonResponse(body, 401) });
    const err = await caught(make().getMyself());
    expect(err).toBeInstanceOf(BacklogUnauthorizedError);
    expect((err as BacklogApiError).status).toBe(401);
  });

  it("JSON でない・errors のない本文でも壊れず、status だけで変換する", async () => {
    mockOutboundFetch({
      [MYSELF]: () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    const e = (await caught(make().getMyself())) as BacklogApiError;
    expect(e.code).toBe("api_error");
    expect(e.retryable).toBe(true);
    expect(e.backlogCode).toBeUndefined();
    expect(e.message).not.toContain("<html>");
  });

  it("通信失敗は status 0 の api_error(retryable)。トークンを含めない", async () => {
    mockOutboundFetch({
      [MYSELF]: () => {
        throw new TypeError("network down at-1");
      },
    });
    const e = (await caught(make().getMyself())) as BacklogApiError;
    expect(e.status).toBe(0);
    expect(e.code).toBe("api_error");
    expect(e.retryable).toBe(true);
    expect(e.message).not.toContain("at-1");
  });

  it("エラーメッセージにも例外にもアクセストークンを含めない(Backlog の本文に混入していても伏せる)", async () => {
    mockOutboundFetch({
      [MYSELF]: () =>
        jsonResponse({ errors: [{ message: "bad token at-1 rejected", code: 11 }] }, 403),
    });
    const e = (await caught(make().getMyself())) as BacklogApiError;
    expect(e.message).not.toContain("at-1");
    expect(e.backlogMessage).not.toContain("at-1");
    expect(JSON.stringify(e)).not.toContain("at-1");
  });
});

describe("request: 429 のリトライ", () => {
  function rateLimited(retryAfter?: string) {
    return new Response(JSON.stringify({ errors: [{ message: "Too many requests", code: 14 }] }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        ...(retryAfter ? { "Retry-After": retryAfter } : {}),
      },
    });
  }

  it("Retry-After(秒)だけ待って再試行し、成功すれば結果を返す", async () => {
    const waits: number[] = [];
    let n = 0;
    const m = mockOutboundFetch({
      [MYSELF]: () =>
        ++n === 1 ? rateLimited("3") : jsonResponse({ id: 1, userId: "a", name: "A" }),
    });
    const user = await make({ sleep: async (ms) => void waits.push(ms) }).getMyself();
    expect(user.id).toBe(1);
    expect(waits).toEqual([3000]);
    expect(m.calls).toHaveLength(2);
  });

  it("最大 2 回までリトライし、それでも 429 なら rate_limited(retryable)で終わる(計 3 回)", async () => {
    const waits: number[] = [];
    const m = mockOutboundFetch({ [MYSELF]: () => rateLimited("1") });
    const e = (await caught(
      make({ sleep: async (ms) => void waits.push(ms) }).getMyself(),
    )) as BacklogApiError;
    expect(m.calls).toHaveLength(3);
    expect(waits).toEqual([1000, 1000]);
    expect(e.code).toBe("rate_limited");
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);
  });

  it("上限(10 秒)を超える Retry-After はリトライせずに rate_limited で終わる", async () => {
    const waits: number[] = [];
    const m = mockOutboundFetch({ [MYSELF]: () => rateLimited("11") });
    const e = (await caught(
      make({ sleep: async (ms) => void waits.push(ms) }).getMyself(),
    )) as BacklogApiError;
    expect(m.calls).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(e.code).toBe("rate_limited");
    expect(e.retryable).toBe(true);
  });

  it("上限ちょうど(10 秒)は待つ", async () => {
    const waits: number[] = [];
    let n = 0;
    mockOutboundFetch({
      [MYSELF]: () =>
        ++n === 1 ? rateLimited("10") : jsonResponse({ id: 1, userId: "a", name: "A" }),
    });
    await make({ sleep: async (ms) => void waits.push(ms) }).getMyself();
    expect(waits).toEqual([10_000]);
  });

  it("Retry-After がない・不正なときは 1 秒待つ", async () => {
    const waits: number[] = [];
    let n = 0;
    mockOutboundFetch({
      [MYSELF]: () =>
        ++n === 1
          ? rateLimited()
          : n === 2
            ? rateLimited("abc")
            : jsonResponse({ id: 1, userId: "a", name: "A" }),
    });
    await make({ sleep: async (ms) => void waits.push(ms) }).getMyself();
    expect(waits).toEqual([1000, 1000]);
  });

  it("429 以外(500 など)はリトライしない", async () => {
    const m = mockOutboundFetch({ [MYSELF]: () => jsonResponse({}, 500) });
    await caught(make({ sleep: async () => {} }).getMyself());
    expect(m.calls).toHaveLength(1);
  });

  it("既定の sleep は実時間で待つ(時計を進めると再試行が走る)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let n = 0;
      const m = mockOutboundFetch({
        [MYSELF]: () =>
          ++n === 1 ? rateLimited("2") : jsonResponse({ id: 1, userId: "a", name: "A" }),
      });
      const p = make().getMyself();
      await vi.advanceTimersByTimeAsync(1999);
      expect(m.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(p).resolves.toMatchObject({ id: 1 });
      expect(m.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("request: 直列化(同時に飛ばす HTTP リクエストは 1 本)", () => {
  it("Promise.all で並列に呼んでも、Backlog への fetch は同時に 1 本だけで、呼んだ順に実行される", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    mockOutboundFetch({
      [ISSUES]: async (call) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(new URL(call.url).searchParams.get("n") ?? "");
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return jsonResponse([]);
      },
    });
    const client = make();
    await Promise.all([1, 2, 3, 4].map((n) => client.request("GET", "/issues", { query: { n } })));
    expect(maxInFlight).toBe(1);
    expect(order).toEqual(["1", "2", "3", "4"]);
  });

  it("先行のリクエストが失敗しても、後続は実行される", async () => {
    let n = 0;
    mockOutboundFetch({
      [ISSUES]: () => (++n === 1 ? jsonResponse({}, 500) : jsonResponse([])),
    });
    const client = make();
    const [a, b] = await Promise.allSettled([
      client.request("GET", "/issues"),
      client.request("GET", "/issues"),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");
  });

  it("429 の待機中も次のリクエストは割り込まない", async () => {
    const events: string[] = [];
    let n = 0;
    mockOutboundFetch({
      [ISSUES]: (call) => {
        const tag = new URL(call.url).searchParams.get("n");
        events.push(`fetch${tag}`);
        return ++n === 1
          ? new Response("{}", { status: 429, headers: { "Retry-After": "1" } })
          : jsonResponse([]);
      },
    });
    const client = make({
      sleep: async () => {
        events.push("sleep");
      },
    });
    await Promise.all([
      client.request("GET", "/issues", { query: { n: "A" } }),
      client.request("GET", "/issues", { query: { n: "B" } }),
    ]);
    expect(events).toEqual(["fetchA", "sleep", "fetchA", "fetchB"]);
  });
});

describe("request: 呼び出し回数の上限", () => {
  it("上限を超えると BacklogCallLimitError(api_error・retryable=false)で止まり、fetch しない", async () => {
    const m = mockOutboundFetch({ [ISSUES]: () => jsonResponse([]) });
    const client = make({ maxApiCalls: 3 });
    for (let i = 0; i < 3; i++) await client.request("GET", "/issues");
    const e = await caught(client.request("GET", "/issues"));
    expect(e).toBeInstanceOf(BacklogCallLimitError);
    expect((e as BacklogCallLimitError).code).toBe("api_error");
    expect((e as BacklogCallLimitError).retryable).toBe(false);
    expect((e as Error).message).toContain("3");
    expect(m.calls).toHaveLength(3);
  });

  it("429 のリトライも 1 回として数える", async () => {
    const m = mockOutboundFetch({
      [ISSUES]: () => new Response("{}", { status: 429, headers: { "Retry-After": "0" } }),
    });
    const client = make({ maxApiCalls: 2, sleep: async () => {} });
    const e = await caught(client.request("GET", "/issues"));
    expect(e).toBeInstanceOf(BacklogCallLimitError);
    expect(m.calls).toHaveLength(2);
  });

  it("既定は 50 回", async () => {
    const m = mockOutboundFetch({ [ISSUES]: () => jsonResponse([]) });
    const client = make();
    for (let i = 0; i < DEFAULT_MAX_API_CALLS; i++) await client.request("GET", "/issues");
    await expect(client.request("GET", "/issues")).rejects.toBeInstanceOf(BacklogCallLimitError);
    expect(m.calls).toHaveLength(DEFAULT_MAX_API_CALLS);
  });
});

describe("request: タイムアウト", () => {
  it("応答がなければ AbortSignal で打ち切り、status 0 の api_error(retryable)にする", async () => {
    let aborted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const e = (await caught(make({ timeoutMs: 20 }).getMyself())) as BacklogApiError;
    expect(aborted).toBe(true);
    expect(e).toBeInstanceOf(BacklogApiError);
    expect(e.status).toBe(0);
    expect(e.code).toBe("api_error");
    expect(e.retryable).toBe(true);
    expect(e.message).toContain("timed out");
  });

  it("既定のタイムアウトは 30 秒(時計を進めて確認)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let aborted = false;
      vi.spyOn(globalThis, "fetch").mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      );
      const p = caught(make().getMyself());
      await vi.advanceTimersByTimeAsync(29_999);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborted).toBe(true);
      expect(await p).toBeInstanceOf(BacklogApiError);
    } finally {
      vi.useRealTimers();
    }
  });
});
