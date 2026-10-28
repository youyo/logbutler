/**
 * live テストが Backlog に作る名前が、実測した長さ上限に収まっていること(live 自体は実 Backlog なので走らせない)。
 * 上限の出典は test/live/helpers/live.ts の NAME_LIMITS(2026-10-29 実測)。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAME_LIMITS, NAME_MARK } from "../live/helpers/live";

describe("live の作成物の名前", () => {
  it("NAME_MARK は lv + HHMMSS の 8 文字", () => {
    expect(NAME_MARK).toMatch(/^lv\d{6}$/);
  });

  it("NAME_MARK で作る名前は、種別ごとの上限(状態 20・カテゴリー/バージョン 40)に収まる", () => {
    for (const file of ["suites/project-settings.ts", "suites/analysis.ts"]) {
      const src = readFileSync(new URL(`../live/${file}`, import.meta.url), "utf8");
      const names = [...src.matchAll(/name: `\$\{NAME_MARK\} ([^`]*)`/g)];
      expect(names.length, file).toBeGreaterThan(0);
      for (const m of names) {
        const length = NAME_MARK.length + 1 + [...(m[1] ?? "")].length;
        const line = src.slice(0, m.index).split("\n").length;
        const ctx = src
          .split("\n")
          .slice(Math.max(0, line - 6), line)
          .join("\n");
        const limit = /status_add|status_update/.test(ctx)
          ? NAME_LIMITS.status
          : NAME_LIMITS.category;
        expect(length, `${file}:${line} ${m[0]}`).toBeLessThanOrEqual(limit);
      }
    }
  });
});
