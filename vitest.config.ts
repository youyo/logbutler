import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// テスト専用の束縛。実在しないダミー値のみ(秘密情報ではない)。
const testBindings = {
  BACKLOG_SPACE_HOST: "example.backlog.com",
  ACCESS_TEAM_DOMAIN: "logbutler-test.cloudflareaccess.com",
  ACCESS_AUD: "test-access-aud",
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

export default defineConfig({
  test: {
    projects: [project("unit", "test/unit/**/*.test.ts"), project("e2e", "test/e2e/**/*.test.ts")],
  },
});
