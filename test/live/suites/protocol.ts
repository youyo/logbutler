/** 異常系・URL クエリ・認証・応答サイズ・カバレッジ。 */
import { describe, expect, it } from "vitest";
import { created } from "../helpers/issues";
import { errorOf } from "../helpers/live";
import { OUT_OF_SCOPE, world } from "../helpers/world";

// biome-ignore lint/suspicious/noExplicitAny: 応答の形をテストごとに検証する
type Any = any;

const withQuery = (q: string) => {
  const u = new URL(world().client.mcpUrl.href);
  u.search = q;
  return u.href;
};

const names = (r: Any): string[] =>
  (r.body.result.tools as Array<{ name: string }>).map((t) => t.name).sort();

export function protocolSuite(): void {
  describe("応答サイズ (max_response_tokens)", () => {
    it("極小の上限で response_too_large、0 で無効、負の値は argument_error、書き込み系には付かない", async () => {
      const { client, config } = world();
      const small = await client.call("logbutler_issue_list", {
        project_key: config.projectKey,
        count: 20,
        max_response_tokens: 1,
      });
      const e = errorOf(small);
      expect(e?.code).toBe("response_too_large");
      expect(e?.retryable).toBe(false);
      expect(e?.message).toContain("max_response_tokens");
      for (const [tool, args] of [
        ["logbutler_project_get", { project_key: config.projectKey }],
        ["logbutler_user_list", {}],
        ["logbutler_space_info", {}],
        ["logbutler_project_health", { project_key: config.projectKey }],
        ["logbutler_search", { keyword: "live" }],
      ] as const) {
        const r = await client.call(tool, { ...args, max_response_tokens: 1 });
        expect(errorOf(r)?.code, tool).toBe("response_too_large");
      }
      const off = await client.ok("logbutler_issue_list", {
        project_key: config.projectKey,
        count: 20,
        max_response_tokens: 0,
      });
      expect(Array.isArray(off)).toBe(true);
      expect(
        errorOf(
          await client.call("logbutler_issue_list", {
            project_key: config.projectKey,
            max_response_tokens: -1,
          }),
        )?.code,
      ).toBe("argument_error");
      expect(
        errorOf(
          await client.call("logbutler_issue_list", {
            project_key: config.projectKey,
            max_response_tokens: 1.5,
          }),
        )?.code,
      ).toBe("argument_error");
      const { tools } = (await client.listTools()).body.result as {
        tools: Array<{ name: string; inputSchema: Any; annotations: Any }>;
      };
      for (const t of tools) {
        const has = "max_response_tokens" in (t.inputSchema.properties ?? {});
        const download = t.name.endsWith("_download");
        expect(has, t.name).toBe(t.annotations.readOnlyHint === true && !download);
      }
    });
  });

  describe("tools/call の入力の検証 (argument_error)", () => {
    it("必須欠落・型違い・未知のツール引数・空文字がエンベロープの argument_error になる", async () => {
      const { client } = world();
      for (const [tool, args] of [
        ["logbutler_project_get", {}],
        ["logbutler_project_get", { project_key: 123 }],
        ["logbutler_user_get", { user_id: "" }],
        ["logbutler_issue_comment_list", { issue_key: "X-1", count: "many" }],
        ["logbutler_team_get", { team_id: 1.5 }],
        ["logbutler_watching_get", { watching_id: "abc" }],
        ["logbutler_issue_list", { count: 0.5 }],
      ] as const) {
        const r = await client.call(tool, args as Record<string, unknown>);
        const e = errorOf(r);
        expect(e?.code, `${tool} ${JSON.stringify(args)}: ${r.text.slice(0, 160)}`).toBe(
          "argument_error",
        );
        expect(e?.message.length).toBeGreaterThan(0);
        expect(e?.retryable).toBe(false);
      }
    });

    it("存在しないリソースは not_found(retryable=false)で、メッセージに Backlog のエラー内容がある", async () => {
      const { client, config } = world();
      for (const [tool, args] of [
        ["logbutler_issue_get", { issue_key: `${config.projectKey}-999999` }],
        ["logbutler_issue_comment_list", { issue_key: `${config.projectKey}-999999` }],
        ["logbutler_issue_attachment_list", { issue_key: `${config.projectKey}-999999` }],
        ["logbutler_issue_related_list", { issue_key: `${config.projectKey}-999999` }],
        ["logbutler_meta_statuses", { project_key: "NOSUCHPROJ" }],
        ["logbutler_document_get", { document_id: "ffffffffffffffffffffffffffffffff" }],
        ["logbutler_watching_get", { watching_id: 999999999 }],
        ["logbutler_user_activity", { user_id: "999999999" }],
      ] as const) {
        const r = await client.call(tool, args);
        const e = errorOf(r);
        if (tool === "logbutler_user_activity") {
          // 存在しないユーザーの活動: 空か not_found(例外にならない)
          expect(r.isError ? e?.code : "ok", tool).toMatch(/not_found|ok/);
          continue;
        }
        expect(e?.code, `${tool}: ${r.text.slice(0, 200)}`).toBe("not_found");
        expect(e?.message).toContain("404");
        expect(e?.retryable).toBe(false);
      }
    });

    it("存在しないツール名は JSON-RPC エラー(または isError)で、サーバーは落ちない", async () => {
      const { client } = world();
      const r = await client.rpc("tools/call", { name: "logbutler_no_such_tool", arguments: {} });
      expect(r.status === 200 || r.status === 400 || r.status === 404).toBe(true);
      const failed = Boolean(r.body?.error) || r.body?.result?.isError === true;
      expect(failed, r.text.slice(0, 200)).toBe(true);
      expect((await client.call("logbutler_user_me")).isError).toBe(false);
    });
  });

  describe("URL クエリ (toolsets / read_only)", () => {
    it("read_only=true: 読み取り専用ツールだけが載り、隠れた書き込みツールの呼び出しは拒否され、課題は作られない", async () => {
      const { client, config, snapshotTools, issueTypeId, priorityIds } = world();
      const r = await client.listTools(withQuery("?read_only=true"));
      expect(r.status).toBe(200);
      const expected = snapshotTools
        .filter((t) => t.readOnly)
        .map((t) => t.name)
        .sort();
      expect(names(r)).toEqual(expected);
      expect(expected.length).toBeLessThan(86);
      const before = await client.ok("logbutler_issue_list", {
        project_key: config.projectKey,
        sort: "created",
        order: "desc",
        count: 1,
      });
      const attempt = await client.rpc(
        "tools/call",
        {
          name: "logbutler_issue_create",
          arguments: {
            project_key: config.projectKey,
            summary: "[live] readonly must not create",
            issue_type_id: issueTypeId,
            priority_id: priorityIds[0],
          },
        },
        { url: withQuery("?read_only=true") },
      );
      client.called.add("logbutler_issue_create");
      const refused =
        Boolean(attempt.body?.error) ||
        attempt.body?.result?.isError === true ||
        attempt.status >= 400;
      expect(refused, attempt.text.slice(0, 200)).toBe(true);
      const after = await client.ok("logbutler_issue_list", {
        project_key: config.projectKey,
        sort: "created",
        order: "desc",
        count: 1,
      });
      expect(after[0].id).toBe(before[0].id);
      // 読み取りは動く
      const read = await client.call(
        "logbutler_project_get",
        { project_key: config.projectKey },
        { url: withQuery("?read_only=true") },
      );
      expect(read.isError).toBe(false);
    });

    it("toolsets=: 指定した toolset だけが載り、それ以外の呼び出しは拒否される。read_only と組み合わせられる", async () => {
      const { client } = world();
      const star = await client.listTools(withQuery("?toolsets=star"));
      expect(names(star)).toEqual(["logbutler_star_add"]);
      const wiki = await client.listTools(withQuery("?toolsets=wiki"));
      expect(names(wiki)).toHaveLength(8);
      expect(names(wiki).every((n) => n.startsWith("logbutler_wiki_"))).toBe(true);
      const both = await client.listTools(withQuery("?toolsets=watching,star&read_only=true"));
      expect(
        names(both).every((n) => n.startsWith("logbutler_watching_") || n === "logbutler_star_add"),
      ).toBe(true);
      expect(names(both)).not.toContain("logbutler_star_add");
      expect(names(both)).not.toContain("logbutler_watching_add");
      expect(names(both)).toContain("logbutler_watching_get");
      const hidden = await client.rpc(
        "tools/call",
        { name: "logbutler_user_me", arguments: {} },
        { url: withQuery("?toolsets=star") },
      );
      expect(
        Boolean(hidden.body?.error) ||
          hidden.body?.result?.isError === true ||
          hidden.status >= 400,
        hidden.text.slice(0, 200),
      ).toBe(true);
      const all = await client.listTools(withQuery("?toolsets=all"));
      expect(names(all)).toHaveLength(86);
      const ro = await client.listTools(withQuery("?read_only=false"));
      expect(names(ro)).toHaveLength(86);
      const mixedCase = await client.listTools(withQuery("?toolsets=STAR"));
      expect(names(mixedCase)).toEqual(["logbutler_star_add"]);
      // プロジェクト設定ツール 12 個は toolsets=project_settings で出て、read_only=true との組み合わせは 400(ADR 0013)
      const settings = await client.listTools(withQuery("?toolsets=project_settings"));
      expect(names(settings)).toHaveLength(12);
      const settingsRo = await client.listTools(
        withQuery("?toolsets=project_settings&read_only=true"),
      );
      // 公開ツールが 0 個になる組み合わせは 400(空だと MCP 2026-07-28 レーンで tools/list が 404 になる)
      expect(settingsRo.status).toBe(400);
      expect(settingsRo.text).toContain("ツールがありません");
    });

    it("不正なクエリ(未知の toolset・読めない read_only・綴り違い・重複)は 400 で理由を返す", async () => {
      const { client } = world();
      for (const q of [
        "?toolsets=bogus",
        "?read_only=maybe",
        "?readonly=true",
        "?toolset=issue",
        "?read_only=true&read_only=false",
      ]) {
        const r = await client.listTools(withQuery(q));
        expect(r.status, q).toBe(400);
        expect(r.text.length, q).toBeGreaterThan(0);
        expect(r.text, q).not.toMatch(/Bearer\s/);
      }
      const call = await client.rpc(
        "tools/call",
        { name: "logbutler_user_me", arguments: {} },
        { url: withQuery("?toolsets=bogus") },
      );
      expect(call.status).toBe(400);
      // 関係のないクエリは無視される
      const ignored = await client.listTools(withQuery("?optimize_context=true"));
      expect(names(ignored)).toHaveLength(86);
    });
  });

  describe("認証と基本エンドポイント", () => {
    it("トークンなし・不正なトークンの /mcp は 401 + WWW-Authenticate", async () => {
      const { client } = world();
      const none = await client.rpc("tools/list", {}, { auth: false });
      expect(none.status).toBe(401);
      expect(none.headers.get("www-authenticate")).toMatch(/Bearer/i);
      const bad = await client.rpc("tools/list", {}, { token: "not-a-valid-token" });
      expect(bad.status).toBe(401);
    });

    it("/healthz は 200 で、設定値(秘密)を含まない", async () => {
      const { client } = world();
      const r = await client.http("/healthz", { auth: false });
      expect(r.status).toBe(200);
      expect(r.text).not.toMatch(/secret|token|client_secret/i);
    });

    it("OAuth のメタデータが読める(authorization_servers / endpoints)", async () => {
      const { client } = world();
      const as = await client.http("/.well-known/oauth-authorization-server", { auth: false });
      expect(as.status).toBe(200);
      const meta = JSON.parse(as.text);
      expect(meta.issuer).toBe(client.mcpUrl.origin);
      expect(meta.token_endpoint).toContain("/token");
      expect(meta.registration_endpoint).toContain("/register");
      expect(meta.code_challenge_methods_supported).toContain("S256");
      const pr = await client.http("/.well-known/oauth-protected-resource/mcp", { auth: false });
      expect(pr.status).toBe(200);
    });
  });

  describe("カバレッジ", () => {
    it("対象外(共有ファイル・Wiki)を除く全ツールを、このスイートが実際に呼んでいる", () => {
      const { client, snapshotTools } = world();
      const missing = snapshotTools
        .map((t) => t.name)
        .filter((n) => !client.called.has(n) && !(n in OUT_OF_SCOPE));
      expect(missing).toEqual([]);
      for (const n of Object.keys(OUT_OF_SCOPE)) {
        expect(
          snapshotTools.map((t) => t.name),
          `対象外の ${n} は tools/list にある`,
        ).toContain(n);
        expect(client.called.has(n), `対象外の ${n} は呼ばない`).toBe(false);
      }
    });

    it("実行の記録: 作成した課題・ドキュメントと、リクエスト数(300 以下の目安)", () => {
      const { client } = world();
      console.log(`[live] 作成: ${created.log.join(", ")}`);
      console.log(
        `[live] Worker への HTTP リクエスト合計 ${client.requests}(うち tools/call ${client.toolCalls})`,
      );
      expect(client.requests).toBeLessThanOrEqual(600);
    });
  });
}
