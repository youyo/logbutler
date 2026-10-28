import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// テスト専用の束縛。実在しないダミー値のみ(秘密情報ではない)。
const testBindings = {
  BACKLOG_SPACE_HOST: "example.backlog.com",
  PUBLIC_BASE_URL: "https://logbutler.test",
  BACKLOG_CLIENT_ID: "test-backlog-client-id",
  BACKLOG_CLIENT_SECRET: "test-backlog-client-secret",
};

function project(name: string, include: string) {
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: testBindings },
      }),
    ],
    test: { name, include: [include] },
  };
}

// verify:oauth のループバック受信(node:http)は workerd では動かないので、Node 環境のプロジェクトで実機の HTTP を確かめる。
const nodeProject = {
  test: { name: "node", environment: "node", include: ["test/node/**/*.test.ts"] },
};

// 生成スクリプトなどを実プロセスとして起動する E2E。workerd ではなく Node 環境で動かす。
const nodeE2eProject = {
  test: { name: "node-e2e", environment: "node", include: ["test/node-e2e/**/*.test.ts"] },
};

export default defineConfig({
  test: {
    projects: [
      project("unit", "test/unit/**/*.test.ts"),
      project("e2e", "test/e2e/**/*.test.ts"),
      nodeProject,
      nodeE2eProject,
    ],
  },
});
