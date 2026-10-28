import type { ToolDefinition } from "../registry";
import { userMe } from "./user-me";

/** 公開するツールの一覧。M03 以降のツールはここに足す。 */
export const ALL_TOOLS: readonly ToolDefinition[] = [userMe];
