import { ArgumentError } from "../errors";
import { parseCsvStrings } from "../mcp/args";
import { MAX_PROJECT_KEYS } from "./budget";

/** `project_keys`(CSV)。空は argument_error、重複は 1 つにまとめる、上限は MAX_PROJECT_KEYS。 */
export function parseProjectKeys(csv: string): string[] {
  const keys = [...new Set(parseCsvStrings(csv))];
  if (keys.length === 0) throw new ArgumentError("project_keys is required");
  if (keys.length > MAX_PROJECT_KEYS) {
    throw new ArgumentError(
      `project_keys accepts at most ${MAX_PROJECT_KEYS} projects per call, got ${keys.length}`,
    );
  }
  return keys;
}
