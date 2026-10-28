/** space_digest(logvalet `internal/digest/space.go`)。 */
import type { ToolContext } from "../mcp/registry";
import { digestEnvelope, llmHints, type Warning, warningFromError } from "./envelope";

interface BacklogSpace {
  spaceKey?: string;
  name?: string;
  ownerId?: number;
  lang?: string;
  timezone?: string;
  textFormattingRule?: string;
}

/** Backlog の生データ(camelCase)のまま `disk_usage` に載せる。 */
interface DiskUsage {
  capacity?: number;
  issue?: number;
  wiki?: number;
  file?: number;
  subversion?: number;
  git?: number;
  gitLFS?: number;
}

export async function buildSpaceDigest(ctx: ToolContext) {
  // スペース情報は必須(失敗はツールエラー)。ディスク使用量は任意(失敗は warning)。
  const space = await ctx.client.request<BacklogSpace>("GET", "/space");
  const warnings: Warning[] = [];
  let disk: DiskUsage | undefined;
  try {
    disk = await ctx.client.request<DiskUsage>("GET", "/space/diskUsage");
  } catch (e) {
    warnings.push(
      warningFromError(e, "disk_usage_fetch_failed", "failed to get disk usage", "disk_usage"),
    );
  }

  const spaceKey = space.spaceKey ?? "";
  const name = space.name ?? "";
  // Go の omitempty と同じく、0 の容量・使用量は出さない。
  const used = disk
    ? (disk.issue ?? 0) +
      (disk.wiki ?? 0) +
      (disk.file ?? 0) +
      (disk.subversion ?? 0) +
      (disk.git ?? 0) +
      (disk.gitLFS ?? 0)
    : 0;
  return digestEnvelope(
    ctx,
    "space",
    {
      space: {
        space_key: spaceKey,
        name,
        owner_id: space.ownerId ?? 0,
        lang: space.lang ?? "",
        timezone: space.timezone ?? "",
        text_formatting_rule: space.textFormattingRule ?? "",
      },
      ...(disk ? { disk_usage: disk } : {}),
      summary: {
        headline: `スペース ${name}（${spaceKey}）`,
        has_disk_usage: disk !== undefined,
        ...(disk?.capacity ? { capacity_bytes: disk.capacity } : {}),
        ...(used ? { used_bytes: used } : {}),
      },
      llm_hints: llmHints([spaceKey, name]),
    },
    warnings,
  );
}
