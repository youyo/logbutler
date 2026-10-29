import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// テスト専用の束縛。実在しないダミー値のみ(秘密情報ではない)。
const testBindings = {
  BACKLOG_SPACE_HOST: "example.backlog.com",
  PUBLIC_BASE_URL: "https://logbutler.test",
  BACKLOG_CLIENT_ID: "test-backlog-client-id",
  BACKLOG_CLIENT_SECRET: "test-backlog-client-secret",
};

// workerd のテストは、各ファイルの最初のテストで Worker の起動とモジュールの読み込みが走る。
// ファイルを並列に流すと、その起動が CPU を取り合い、手元(18 コア)でも最初のテストが約 4.7 秒、
// CPU の少ない CI(GitHub Actions ubuntu-latest。unit と e2e が同時に走る)では 5 秒の既定を超える。
// 起動コストの揺れを吸収するための余裕で、個々のテストの重さの許容ではない(通常は各テスト 1 秒未満)。
const WORKERD_TEST_TIMEOUT_MS = 30_000;

function project(name: string, include: string) {
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: testBindings },
      }),
    ],
    test: {
      name,
      include: [include],
      testTimeout: WORKERD_TEST_TIMEOUT_MS,
      hookTimeout: WORKERD_TEST_TIMEOUT_MS,
    },
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

// 実環境(デプロイ済み Worker + 実 Backlog)の E2E。`mise run test` には含めない(`mise run test:live` だけが実行する)。
const liveProject = {
  test: {
    name: "live",
    environment: "node",
    include: ["test/live/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
};

export default defineConfig({
  test: {
    projects: [
      project("unit", "test/unit/**/*.test.ts"),
      project("e2e", "test/e2e/**/*.test.ts"),
      nodeProject,
      nodeE2eProject,
      liveProject,
    ],
  },
});
