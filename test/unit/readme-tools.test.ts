import { describe, expect, it } from "vitest";
import readme from "../../README.md?raw";
import { ALL_TOOLS } from "../../src/mcp/tools";

/** README のツール一覧(toolset ごとの表)が、実際に登録されているツールと一致していること。 */
describe("README のツール一覧", () => {
  const byToolset = new Map<string, string[]>();
  for (const tool of ALL_TOOLS) {
    const list = byToolset.get(tool.toolset) ?? [];
    list.push(tool.name.replace(/^logbutler_/, ""));
    byToolset.set(tool.toolset, list);
  }

  it("総数が本文に書かれている", () => {
    expect(readme).toContain(`${ALL_TOOLS.length} 個`);
  });

  it.each([...byToolset])("toolset %s の行に、件数と全ツール名がある", (toolset, names) => {
    const row = readme.split("\n").find((l) => l.startsWith(`| \`${toolset}\` |`));
    expect(row, `README に toolset ${toolset} の行がない`).toBeDefined();
    const cells = (row ?? "").split("|").map((c) => c.trim());
    expect(cells[2]).toBe(String(names.length));
    for (const name of names) expect(row).toContain(`\`${name}\``);
  });

  it("表に載っているツール名が、実在しないものを含まない", () => {
    const real = new Set(ALL_TOOLS.map((t) => t.name.replace(/^logbutler_/, "")));
    const rows = readme.split("\n").filter((l) => /^\| `[a-z_]+` \| \d+ \|/.test(l));
    expect(rows.length).toBe(byToolset.size);
    for (const row of rows) {
      const cell = row.split("|")[3] ?? "";
      for (const m of cell.matchAll(/`([a-z_0-9]+)`/g)) {
        expect(real.has(m[1] as string), `README の ${m[1]} は登録されていない`).toBe(true);
      }
    }
  });
});
