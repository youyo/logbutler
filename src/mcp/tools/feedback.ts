import { z } from "zod";
import { buildFeedbackGuide, FEEDBACK_DESCRIPTION, FEEDBACK_KINDS } from "../../feedback/guide";
import { defineTool } from "../registry";

// feedback ツール(ADR 0019)。上流の公開リポジトリ youyo/logbutler に issue を起票するための案内を返す。
// issue は作らず、Backlog にも GitHub にも通信しない。応答は kind だけで決まり、ctx は使わない。

export const feedback = defineTool({
  name: "logbutler_feedback",
  title: "フィードバック（GitHub issue の起票案内）",
  // 開始条件・中止条件・承認の固定文を含む(src/feedback/guide.ts。steps と同じ文言)
  description: FEEDBACK_DESCRIPTION,
  category: "ReadOnly",
  openWorldHint: false,
  toolset: "feedback",
  // Backlog を呼ばない(呼べば上限超過のエラーになる)
  maxApiCalls: 0,
  // 応答は数 KB の固定の案内。max_response_tokens は付けない(入力は kind だけ。ADR 0019)
  responseLimit: false,
  inputSchema: z.object({
    kind: z
      .enum(FEEDBACK_KINDS)
      .describe("Type of feedback: bug, feature, question or other (default: bug)")
      .optional(),
  }),
  handler: async ({ kind }) => buildFeedbackGuide(kind ?? "bug"),
});
