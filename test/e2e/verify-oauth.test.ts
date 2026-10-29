/**
 * `mise run verify:oauth` の CLI(scripts/verify-oauth)を、テスト内の Worker 全体と Backlog のモックに対して動かす。
 * ブラウザの段(Backlog のログイン・同意)は、io.openBrowser が /authorize → /callback を直接たどる差し込み口で代える。
 * ループバックの受信は FakeReceiver(実物の node:http 版は test/node/loopback.test.ts)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CallbackReceiver,
  formatReport,
  runVerification,
  type SavedState,
  type VerifyIo,
  type VerifyReport,
} from "../../scripts/verify-oauth/core";
import { jsonResponse } from "../helpers/mock-fetch";
import { CookieJar, MCP_URL, ORIGIN, setupMocks, worker } from "../helpers/oauth-flow";

afterEach(() => vi.restoreAllMocks());

const REDIRECT_URI = "http://127.0.0.1:49152/callback";

/** ブラウザでの Backlog ログイン・同意の代わり。認可 URL から、クライアントへ戻るリダイレクト先(code/state/iss つき)までたどる。 */
async function browserLogin(authUrl: string, tamper: (cb: URL) => void = () => {}) {
  const jar = new CookieJar();
  const consent = await worker.fetch(authUrl);
  jar.update(consent);
  const html = await consent.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const approve = await worker.fetch(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: { Cookie: jar.header(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle, decision: "approve" }),
  });
  jar.update(approve);
  const state = new URL(approve.headers.get("Location") ?? "", ORIGIN).searchParams.get("state");
  const back = await worker.fetch(
    `${ORIGIN}/callback?code=backlog-code&state=${encodeURIComponent(state ?? "")}`,
    { headers: { Cookie: jar.header() } },
  );
  const location = new URL(back.headers.get("Location") ?? "");
  tamper(location);
  return location.toString();
}

interface Harness {
  io: VerifyIo;
  logs: string[];
  requests: { method: string; url: string; headers: Headers; body: string }[];
  /** /token が返したトークン(マスクされているかの確認用)。 */
  secrets: string[];
  saved: SavedState | undefined;
  openedUrls: string[];
}

function harness(
  opts: { tamper?: (cb: URL) => void; state?: SavedState; browserFails?: boolean } = {},
): Harness {
  const h: Harness = {
    logs: [],
    requests: [],
    secrets: [],
    saved: opts.state,
    openedUrls: [],
    io: undefined as never,
  };
  h.io = {
    fetch: async (input, init) => {
      const req = new Request(input, init);
      h.requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: await req.clone().text(),
      });
      const res = await worker.fetch(input, init);
      if (new URL(input).pathname === "/token") {
        const body = (await res.clone().json()) as Record<string, unknown>;
        for (const k of ["access_token", "refresh_token"]) {
          if (typeof body[k] === "string") h.secrets.push(body[k] as string);
        }
      }
      return res;
    },
    log: (line) => h.logs.push(line),
    startReceiver: async (): Promise<CallbackReceiver> => {
      let resolve!: (url: string) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      promise.catch(() => {});
      h.io.openBrowser = async (url) => {
        h.openedUrls.push(url);
        browserLogin(url, opts.tamper).then(resolve, reject);
      };
      return { redirectUri: REDIRECT_URI, wait: () => promise, close() {} };
    },
    openBrowser: () => {},
    loadState: async () => h.saved,
    saveState: async (s) => {
      h.saved = s;
    },
  };
  return h;
}

function step(report: VerifyReport, name: string) {
  return report.steps.find((s) => s.name === name);
}

describe("E2E: verify:oauth(実環境確認用 CLI)を Worker とモック Backlog に対して動かす", () => {
  it("DCR → PKCE → 認可 → /token → tools/list・user_me → refresh → user_me を通しで成功させ、結果を要約する", async () => {
    await setupMocks();
    const h = harness();
    const report = await runVerification({ mcpUrl: MCP_URL, refreshOnly: false }, h.io);

    expect(report.steps.map((s) => [s.name, s.ok])).toEqual([
      ["metadata", true],
      ["register", true],
      ["authorize", true],
      ["token", true],
      ["tools_list", true],
      ["user_me", true],
      ["refresh", true],
      ["user_me_after_refresh", true],
    ]);
    expect(report.ok).toBe(true);
    expect(report.facts.issuer).toBe(ORIGIN);
    expect(report.facts.toolCount).toBeGreaterThanOrEqual(86);
    expect(report.facts.userId).toBe(42);
    expect(report.facts.tokenExpiresInSeconds).toBeGreaterThan(0);
    expect(report.facts.refreshedExpiresInSeconds).toBeGreaterThan(0);
    expect(report.facts.accessTokenChangedOnRefresh).toBe(true);
    expect(typeof report.facts.refreshTokenRotated).toBe("boolean");
    // 要約に、各段階の成否・有効期限・リフレッシュで変わったかが出る。
    const summary = formatReport(report).join("\n");
    expect(summary).toMatch(/metadata.*OK/i);
    expect(summary).toMatch(/user_me_after_refresh.*OK/i);
    expect(summary).toContain(String(report.facts.tokenExpiresInSeconds));
    expect(summary).toMatch(/アクセストークン.*変わっ/);
    expect(summary).toMatch(/リフレッシュトークン/);
  });

  it("DCR は application_type=native・token_endpoint_auth_method=none・127.0.0.1 の redirect_uri で、認可は PKCE(S256)と state と resource つき", async () => {
    await setupMocks();
    const h = harness();
    await runVerification({ mcpUrl: MCP_URL, refreshOnly: false }, h.io);

    const dcr = h.requests.find(
      (r) => r.method === "POST" && new URL(r.url).pathname === "/register",
    );
    const dcrBody = JSON.parse(dcr?.body ?? "{}");
    expect(dcrBody.application_type).toBe("native");
    expect(dcrBody.token_endpoint_auth_method).toBe("none");
    expect(dcrBody.redirect_uris).toEqual([REDIRECT_URI]);

    const auth = new URL(h.openedUrls[0] ?? "");
    expect(auth.origin + auth.pathname).toBe(`${ORIGIN}/authorize`);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auth.searchParams.get("state")?.length).toBeGreaterThanOrEqual(16);
    expect(auth.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(auth.searchParams.get("resource")).toBe(MCP_URL);

    const tokenReq = h.requests.find((r) => new URL(r.url).pathname === "/token");
    const form = new URLSearchParams(tokenReq?.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);
    expect(form.get("resource")).toBe(MCP_URL);
  });

  it("MCP は 2026-07-28 レーン(initialize なし。Mcp-Method / MCP-Protocol-Version ヘッダーと _meta)で呼ぶ", async () => {
    await setupMocks();
    const h = harness();
    await runVerification({ mcpUrl: MCP_URL, refreshOnly: false }, h.io);

    const mcpCalls = h.requests.filter((r) => new URL(r.url).pathname === "/mcp");
    expect(mcpCalls.length).toBeGreaterThanOrEqual(3);
    expect(mcpCalls.some((c) => JSON.parse(c.body).method === "initialize")).toBe(false);
    for (const c of mcpCalls) {
      const body = JSON.parse(c.body);
      expect(c.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
      expect(c.headers.get("Mcp-Method")).toBe(body.method);
      expect(body.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
      expect(c.headers.get("Authorization")).toMatch(/^Bearer .+/);
    }
    const call = mcpCalls.find((c) => JSON.parse(c.body).method === "tools/call");
    expect(call?.headers.get("Mcp-Name")).toBe("logbutler_user_me");
  });

  it("URL にクエリが付いていても(toolsets / read_only)そのまま /mcp に送り、resource は正規 URL(クエリなし)を使う", async () => {
    await setupMocks();
    const h = harness();
    const report = await runVerification(
      { mcpUrl: `${MCP_URL}?toolsets=user&read_only=true`, refreshOnly: false },
      h.io,
    );
    expect(report.ok).toBe(true);
    // toolsets=user なので user_me を含む 3 個。クエリが /mcp まで届いた証拠になる。
    expect(report.facts.toolCount).toBe(3);
    expect(new URL(h.openedUrls[0] ?? "").searchParams.get("resource")).toBe(MCP_URL);
    const mcpCall = h.requests.find((r) => new URL(r.url).pathname === "/mcp");
    expect(new URL(mcpCall?.url ?? "").search).toBe("?toolsets=user&read_only=true");
  });

  it("トークンは出力にも要約にも全文を出さない(先頭数文字だけ)", async () => {
    await setupMocks();
    const h = harness();
    const report = await runVerification({ mcpUrl: MCP_URL, refreshOnly: false }, h.io);
    const output = [...h.logs, ...formatReport(report), JSON.stringify(report)].join("\n");
    expect(h.secrets.length).toBeGreaterThanOrEqual(4);
    for (const secret of h.secrets) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain(secret.slice(0, 12));
    }
  });

  it("保存した状態(クライアント ID とリフレッシュトークン)から --refresh-only で更新だけを試す", async () => {
    await setupMocks();
    const first = harness();
    await runVerification({ mcpUrl: MCP_URL, refreshOnly: false }, first.io);
    expect(first.saved?.clientId).toBeTruthy();
    expect(first.saved?.refreshToken).toBeTruthy();

    const second = harness({ state: first.saved });
    const report = await runVerification({ mcpUrl: MCP_URL, refreshOnly: true }, second.io);
    expect(report.steps.map((s) => [s.name, s.ok])).toEqual([
      ["metadata", true],
      ["refresh", true],
      ["user_me_after_refresh", true],
    ]);
    expect(report.ok).toBe(true);
    // ブラウザも DCR も使わない。
    expect(second.openedUrls).toEqual([]);
    expect(second.requests.some((r) => new URL(r.url).pathname === "/register")).toBe(false);
    // 更新後のリフレッシュトークンを保存し直す(ローテーションに追従する)。
    expect(second.saved?.refreshToken).toBeTruthy();
  });

  it("--refresh-only で保存済みの状態が無ければ、手順を案内して失敗する", async () => {
    await setupMocks();
    const h = harness();
    const report = await runVerification({ mcpUrl: MCP_URL, refreshOnly: true }, h.io);
    expect(report.ok).toBe(false);
    expect(step(report, "refresh")?.ok).toBe(false);
    expect(step(report, "refresh")?.detail).toMatch(/保存|--refresh-only|先に/);
  });

  it("保存した状態の MCP URL が対象と違えば、別環境の状態として拒否する", async () => {
    await setupMocks();
    const state: SavedState = {
      mcpUrl: "https://other.example.com/mcp",
      clientId: "x",
      refreshToken: "y",
      savedAt: "2026-10-28T00:00:00Z",
    };
    const h = harness({ state });
    const report = await runVerification({ mcpUrl: MCP_URL, refreshOnly: true }, h.io);
    expect(report.ok).toBe(false);
    expect(h.requests.some((r) => new URL(r.url).pathname === "/token")).toBe(false);
  });

  it.each([
    ["別 origin", "https://evil.example/authorize&calc"],
    ["http(非ループバック)", `${ORIGIN.replace(/^https:/, "http:")}/authorize`],
    ["非 http(s) スキーム", "file:///etc/passwd"],
  ])(
    "AS メタデータの authorization_endpoint が%sなら、metadata で失敗しブラウザを開かない",
    async (_label, endpoint) => {
      await setupMocks();
      const h = harness();
      const inner = h.io.fetch;
      h.io.fetch = async (input, init) => {
        const res = await inner(input, init);
        if (new URL(input).pathname.startsWith("/.well-known/oauth-authorization-server")) {
          const body = (await res.json()) as Record<string, unknown>;
          return jsonResponse({ ...body, authorization_endpoint: endpoint });
        }
        return res;
      };
      const report = await runVerification({ mcpUrl: MCP_URL, refreshOnly: false }, h.io);
      expect(report.ok).toBe(false);
      expect(step(report, "metadata")?.ok).toBe(false);
      expect(h.openedUrls).toEqual([]);
    },
  );

  it("コールバックの state が違えば authorize で失敗し、/token へ進まない", async () => {
    await setupMocks();
    const h = harness({ tamper: (cb) => cb.searchParams.set("state", "forged-state") });
    const report = await runVerification({ mcpUrl: MCP_URL, refreshOnly: false }, h.io);
    expect(report.ok).toBe(false);
    expect(step(report, "authorize")?.ok).toBe(false);
    expect(step(report, "authorize")?.detail).toMatch(/state/);
    expect(step(report, "token")).toBeUndefined();
    expect(h.requests.some((r) => new URL(r.url).pathname === "/token")).toBe(false);
  });

  it("コールバックの iss が違えば authorize で失敗する(RFC 9207)", async () => {
    await setupMocks();
    const h = harness({ tamper: (cb) => cb.searchParams.set("iss", "https://evil.example.com") });
    const report = await runVerification({ mcpUrl: MCP_URL, refreshOnly: false }, h.io);
    expect(report.ok).toBe(false);
    expect(step(report, "authorize")?.detail).toMatch(/iss/);
    expect(step(report, "token")).toBeUndefined();
  });

  it("コールバックに iss が無ければ(メタデータが iss の返却を宣言しているので)失敗する", async () => {
    await setupMocks();
    const h = harness({ tamper: (cb) => cb.searchParams.delete("iss") });
    const report = await runVerification({ mcpUrl: MCP_URL, refreshOnly: false }, h.io);
    expect(report.ok).toBe(false);
    expect(step(report, "authorize")?.detail).toMatch(/iss/);
  });

  it("認可サーバーがエラーで戻した場合(error=access_denied)は、その旨を authorize の失敗として示す", async () => {
    await setupMocks();
    const h = harness({
      tamper: (cb) => {
        cb.searchParams.delete("code");
        cb.searchParams.set("error", "access_denied");
      },
    });
    const report = await runVerification({ mcpUrl: MCP_URL, refreshOnly: false }, h.io);
    expect(report.ok).toBe(false);
    expect(step(report, "authorize")?.detail).toContain("access_denied");
  });

  it("途中で失敗したら、以降の段階は実行せず、失敗した段階までの結果を返す(例: Backlog のコード交換が失敗)", async () => {
    await setupMocks({
      backlogToken: () => jsonResponse({ error: "invalid_grant" }, 400),
    });
    const h = harness();
    // Backlog の失敗は /callback が error リダイレクトで返す。
    const report = await runVerification({ mcpUrl: MCP_URL, refreshOnly: false }, h.io);
    expect(report.ok).toBe(false);
    expect(step(report, "authorize")?.ok).toBe(false);
    expect(step(report, "tools_list")).toBeUndefined();
  });
});
